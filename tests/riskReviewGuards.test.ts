import { describe, expect, it } from 'vitest';
import type { ToolResult } from '../src/ai/agentManagerContracts.js';
import { hasAdjudicationRisk, hasUnsupportedClaimRisk } from '../src/ai/riskReviewGuards.js';

function toolResultWithWarning(warning: string): ToolResult {
  return {
    requestId: 'web:test',
    tool: 'web.researchProductFacts',
    status: 'ok',
    payload: {},
    warnings: [warning]
  };
}

describe('risk review guards', () => {
  it('recognizes answer adjudication risk flags', () => {
    for (const flag of [
      'high_risk_disagreement',
      'needs_adjudication',
      'requires-adjudication',
      'source_conflict_unresolved'
    ]) {
      expect(hasAdjudicationRisk({ answerRiskFlags: [flag], toolResults: [] })).toBe(true);
    }
  });

  it('recognizes tool warning adjudication risks', () => {
    for (const warning of ['high-risk-disagreement', 'unresolved_conflict', 'need_adjudication']) {
      expect(hasAdjudicationRisk({ answerRiskFlags: [], toolResults: [toolResultWithWarning(warning)] })).toBe(true);
    }
  });

  it('recognizes unsupported factual claim risk flags', () => {
    for (const flag of ['unsupported', 'unverified', 'no_evidence', 'hallucination']) {
      expect(hasUnsupportedClaimRisk([flag])).toBe(true);
    }
  });

  it('does not flag unrelated risk labels', () => {
    expect(hasAdjudicationRisk({ answerRiskFlags: ['delivery_handoff'], toolResults: [toolResultWithWarning('source_checked')] })).toBe(false);
    expect(hasUnsupportedClaimRisk(['commercial_terms_need_manager'])).toBe(false);
  });
});
