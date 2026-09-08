import {afterEach,describe,expect,it,vi} from 'vitest';
import {createAnswerDeliveryMetric} from '../src/client/answerDeliveryMetric';
afterEach(()=>vi.unstubAllGlobals());
function setup(){
  const frames:Array<()=>void>=[];
  const document={visibilityState:'visible'};
  vi.stubGlobal('document',document);
  vi.stubGlobal('performance',{now:()=>1200});
  vi.stubGlobal('requestAnimationFrame',(callback:()=>void)=>frames.push(callback));
  const fetch=vi.fn().mockResolvedValue({ok:true});vi.stubGlobal('fetch',fetch);
  return {frames,document,fetch};
}
describe('visible answer delivery measurement',()=>{
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
    metric.observe('Ответ');document.visibilityState='hidden';frames.shift()!();frames.shift()!();
    await metric.report('','s','m','v');expect(fetch).not.toHaveBeenCalled();
    const failed=createAnswerDeliveryMetric(0);document.visibilityState='visible';failed.observe('Ответ');
    await failed.report('','s',undefined,'v');expect(fetch).not.toHaveBeenCalled();
  });
  it('never rejects the answer because telemetry failed',async()=>{
    const {frames,fetch}=setup();fetch.mockRejectedValue(new Error('offline'));const metric=createAnswerDeliveryMetric(0);
    metric.observe('Ответ');frames.shift()!();frames.shift()!();await expect(metric.report('','s','m','v')).resolves.toBeUndefined();
  });
});
