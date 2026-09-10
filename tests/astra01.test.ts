import { describe, expect, it } from 'vitest';
import { guardCustomerOutput } from '../src/ai/agentManagerOutputGuard.js';
import {
  AGENT_RISK_FLAG_TAXONOMY,
  isKnownAgentRiskFlag,
  normalizeRiskFlags,
  recentFailuresFromToolResults
} from '../src/ai/agentManagerContracts.js';
import { leadOfferWithoutReviewableResult } from '../src/ai/leadReviewGuards.js';
import {
  salesManagerBehaviorPolicyPromptBlock,
  salesManagerPlannerPolicyPromptBlock,
  salesManagerPolicyRules
} from '../src/ai/salesManagerBehaviorPolicy.js';
import { plannerSystemPromptBlock } from '../src/ai/agentManagerModelAdapter.js';

function ruleBody(code: string): string {
  const rule = salesManagerPolicyRules.find((item) => item.code === code);
  if (!rule) throw new Error(`missing policy rule ${code}`);
  return rule.body;
}

describe('astra-01 AC1 self-contained final', () => {
  it('guards intermediate-channel references', () => {
    expect(guardCustomerOutput({
      answerText: 'Подождите, это промежуточный результат поиска.',
      productCards: []
    }).ok).toBe(false);
    expect(guardCustomerOutput({
      answerText: 'Как я уже искал, вот вариант.',
      productCards: []
    }).ok).toBe(false);
    expect(guardCustomerOutput({
      answerText: 'Генератор ТСС SGG 5000ES подойдёт для дома: 5 кВт, электростартер.',
      productCards: []
    }).ok).toBe(true);
  });

  it('routes the self-contained rule into planner and answer prompts', () => {
    expect(salesManagerPlannerPolicyPromptBlock({})).toContain('answer.self_contained_final');
    expect(salesManagerBehaviorPolicyPromptBlock({
      semanticRuleIds: ['answer.self_contained_final'],
      maxRules: 8
    })).toContain('self-contained');
  });
});

describe('astra-01 AC2 result-first lead', () => {
  it('flags lead offers without reviewable result', () => {
    const empty = { leadAction: 'offer_form' as const, factsUsed: [], selectedProductIds: [], questionsAsked: [] };
    expect(leadOfferWithoutReviewableResult(empty)).toBe(true);
    expect(leadOfferWithoutReviewableResult({ ...empty, leadAction: 'none' })).toBe(false);
    expect(leadOfferWithoutReviewableResult({
      ...empty,
      factsUsed: [{ factKey: 'k', sourceEventIds: ['e'], value: 1 }]
    })).toBe(false);
    expect(leadOfferWithoutReviewableResult({ ...empty, selectedProductIds: ['p1'] })).toBe(false);
    expect(leadOfferWithoutReviewableResult({
      ...empty,
      questionsAsked: [{ questionId: 'q', text: 't', reason: 'r' }]
    })).toBe(false);
  });

  it('requires a concrete result before contact in policy text', () => {
    expect(ruleBody('contact.ask_only_for_result')).toContain('проверяемый результат');
  });
});

describe('astra-01 AC3/AC4 planner gaps', () => {
  it('declares buyer-message precedence and fact-vs-intent gaps', () => {
    const prompt = plannerSystemPromptBlock('test');
    expect(prompt).toContain('свежей реплики');
    expect(prompt).toContain('fact_gap');
    expect(prompt).toContain('intent_gap');
    expect(salesManagerPlannerPolicyPromptBlock({})).toContain('core.user_over_instructions');
    expect(salesManagerPlannerPolicyPromptBlock({})).toContain('planning.fact_vs_intent_gap');
  });
});

describe('astra-01 AC5 turn failure memory', () => {
  it('keeps only failed tool steps, unique and bounded', () => {
    expect(recentFailuresFromToolResults(undefined)).toEqual([]);
    expect(recentFailuresFromToolResults([
      { tool: 'catalog.search', status: 'ok' }
    ])).toEqual([]);
    expect(recentFailuresFromToolResults([
      { tool: 'catalog.search', status: 'timeout', errorCode: 'upstream_timeout' },
      { tool: 'web.researchProductFacts', status: 'denied' },
      { tool: 'web.researchProductFacts', status: 'denied' }
    ])).toEqual([
      'catalog.search:timeout:upstream_timeout',
      'web.researchProductFacts:denied'
    ]);
    const many = Array.from({ length: 12 }, (_, index) => ({
      tool: `tool.${index}`,
      status: 'failed'
    }));
    expect(recentFailuresFromToolResults(many)).toHaveLength(8);
  });
});

describe('astra-01 AC6 web decision boundary', () => {
  it('pins conditional web to preliminary_fit in policy text', () => {
    const body = ruleBody('grounding.search_before_specialist');
    expect(body).toContain('conditional_on_catalog_gap');
    expect(body).toContain('preliminary_fit');
  });
});

describe('astra-01 AC7 risk-flag taxonomy', () => {
  it('covers every flag produced in code and normalizes input', () => {
    const produced = [
      'answer_policy_catalog_presence_relevant',
      'selection_readiness_blocked_cards',
      'recovered_legacy_answer_contract_fail_closed'
    ];
    for (const flag of produced) {
      expect(isKnownAgentRiskFlag(flag)).toBe(true);
    }
    expect(AGENT_RISK_FLAG_TAXONOMY).toContain('unsupported_claim');
    expect(normalizeRiskFlags([' a ', '', 'a', 'b'])).toEqual(['a', 'b']);
    expect(normalizeRiskFlags(undefined)).toEqual([]);
  });
});
