import { describe, expect, it } from 'vitest';
import { normalizeSourcePolicy, sourcePolicyFromLegacyContract, sourcePolicyRequiresWeb } from '../src/ai/sourcePolicy.js';
import type { AgentTurnContract } from '../src/shared/types.js';

const contract: AgentTurnContract = {
  answerTask: 'technical_explanation',
  taskType: 'technical_answer',
  catalogAction: 'none',
  commercialAction: 'none',
  productCardsPolicy: 'none',
  mustAnswerNow: [],
  activeNeeds: [],
  currentFocus: 'current',
  cardsRole: 'none',
  leadAllowed: true,
  leadAllowedReason: 'ok',
  errorRecoveryPriority: 'answer',
  validatorWarnings: []
};

describe('source policy', () => {
  it('requires web for external technical verification', () => {
    const policy = sourcePolicyFromLegacyContract({ contract, webRequired: true });

    expect(policy.required).toContain('web');
    expect(policy.allowed).toContain('web');
    expect(sourcePolicyRequiresWeb(policy)).toBe(true);
  });

  it('uses specialist instead of web for commercial availability and delivery facts', () => {
    const policy = sourcePolicyFromLegacyContract({
      contract: {
        ...contract,
        answerTask: 'lead_handoff',
        taskType: 'pure_availability',
        commercialAction: 'explain_manager_required'
      },
      webRequired: true
    });

    expect(policy.required).toContain('specialist');
    expect(policy.forbidden).toContain('web');
    expect(sourcePolicyRequiresWeb(policy)).toBe(false);
  });

  it('normalizes required sources into allowed sources and removes forbidden overlaps', () => {
    const policy = normalizeSourcePolicy({
      allowed: ['catalog', 'web'],
      required: ['web', 'specialist'],
      forbidden: ['web']
    });

    expect(policy.allowed).toEqual(['catalog', 'specialist']);
    expect(policy.required).toEqual(['specialist']);
    expect(policy.forbidden).toEqual(['web']);
  });
});
