import {describe,it,expect} from 'vitest';
import {assertRegexBaselineDoesNotGrow} from '../scripts/regexBaselineIntegrity.mjs';
const entry=(file,hash='same',occurrence=1,kind='regular_expression_literal')=>({file,hash,occurrence,kind,id:[file,kind,hash,occurrence].join('|')});
const baseline=(...findings)=>({findings});
describe('reference-controlled semantic expression baseline',()=>{
  it('accepts relocation or removal of the identical audited expression',()=>{
    expect(()=>assertRegexBaselineDoesNotGrow(baseline(entry('old.ts')),baseline(entry('new.ts')))).not.toThrow();
    expect(()=>assertRegexBaselineDoesNotGrow(baseline(entry('old.ts')),baseline())).not.toThrow();
  });
  it.each([
    baseline(entry('new.ts','changed')),
    baseline(entry('old.ts'),entry('new.ts')),
    baseline(entry('old.ts'),entry('old.ts','same',2)),
    baseline(entry('new.ts','same',1,'regexp_constructor_new'))
  ])('rejects changed expressions, added copies and changed construct kinds',current=>{
    expect(()=>assertRegexBaselineDoesNotGrow(baseline(entry('old.ts')),current)).toThrow('grew');
  });
  it('rejects forged identities and duplicate entries rather than collapsing them',()=>{
    expect(()=>assertRegexBaselineDoesNotGrow(baseline(entry('old.ts')),baseline({...entry('new.ts'),id:'fake'}))).toThrow('Invalid');
    expect(()=>assertRegexBaselineDoesNotGrow(baseline(entry('old.ts')),baseline(entry('new.ts'),entry('new.ts')))).toThrow('duplicate');
  });
});
