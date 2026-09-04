import { describe, expect, it } from 'vitest';
import {
  findGroundedLoadRename,
  generatorSelectionOversizeIssue
} from '../src/ai/agentManagerOrchestrator.js';

describe('generator oversize guard', () => {
  it('flags a shortlist where every pick is more than double the calculated need', () => {
    expect(generatorSelectionOversizeIssue({
      requiredNominalKw: 2.5,
      selectedNominals: [6, 8, 8]
    })).toBe('generator_selection_grossly_oversized');
  });

  it('passes a minimal-sufficient first pick', () => {
    expect(generatorSelectionOversizeIssue({
      requiredNominalKw: 2.5,
      selectedNominals: [3, 6]
    })).toBeNull();
  });

  it('stays silent without a calculated requirement or known nominals', () => {
    expect(generatorSelectionOversizeIssue({
      requiredNominalKw: undefined,
      selectedNominals: [6, 8]
    })).toBeNull();
    expect(generatorSelectionOversizeIssue({
      requiredNominalKw: 2.5,
      selectedNominals: [undefined, undefined]
    })).toBeNull();
    expect(generatorSelectionOversizeIssue({
      requiredNominalKw: 2.5,
      selectedNominals: []
    })).toBeNull();
  });

  it('treats exactly double as acceptable and a hair above as oversized', () => {
    expect(generatorSelectionOversizeIssue({
      requiredNominalKw: 2.5,
      selectedNominals: [5, 5],
      poolNominals: [3, 5, 6]
    })).toBeNull();
    expect(generatorSelectionOversizeIssue({
      requiredNominalKw: 2.5,
      selectedNominals: [5.01, 5.5],
      poolNominals: [3, 5, 6]
    })).toBe('generator_selection_grossly_oversized');
  });

  it('stays silent when the pool holds no closer fit', () => {
    expect(generatorSelectionOversizeIssue({
      requiredNominalKw: 2.5,
      selectedNominals: [6, 8, 8],
      poolNominals: [6, 8, 8, 16]
    })).toBeNull();
  });

  it('fires when the pool holds an ignored closer fit', () => {
    expect(generatorSelectionOversizeIssue({
      requiredNominalKw: 2.5,
      selectedNominals: [6, 8, 8],
      poolNominals: [3, 6, 8, undefined]
    })).toBe('generator_selection_grossly_oversized');
  });

  it('judges by known nominals only', () => {
    expect(generatorSelectionOversizeIssue({
      requiredNominalKw: 2.5,
      selectedNominals: [3, undefined, 8],
      poolNominals: [3, 6]
    })).toBeNull();
    expect(generatorSelectionOversizeIssue({
      requiredNominalKw: 2.5,
      selectedNominals: [6, undefined],
      poolNominals: [3, 6]
    })).toBe('generator_selection_grossly_oversized');
  });
});

describe('grounded device rename', () => {
  const ledgerPump = {
    kind: 'pump',
    name: 'Насосная станция',
    count: 1,
    runningKw: 1.1,
    startingKw: null
  };
  const renamedPump = {
    kind: 'pump',
    name: 'Aquario AJC-101',
    count: 1,
    runningKw: 1.1,
    startingKw: null
  };

  it('matches the same-kind load when the buyer names the model', () => {
    expect(findGroundedLoadRename({
      expectedLoad: ledgerPump,
      actualLoads: [renamedPump],
      userMessage: 'Насос у меня Aquario AJC-101. DAEWOO GDA 7500E его потянет?'
    })).toEqual(renamedPump);
  });

  it('matches regardless of the buyer message casing', () => {
    expect(findGroundedLoadRename({
      expectedLoad: ledgerPump,
      actualLoads: [renamedPump],
      userMessage: 'насос у меня aquario ajc-101'
    })).toEqual(renamedPump);
  });

  it('does not match across kinds or without grounding in the message', () => {
    expect(findGroundedLoadRename({
      expectedLoad: ledgerPump,
      actualLoads: [{ ...renamedPump, kind: 'boiler' }],
      userMessage: 'Насос у меня Aquario AJC-101.'
    })).toBeNull();
    expect(findGroundedLoadRename({
      expectedLoad: ledgerPump,
      actualLoads: [renamedPump],
      userMessage: 'Насосная станция 1,1 кВт.'
    })).toBeNull();
  });
});
