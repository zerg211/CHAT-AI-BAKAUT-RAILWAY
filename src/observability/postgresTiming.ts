import { startTimingSpan, type TimingKind } from './turnTiming.js';

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
    const lastIndex = args.length - 1;
    const callback = args[lastIndex];
    try {
      if (typeof callback === 'function') {
        args[lastIndex] = function (this: unknown, error: unknown, ...values: unknown[]) {
          span.finish(error ? 'error' : 'ok');
          return span.run(() => callback.call(this, error, ...values));
        };
        return original.apply(this, args);
      }
      const result = original.apply(this, args);
      if (!result || typeof result.then !== 'function') { span.finish('ok'); return result; }
      return result.then((value: unknown) => { span.finish('ok'); return value; },
        (error: unknown) => { span.finish('error'); throw error; });
    } catch (error) { span.finish('error'); throw error; }
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
