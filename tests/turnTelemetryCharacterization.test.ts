import {afterEach,describe,expect,it,vi} from 'vitest';
import {AgentManagerOrchestrator} from '../src/ai/agentManagerOrchestrator';
import {recordTurnTelemetry,runWithTurnStageEmitter} from '../src/ai/turnTelemetry';
afterEach(()=>vi.restoreAllMocks());
describe('orchestrator telemetry characterization',()=>{
  it('keeps concurrent stage streams isolated and continues tracing after a broken stream',async()=>{
    vi.spyOn(console,'warn').mockImplementation(()=>{});
    const repo={appendTurnEvent:vi.fn(async()=>{}),addAgentTrace:vi.fn(async()=>{})};
    const one=vi.fn(async()=>{throw new Error('disconnected');}),two=vi.fn();
    await Promise.all([
      runWithTurnStageEmitter(one,async()=>{await Promise.resolve();await recordTurnTelemetry(repo as never,'s1','t1','planning','one',{});}),
      runWithTurnStageEmitter(two,async()=>{await Promise.resolve();await recordTurnTelemetry(repo as never,'s2','t2','writing','two',{});})
    ]);
    expect(one).toHaveBeenCalledExactlyOnceWith({phase:'planning',eventType:'one'});
    expect(two).toHaveBeenCalledExactlyOnceWith({phase:'writing',eventType:'two'});
    expect(repo.addAgentTrace).toHaveBeenCalledTimes(2);
  });
  it.each([false,true])('retains empty durable payload and private trace even if durable event fails: %s',async fail=>{
    vi.spyOn(console,'warn').mockImplementation(()=>{});
    const order:string[]=[];
    const repo={appendTurnEvent:vi.fn(async input=>{order.push('event');if(fail)throw new Error('storage failure');return input;}),
      addAgentTrace:vi.fn(async()=>{order.push('trace');})};
    const orchestrator=new AgentManagerOrchestrator(repo as never);
    const access=orchestrator as unknown as {trace:(s:string,t:string,p:string,e:string,payload:Record<string,unknown>)=>Promise<void>};
    await access.trace('session','turn','tools','tool_completed',{internal:'private fact evidence'});
    expect(order).toEqual(['event','trace']);
    expect(repo.appendTurnEvent).toHaveBeenCalledWith({sessionId:'session',turnId:'turn',stage:'tools',eventType:'tool_completed',payload:{}});
    expect(repo.addAgentTrace).toHaveBeenCalledWith(expect.objectContaining({redacted:true,payload:{internal:'private fact evidence'}}));
  });
});
