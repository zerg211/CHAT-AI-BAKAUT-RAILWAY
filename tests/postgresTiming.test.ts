import {describe, expect, it} from 'vitest';
import {instrumentPostgresPool} from '../src/observability/postgresTiming.js';
import {runWithTurnTiming, type TimingLog} from '../src/observability/turnTiming.js';

describe('PostgreSQL timing boundary', () => {
  it('restores the calling turn when a pooled callback completes in another async context', async () => {
    const logs: TimingLog[]=[];
    const callbacks: Array<() => void>=[];
    const client={query(_text: string,callback: (error: null)=>void) {callbacks.push(()=>callback(null));}};
    let connect: (client: any)=>void=()=>{};
    const pool={on(_event:'connect',listener:(c:any)=>void){connect=listener;},
      connect(callback: (error:null,c:typeof client)=>void){callbacks.push(()=>callback(null,client));}};
    instrumentPostgresPool(pool);connect(client);
    const turns=['one','two'].map(turnId=>runWithTurnTiming({sessionId:'s',turnId},()=>new Promise<void>(resolve=>{
      pool.connect((_error,c)=>c.query('private query',()=>resolve()));
    }),event=>logs.push(event)));
    while(callbacks.length) callbacks.pop()!();
    await Promise.all(turns);
    for(const turnId of ['one','two']) {
      const events=logs.filter(event=>event.turnId===turnId);
      expect(events.at(-1)).toMatchObject({counts:{pool_wait:1,database:1},activeSpans:0});
    }
  });

  it('preserves promise and callback contracts on reused connections without logging SQL', async () => {
    const logs: TimingLog[]=[];
    let connected: (client: any) => void = () => {};
    const result={rows:[{value:'private row'}]};
    const failure=new Error('private database error');
    const client={query(...args: any[]) {
      const callback=args.at(-1);
      const error=args[0]==='failing private SQL' ? failure : null;
      if (typeof callback==='function') { queueMicrotask(()=>callback(error,result)); return undefined; }
      return error ? Promise.reject(error) : Promise.resolve(result);
    }};
    const pool={on(_event: 'connect', callback: (c: any)=>void) {connected=callback;},
      connect(callback?: (error: unknown, c: typeof client, release: ()=>void)=>void) {
        connected(client);
        if(callback) {queueMicrotask(()=>callback(null,client,()=>{})); return undefined;}
        return Promise.resolve(client);
      }};
    instrumentPostgresPool(pool);
    for(const turnId of ['first','second']) {
      await runWithTurnTiming({sessionId:'s',turnId},async()=>{
        const connection=await pool.connect();
        expect(await connection!.query('private SQL',['private parameter'])).toBe(result);
        await expect(connection!.query('failing private SQL')).rejects.toBe(failure);
        await new Promise<void>((resolve,reject)=>pool.connect((error,c,release)=>{
          if(error) return reject(error);
          expect(typeof release).toBe('function');
          const returned=c.query('private callback SQL',(queryError:unknown,rows:unknown)=>{
            if(queryError) return reject(queryError);
            expect(rows).toBe(result); release(); resolve();
          });
          expect(returned).toBeUndefined();
        }));
      },event=>logs.push(event));
      const events=logs.filter(event=>event.turnId===turnId);
      expect(events.at(-1)).toMatchObject({counts:{pool_wait:2,database:3},activeSpans:0});
      expect(events.filter(event=>event.kind==='database'&&event.outcome==='error')).toHaveLength(1);
    }
    expect(JSON.stringify(logs)).not.toContain('private');
  });

  it('preserves synchronous failures, callback errors and query streams', async()=>{
    const logs: TimingLog[]=[];
    const failure=new Error('same error');
    const stream={submit() {}};
    let connect: (client: any)=>void=()=>{};
    const client={query(value:unknown,callback?: (error:unknown)=>void) {
      if(value===stream) return stream;
      if(callback) { callback(failure); return; }
      throw failure;
    }};
    const pool={on(_event:'connect',listener:(c:any)=>void){connect=listener;},connect(){throw failure;}};
    instrumentPostgresPool(pool);connect(client);
    await runWithTurnTiming({sessionId:'s',turnId:'t'},async()=>{
      expect(()=>pool.connect()).toThrow(failure);
      expect(()=>client.query('query')).toThrow(failure);
      client.query('query',error=>expect(error).toBe(failure));
      expect(client.query(stream)).toBe(stream);
    },event=>logs.push(event));
    expect(logs.at(-1)).toMatchObject({counts:{pool_wait:1,database:2},activeSpans:0});
    expect(logs.filter(event=>event.type==='span').every(event=>event.outcome==='error')).toBe(true);
  });
});
