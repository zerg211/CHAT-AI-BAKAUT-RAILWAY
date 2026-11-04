import { diagnosticEvent, safeErrorFields, hasDiagnosticContext, bindDiagnosticCallback } from './diagnostics.js';
import { startTimingSpan, type TimingKind } from './turnTiming.js';

function databaseEvent(name: string, fields: Record<string, unknown>) {
  if (hasDiagnosticContext()) diagnosticEvent(name,fields);
}

// pg exposes both callback and promise overloads. Wrap completion, not query
// text/arguments. Instrumentation reads the current turn context on each call,
// so a reused pooled connection never retains its previous customer's identity.
function measuredMethod(target: any, method: 'query' | 'connect', kind: TimingKind) {
  const original = target[method];
  target[method] = function (...args: any[]) {
    // Submittable query streams have a separate lifecycle and are not used by
    // the repositories. Leave their return/event contract completely untouched.
    if (method === 'query' && typeof args[0]?.submit === 'function') return original.apply(this, args);
    const span = startTimingSpan(kind, `postgres.${method}`);
    if (method === 'connect') databaseEvent('database.pool.observed',{totalCount:this.totalCount,idleCount:this.idleCount,waitingCount:this.waitingCount});
    const lastIndex = args.length - 1;
    const callback = args[lastIndex];
    try {
      if (typeof callback === 'function') {
        args[lastIndex] = bindDiagnosticCallback(function (this: unknown, error: unknown, ...values: unknown[]) {
          span.finish(error ? 'error' : 'ok');
          databaseEvent('database.operation.complete',{operation:`postgres.${method}`,outcome:error?'error':'ok',...(error?safeErrorFields(error):{}),rowCount:(values[0] as {rowCount?:number})?.rowCount});
          return span.run(() => callback.call(this, error, ...values));
        });
        return original.apply(this, args);
      }
      const result = original.apply(this, args);
      if (!result || typeof result.then !== 'function') { span.finish('ok'); return result; }
      return result.then((value: unknown) => { span.finish('ok'); databaseEvent('database.operation.complete',{operation:`postgres.${method}`,outcome:'ok',rowCount:(value as {rowCount?:number})?.rowCount}); return value; },
        (error: unknown) => { span.finish('error'); databaseEvent('database.operation.failed',{operation:`postgres.${method}`,...safeErrorFields(error)}); throw error; });
    } catch (error) { span.finish('error'); databaseEvent('database.operation.failed',{operation:`postgres.${method}`,...safeErrorFields(error)}); throw error; }
  };
}

export function instrumentPostgresPool(pool: { connect: unknown; on: (event: 'connect', listener: (client: any) => void) => unknown }) {
  const instrumentedClients = new WeakSet<object>();
  measuredMethod(pool, 'connect', 'pool_wait');
  pool.on('connect', client => {
    if (instrumentedClients.has(client)) return;
    instrumentedClients.add(client);
    measuredMethod(client, 'query', 'database');
  });
}
