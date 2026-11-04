import pg from 'pg';
import { type DiagnosticEvent, setDiagnosticSink, projectDiagnosticEnvelope } from './diagnostics.js';

type Database = { query: (sql: string, values?: unknown[]) => Promise<unknown> };
/** A bounded, isolated, idempotent writer. Never uses the instrumented business pool. */
export class DiagnosticJournal {
  private queue: DiagnosticEvent[] = [];
  private inFlight: Promise<void> | undefined;
  private stopped = false;
  private nextAttempt = 0;
  private lastHealth = 0;
  readonly stats = { accepted:0, persisted:0, dropped:0, storageFailures:0, queueDepth:0, retentionBacklog:false };
  constructor(private readonly database: Database, private readonly capacity = 5000,
    private readonly report: (event: Record<string, unknown>) => void = event => console.warn(JSON.stringify(event))) {}
  private health(name: string) {
    if (Date.now() - this.lastHealth < 10_000) return;
    this.lastHealth = Date.now();
    try { this.report({event:'diagnostic_health',schemaVersion:1,name,timestamp:new Date().toISOString(),...this.stats}); } catch { /* No recursion. */ }
  }
  enqueue = (input: DiagnosticEvent) => {
    const event=projectDiagnosticEnvelope(input);
    if (!event) {this.stats.dropped++;this.health('telemetry.schema.rejected');return;}
    const critical = ['timing.complete','request.complete','request.rejected','answer.ready'].includes(String(event.name)) || String(event.name).endsWith('.failed');
    const limit = this.capacity + (critical ? 100 : 0);
    if (this.stopped || this.queue.length >= limit) { this.stats.dropped++; this.health('telemetry.queue.overflow'); return; }
    this.queue.push(event); this.stats.accepted++; this.stats.queueDepth = this.queue.length;
  };
  flush(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!this.queue.length || (!force && Date.now() < this.nextAttempt)) return Promise.resolve();
    const batch = this.queue.slice(0, 100);
    this.inFlight = this.database.query(`INSERT INTO diagnostic_events(event_id, occurred_at, execution_id, request_id, turn_id, event_seq, payload)
      SELECT (e->>'eventId')::uuid, (e->>'timestamp')::timestamptz, e->>'executionId', e->>'requestId', e->>'turnId', (e->>'eventSeq')::bigint, e
      FROM jsonb_array_elements($1::jsonb) e ON CONFLICT(event_id) DO NOTHING`,[JSON.stringify(batch)])
      .then(() => { this.queue.splice(0,batch.length); this.stats.persisted+=batch.length; this.stats.queueDepth=this.queue.length; this.nextAttempt=0; })
      .catch(() => { this.stats.storageFailures++; this.nextAttempt=Date.now()+2000; this.health('telemetry.storage.failed'); })
      .finally(() => { this.inFlight=undefined; });
    return this.inFlight;
  }
  async stop() {
    this.stopped = true;
    // Shutdown is bounded by dedicated pool query timeout; never delay indefinitely.
    const deadline=Date.now()+1500;
    do {
      const before=this.queue.length;await this.flush(true);
      if (this.queue.length >= before) break;
    } while (this.queue.length && Date.now()<deadline);
    if (this.queue.length) { this.lastHealth=0; this.health('telemetry.shutdown.incomplete'); }
  }
}

let active: DiagnosticJournal | undefined;
export function diagnosticJournalHealth() { return active ? {...active.stats} : {enabled:false}; }
export function startDiagnosticJournal(connectionString: string) {
  const db = new pg.Pool({connectionString,max:1,connectionTimeoutMillis:1000,idleTimeoutMillis:10000,query_timeout:2000,statement_timeout:1500});
  db.on('error',() => { console.warn(JSON.stringify({event:'diagnostic_health',name:'telemetry.connection.failed',timestamp:new Date().toISOString()})); });
  const journal = new DiagnosticJournal(db); active=journal; setDiagnosticSink(journal.enqueue);
  const timer = setInterval(() => void journal.flush(),250).unref();
  // Only this new technical table is pruned. Business records/checkpoints remain untouched.
  const retentionDays = Math.min(30,Math.max(1,Number(process.env.DIAGNOSTIC_RETENTION_DAYS) || 7));
  let retentionInFlight: Promise<void> | undefined;
  const retention = setInterval(() => {
    if (retentionInFlight) return;
    retentionInFlight = (async () => {
      const started = Date.now();
      for (let batch = 0; batch < 10; batch++) {
        const result = await db.query(`DELETE FROM diagnostic_events WHERE id IN (SELECT id FROM diagnostic_events
          WHERE occurred_at < now() - ($1::int * interval '1 day') ORDER BY id LIMIT 10000)`,[retentionDays]);
        journal.stats.retentionBacklog = (result.rowCount ?? 0) === 10000;
        if (!journal.stats.retentionBacklog || Date.now()-started >= 5000) break;
        await new Promise(resolve => setTimeout(resolve,10));
      }
    })().catch(() => {
      journal.stats.retentionBacklog=true;
      console.warn(JSON.stringify({event:'diagnostic_health',name:'telemetry.retention.failed',timestamp:new Date().toISOString()}));
    }).finally(() => {retentionInFlight=undefined;});
  },60_000).unref();
  return async () => { clearInterval(timer);clearInterval(retention);setDiagnosticSink(undefined); await retentionInFlight;await journal.stop();await db.end();active=undefined; };
}
