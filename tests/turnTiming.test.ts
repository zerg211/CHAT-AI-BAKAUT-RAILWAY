import {describe, expect, it} from 'vitest';
import {providerUsageFields, recordTimingStage, runWithTurnTiming, startTimingSpan,
  timeOperation, withTimingStage, type TimingLog} from '../src/observability/turnTiming.js';

describe('turn timing diagnostics', () => {
  it('isolates concurrent turns and records provider parents and actual usage', async () => {
    const logs: TimingLog[] = [];
    const releases: Array<() => void> = [];
    const calls = ['one', 'two'].map(turnId => runWithTurnTiming({sessionId:'session-'+turnId, turnId},
      () => withTimingStage('planner', () => timeOperation('model', 'planner', async () => {
        const span = startTimingSpan('provider', 'responses.create', {model:'gpt-5.6-luna'});
        await new Promise<void>(resolve => releases.push(resolve));
        span.finish('ok', providerUsageFields({usage:{input_tokens:80, output_tokens:20, total_tokens:100,
          input_tokens_details:{cached_tokens:40},output_tokens_details:{reasoning_tokens:10}}}));
        span.finish('error');
        return turnId;
      })), event => logs.push(event)));
    releases.reverse().forEach(release => release());
    expect(await Promise.all(calls)).toEqual(['one', 'two']);
    for (const turnId of ['one','two']) {
      const events = logs.filter(event => event.turnId === turnId);
      const provider = events.find(event => event.kind === 'provider')!;
      const model = events.find(event => event.kind === 'model')!;
      expect(provider).toMatchObject({sessionId:'session-'+turnId, stage:'planner',parentSpanId:model.spanId,
        outcome:'ok',inputTokens:80,outputTokens:20,cachedInputTokens:40,reasoningTokens:10});
      expect(events.filter(event => event.kind === 'provider')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({type:'complete',outcome:'ok',activeSpans:0,counts:{model:1,provider:1}});
    }
    expect(new Set(logs.map(event => event.executionId)).size).toBe(2);
  });

  it('preserves exceptions without logging their content or private stage payloads', async () => {
    const logs: TimingLog[] = [];
    const error = new Error('secret credential and buyer phone');
    await expect(runWithTurnTiming({sessionId:'s',turnId:'t'}, async () => {
      recordTimingStage('tools','tool_completed',{tool:'catalog.search',durationMs:12,
        query:'private buyer text',payload:{secret:'never log'},errorCode:'private error'});
      await timeOperation('provider','responses.create',async () => { throw error; });
    }, event=>logs.push(event))).rejects.toBe(error);
    expect(logs.at(-1)).toMatchObject({type:'complete',outcome:'error',activeSpans:0});
    expect(logs.find(event=>event.kind==='provider')).toMatchObject({outcome:'error'});
    const serialized = JSON.stringify(logs);
    for (const privateValue of ['secret credential','buyer phone','private buyer text','never log','private error']) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('does not let a failed sink alter success or mask the original failure', async () => {
    const brokenSink = () => { throw new Error('log transport failed'); };
    await expect(runWithTurnTiming({sessionId:'s',turnId:'t'},async () =>
      timeOperation('database','query',async () => 42),brokenSink)).resolves.toBe(42);
    const original = new Error('original');
    await expect(runWithTurnTiming({sessionId:'s',turnId:'t'},async () => {
      throw original;
    },brokenSink)).rejects.toBe(original);
  });

  it('bounds logs while retaining aggregate counts and outstanding work', async () => {
    const logs: TimingLog[]=[];
    await runWithTurnTiming({sessionId:'s',turnId:'t'},async () => {
      for (let i=0;i<450;i++) startTimingSpan('database','query').finish('ok');
      startTimingSpan('provider','still_in_flight');
    },event=>logs.push(event));
    expect(logs.length).toBeLessThanOrEqual(401);
    expect(logs.at(-1)).toMatchObject({type:'complete',counts:{database:450,provider:1},activeSpans:1});
    expect(Number(logs.at(-1)?.droppedEvents)).toBeGreaterThan(0);
  });

  it('keeps missing usage unknown and excludes untrusted metadata', () => {
    expect(providerUsageFields({usage:{input_tokens:NaN,output_tokens:-1,total_tokens:'100',secret:'hidden'}})).toEqual({});
    expect(providerUsageFields({usage:{prompt_tokens:15,total_tokens:15}})).toEqual({inputTokens:15,totalTokens:15});
    expect(providerUsageFields(null)).toEqual({});
  });
});
