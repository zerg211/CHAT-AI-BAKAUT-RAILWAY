import {describe,it,expect,beforeEach,afterEach,vi} from 'vitest';
import type {DialogueLedgerEvent} from '../src/ai/agentManagerContracts.js';
import {parseReducedDialogueLedgerState,reduceDialogueLedger,deriveNeedStateSnapshotFromLedger} from '../src/ai/dialogueLedgerReducer.js';

describe('long dialogue snapshots under generated requirement changes',()=>{
  beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-08T10:00:00Z'));});
  afterEach(()=>vi.useRealTimers());
  it.each(Array.from({length:24},(_,i)=>i+1))('preserves state through 160 turns and repeated snapshot boundaries, seed %i',seed=>{
    let state=seed;
    const next=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
    const events:DialogueLedgerEvent[]=[];
    const append=(turn:number,eventType:DialogueLedgerEvent['eventType'],payload:Record<string,unknown>)=>{
      events.push({sessionId:'11111111-1111-4111-8111-111111111111',turnId:'22222222-2222-4222-8222-222222222222',
        eventId:`${seed}-${turn}-${events.length}`,eventType,payload,scope:'need',source:'llm_state_delta',
        evidence:'generated explicit buyer change',status:'active',createdAt:new Date(1700000000000+turn*1000).toISOString()});
    };
    for(let turn=0;turn<160;turn++) {
      const needId=next()%2?'generator':'plate';
      append(turn,'need.opened',{needId,productClass:needId,summary:needId,activate:true});
      append(turn,'fact.confirmed',{needId,productClass:needId,factKey:'budget.max_rub',value:10000+next()%100000,role:'hard_requirement'});
      if(next()%4===0)append(turn,'fact.negated',{needId,factKey:'budget.max_rub'});
      if(next()%5===0)append(turn,'fact.confirmed',{needId,productClass:needId,factKey:'weight.max_kg',value:40+next()%60,role:'hard_requirement'});
    }
    const full=reduceDialogueLedger(events);
    let compacted=reduceDialogueLedger([]);
    for(let cursor=0;cursor<events.length;) {
      const count=1+next()%37;
      const batch=events.slice(cursor,cursor+count);
      compacted=reduceDialogueLedger(batch,parseReducedDialogueLedgerState(JSON.parse(JSON.stringify(compacted))));
      // Transport duplicate delivery cannot apply a previous event twice.
      compacted=reduceDialogueLedger(batch.slice(-1),compacted);
      cursor+=count;
    }
    expect(compacted.factsByKey).toEqual(full.factsByKey);
    expect(compacted.needsById).toEqual(full.needsById);
    expect(compacted.questionsById).toEqual(full.questionsById);
    expect(compacted.eventIds).toEqual(full.eventIds);
    const actual=deriveNeedStateSnapshotFromLedger(compacted),expected=deriveNeedStateSnapshotFromLedger(full);
    expect(actual.selectionState).toEqual(expected.selectionState);
    expect(actual.semanticMemory).toEqual(expected.semanticMemory);
  });
});
