import { describe,it,expect,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { diagnosticCompleteness, diagnosticError, diagnosticEvent, diagnosticSpan, projectDiagnosticFields, runWithDiagnostics, safeErrorFields, type DiagnosticEvent } from '../src/observability/diagnostics.js';
import { instrumentPostgresPool } from '../src/observability/postgresTiming.js';
import { DiagnosticJournal } from '../src/observability/diagnosticJournal.js';

const identity = () => ({requestId:randomUUID(),turnId:randomUUID(),sessionId:randomUUID()});
describe('safe diagnostics',() => {
  it('has sequential concurrent nested spans and isolates executions',async () => {
    const all: DiagnosticEvent[]=[];
    const ids=[identity(),identity()];
    await Promise.all(ids.map(id=>runWithDiagnostics(id,async () => {
      await diagnosticSpan('outer',async () => {
        await Promise.all([1,2].map(async () => diagnosticSpan('inner',async () => {await Promise.resolve();diagnosticEvent('work');})));
      });
      diagnosticEvent('request.complete',diagnosticCompleteness());
    },e=>all.push(e))));
    for (const id of ids) {
      const events=all.filter(e=>e.turnId===id.turnId);
      expect(events.map(e=>e.eventSeq)).toEqual(events.map((_,i)=>i+1));
      expect(new Set(events.map(e=>e.executionId)).size).toBe(1);
      const start=events.find(e=>e.name==='outer.started')!;
      expect(events.filter(e=>e.name==='inner.started').every(e=>e.parentSpanId===start.spanId)).toBe(true);
      expect(events.at(-1)).toMatchObject({activeSpans:0,droppedEvents:0,sinkFailures:0});
    }
  });
  it('strictly excludes content and arbitrary error fields',() => {
    const canary='sk-private_secret_canary';
    const output=projectDiagnosticFields({message:canary,authorization:canary,body:canary,url:canary,tool:canary,errorCode:canary,errorType:canary,model:canary,providerRequestId:canary,sessionId:canary,statusCode:429,rowCount:0});
    expect(output).toMatchObject({errorCode:'unknown',tool:'unknown',statusCode:429,rowCount:0});
    expect(JSON.stringify(output)).not.toContain(canary);
    expect(JSON.stringify(safeErrorFields(Object.assign(new Error(canary),{code:canary,detail:canary,cause:new Error(canary)})))).not.toContain(canary);
    expect(safeErrorFields(Object.assign(new Error(canary),{code:'40P01'}))).toMatchObject({sqlState:'40P01'});
  });
  it('retains primary errors, reports telemetry loss and bounds normal events',async () => {
    const logs:DiagnosticEvent[]=[];const error=new Error('secret');
    await expect(runWithDiagnostics(identity(),async()=>{
      for(let i=0;i<20_005;i++) diagnosticEvent('work');
      await diagnosticSpan('operation',async()=>{throw error;});
    },e=>logs.push(e))).rejects.toBe(error);
    expect(logs.length).toBeLessThanOrEqual(20_002);
    expect(logs.at(-1)?.name).toBe('operation.failed');
    const failures:DiagnosticEvent[]=[];
    await runWithDiagnostics(identity(),async()=>{
      diagnosticEvent('a');diagnosticEvent('request.complete',diagnosticCompleteness());
    },e=>{failures.push(e);throw new Error('sink_secret');});
    expect(failures.at(-1)?.sinkFailures).toBe(1);
  });
  it('captures caller diagnostic context for reused postgres callback completion',() => {
    let connect:(client:unknown)=>void=()=>{};let callback: (error:unknown,result:unknown)=>void=()=>{};
    const client={query:(_sql:unknown,cb:typeof callback)=>{callback=cb;}};
    instrumentPostgresPool({connect:()=>{},on:(_event,listener)=>{connect=listener;}});connect(client);
    const logsA:DiagnosticEvent[]=[];const logsB:DiagnosticEvent[]=[];
    const a=identity();
    runWithDiagnostics(a,()=>client.query('PRIVATE SQL',(error,result)=>{expect(error).toBe(null);expect(result).toEqual({rowCount:1});}),e=>logsA.push(e));
    runWithDiagnostics(identity(),()=>callback(null,{rowCount:1}),e=>logsB.push(e));
    expect(logsA.find(e=>e.name==='database.operation.complete')).toMatchObject({requestId:a.requestId,rowCount:1});
    expect(logsB).toEqual([]);
  });
  it('does not allow fields to overwrite event envelope names',() => {
    const logs:DiagnosticEvent[]=[];runWithDiagnostics(identity(),()=>diagnosticEvent('timing.span.complete',{name:'postgres.query'}),e=>logs.push(e));
    expect(logs[0].name).toBe('timing.span.complete');
  });
});
describe('durable diagnostic writer',() => {
  it('projects every storage enqueue and reserves bounded terminal capacity',async()=>{
    const query=vi.fn().mockResolvedValue({rowCount:2});const writer=new DiagnosticJournal({query},1);
    const events:DiagnosticEvent[]=[];runWithDiagnostics(identity(),()=>{diagnosticEvent('work');diagnosticEvent('request.complete');},e=>events.push(e));
    writer.enqueue({...events[0],secret:'PRIVATE_SECRET',body:'PRIVATE_BODY'});
    writer.enqueue(events[1]);
    expect(writer.stats.queueDepth).toBe(2);
    await writer.flush(true);
    expect(JSON.stringify(query.mock.calls)).not.toContain('PRIVATE');
    writer.enqueue({eventId:'invalid',name:'bad'});expect(writer.stats.dropped).toBe(1);
  });

  it('keeps failed batch, retries idempotently, and makes overflow visible',async () => {
    const query=vi.fn().mockRejectedValueOnce(new Error('secret database URI')).mockResolvedValue({rowCount:1});
    const health:Record<string,unknown>[]=[];const writer=new DiagnosticJournal({query},1,e=>health.push(e));
    const events:DiagnosticEvent[]=[];runWithDiagnostics(identity(),()=>diagnosticEvent('work'),e=>events.push(e));
    writer.enqueue(events[0]);writer.enqueue(events[0]);await writer.flush(true);
    expect(writer.stats).toMatchObject({dropped:1,storageFailures:1,queueDepth:1,persisted:0});
    await writer.flush(true);expect(writer.stats).toMatchObject({queueDepth:0,persisted:1});
    expect(query.mock.calls[0][1]).toEqual(query.mock.calls[1][1]);
    expect(query.mock.calls[1][0]).toContain('ON CONFLICT(event_id) DO NOTHING');
    expect(JSON.stringify(health)).not.toContain('secret');
  });
  it('does not duplicate concurrent flushes and bounds shutdown',async()=>{
    let resolve:()=>void=()=>{};const query=vi.fn(()=>new Promise<void>(r=>{resolve=r;}));
    const writer=new DiagnosticJournal({query});const events:DiagnosticEvent[]=[];
    runWithDiagnostics(identity(),()=>diagnosticEvent('work'),e=>events.push(e));writer.enqueue(events[0]);
    const a=writer.flush(true);const b=writer.flush(true);expect(a).toBe(b);expect(query).toHaveBeenCalledTimes(1);resolve();await a;await writer.stop();
    writer.enqueue(events[0]);expect(writer.stats.dropped).toBe(1);
  });
});
