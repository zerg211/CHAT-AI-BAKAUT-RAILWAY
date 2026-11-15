import {afterEach,describe,expect,it,vi} from 'vitest';
import {createAnswerDeliveryMetric} from '../src/client/answerDeliveryMetric';
afterEach(()=>vi.unstubAllGlobals());
function setup(){
  const frames:Array<()=>void>=[];
  const document=Object.assign(new EventTarget(),{visibilityState:'visible'});
  vi.stubGlobal('document',document);
  vi.stubGlobal('performance',{now:()=>1200});
  let nextId=0;const callbacks=new Map<number,()=>void>();
  vi.stubGlobal('requestAnimationFrame',(callback:()=>void)=>{
    const id=++nextId;const run=()=>{callbacks.delete(id);callback();};callbacks.set(id,run);frames.push(run);return id;
  });
  vi.stubGlobal('cancelAnimationFrame',(id:number)=>{
    const index=frames.indexOf(callbacks.get(id)!);if(index>=0)frames.splice(index,1);callbacks.delete(id);
  });
  const fetch=vi.fn().mockResolvedValue({ok:true});vi.stubGlobal('fetch',fetch);
  return {frames,document,fetch};
}
describe('visible answer delivery measurement',()=>{
  it('retries after hidden frames when the finished answer becomes visible without another delta',async()=>{
    const {frames,document,fetch}=setup();const metric=createAnswerDeliveryMetric(200);
    metric.observe('Ответ');frames.shift()!();document.visibilityState='hidden';frames.shift()!();
    const reporting=metric.report('','s','m','v');await Promise.resolve();expect(fetch).not.toHaveBeenCalled();
    document.visibilityState='visible';document.dispatchEvent(new Event('visibilitychange'));
    expect(frames).toHaveLength(1);
    vi.stubGlobal('performance',{now:()=>2200});frames.shift()!();frames.shift()!();await reporting;
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({firstUsefulContentMs:2000});
  });
  it('reports a render opportunity after an eleven-minute response',async()=>{
    const {frames,fetch}=setup();vi.stubGlobal('performance',{now:()=>651282});
    const metric=createAnswerDeliveryMetric(0);metric.observe('Ответ');
    frames.shift()!();frames.shift()!();await metric.report('','s','m','v');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({firstUsefulContentMs:651282});
  });
  it.each([-1,Number.NaN,Number.POSITIVE_INFINITY,Number.MAX_SAFE_INTEGER+1])('rejects an invalid render measurement %s',async value=>{
    const {frames,fetch}=setup();vi.stubGlobal('performance',{now:()=>value});
    const metric=createAnswerDeliveryMetric(0);metric.observe('Ответ');frames.shift()!();frames.shift()!();
    await metric.report('','s','m','v');expect(fetch).not.toHaveBeenCalled();
  });
  it('ignores empty text and records only the first answer after render opportunities',async()=>{
    const {frames,fetch}=setup();const metric=createAnswerDeliveryMetric(200);
    metric.observe(' ');expect(frames).toHaveLength(0);
    metric.observe('Ответ');metric.observe(' ещё');expect(frames).toHaveLength(1);
    const reporting=metric.report('https://fixture.invalid','session','message','visitor');
    expect(fetch).not.toHaveBeenCalled();frames.shift()!();expect(fetch).not.toHaveBeenCalled();frames.shift()!();await reporting;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({firstUsefulContentMs:1000});
  });
  it('does not report hidden frames or failed messages without an identifier',async()=>{
    const {frames,document,fetch}=setup();const metric=createAnswerDeliveryMetric(0);
    metric.observe('Ответ');document.visibilityState='hidden';frames.shift()!();expect(frames).toHaveLength(0);
    const reporting=metric.report('','s','m','v');metric.dispose();await reporting;expect(fetch).not.toHaveBeenCalled();
    const failed=createAnswerDeliveryMetric(0);document.visibilityState='visible';failed.observe('Ответ');
    await failed.report('','s',undefined,'v');expect(fetch).not.toHaveBeenCalled();expect(frames).toHaveLength(0);
  });
  it('starts hidden, ignores blank text, and removes observation after its single concurrent report',async()=>{
    const {frames,document,fetch}=setup();const add=vi.spyOn(document,'addEventListener');const remove=vi.spyOn(document,'removeEventListener');
    const metric=createAnswerDeliveryMetric(200);document.visibilityState='hidden';
    metric.observe('  ');expect(add).not.toHaveBeenCalled();expect(frames).toHaveLength(0);
    metric.observe('Ответ');metric.observe('Ещё');expect(add).toHaveBeenCalledTimes(1);expect(frames).toHaveLength(0);
    const first=metric.report('','s','m','v');const second=metric.report('','s','m','v');expect(second).toBe(first);
    document.visibilityState='visible';document.dispatchEvent(new Event('visibilitychange'));
    frames.shift()!();frames.shift()!();await first;
    await metric.report('','s','m','v');metric.observe('Ещё');document.dispatchEvent(new Event('visibilitychange'));
    expect(fetch).toHaveBeenCalledTimes(1);expect(frames).toHaveLength(0);
    expect(remove).toHaveBeenCalledWith('visibilitychange',add.mock.calls[0][1]);
  });
  it('cancels stale frames on visibility changes and never counts a hidden interval as rendering',async()=>{
    const {frames,document,fetch}=setup();const metric=createAnswerDeliveryMetric(0);metric.observe('Ответ');
    frames.shift()!();const stale=frames[0];document.visibilityState='hidden';document.dispatchEvent(new Event('visibilitychange'));
    expect(frames).toHaveLength(0);document.visibilityState='visible';document.dispatchEvent(new Event('visibilitychange'));
    stale();expect(frames).toHaveLength(1);
    const reporting=metric.report('','s','m','v');await Promise.resolve();expect(fetch).not.toHaveBeenCalled();
    frames.shift()!();frames.shift()!();await reporting;expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['waiting','measured'] as const)('dispose stops a late report while %s and removes callbacks',async phase=>{
    const {frames,document,fetch}=setup();const metric=createAnswerDeliveryMetric(0);metric.observe('Ответ');
    const reporting=metric.report('','s','m','v');
    if(phase==='measured'){frames.shift()!();frames.shift()!();}
    metric.dispose();metric.dispose();await reporting;
    document.dispatchEvent(new Event('visibilitychange'));metric.observe('Ответ');await metric.report('','s','m','v');
    expect(fetch).not.toHaveBeenCalled();expect(frames).toHaveLength(0);
  });
  it('finishes without an answer and cannot start observing after report',async()=>{
    const {frames,document,fetch}=setup();const add=vi.spyOn(document,'addEventListener');const metric=createAnswerDeliveryMetric();
    metric.observe('');await metric.report('','s','m','v');metric.observe('Late answer');
    expect(add).not.toHaveBeenCalled();expect(frames).toHaveLength(0);expect(fetch).not.toHaveBeenCalled();
  });
  it('never rejects the answer because telemetry failed',async()=>{
    const {frames,fetch}=setup();fetch.mockRejectedValue(new Error('offline'));const metric=createAnswerDeliveryMetric(0);
    metric.observe('Ответ');frames.shift()!();frames.shift()!();await expect(metric.report('','s','m','v')).resolves.toBeUndefined();
    await metric.report('','s','m','v');expect(fetch).toHaveBeenCalledTimes(1);
  });
});
