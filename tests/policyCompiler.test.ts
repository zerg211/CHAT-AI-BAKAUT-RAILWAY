import { describe, expect, it } from 'vitest';
import {
  compilePolicyPack,
  selectPolicyRules,
  formatPolicyRulesForPrompt
} from '../src/ai/policy/policyCompiler.js';
import type { PolicyRule } from '../src/ai/policy/policyRuleTypes.js';

function rule(overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id: 'rule.core.help_first',
    code: 'core.help_first',
    title: 'Help first without fixed scripts',
    body: 'Сначала помоги покупателю полезно и живо; правила — рамки, а не готовые ответы.',
    category: 'core',
    tags: ['core', 'style'],
    appliesTo: ['answer', 'planner'],
    riskLevel: 'medium',
    severity: 'must',
    priority: 100,
    mandatory: true,
    predicates: [],
    allowedActions: ['answer_with_orientation'],
    forbiddenActions: ['fixed_template_answer'],
    repairAction: 'preserve useful advice and remove fixed-template wording',
    owner: 'sales-ai',
    version: 1,
    status: 'active',
    tokenEstimate: 24,
    ...overrides
  };
}

describe('policy compiler', () => {
  it('rejects duplicate rule codes before publishing a policy pack', () => {
    expect(() => compilePolicyPack([
      rule({ id: 'r1', code: 'stock.no_false_stock_claim' }),
      rule({ id: 'r2', code: 'stock.no_false_stock_claim' })
    ])).toThrow(/duplicate policy rule code/i);
  });

  it('rejects active high-risk rules without owner and review date', () => {
    expect(() => compilePolicyPack([
      rule({
        id: 'r1',
        code: 'stock.no_false_stock_claim',
        riskLevel: 'critical',
        owner: '',
        reviewBy: undefined
      })
    ])).toThrow(/owner.*reviewBy/i);
  });

  it('selects mandatory core and deterministic risk rules before semantic extras', () => {
    const pack = compilePolicyPack([
      rule({ id: 'core', code: 'core.help_first', tags: ['core'], mandatory: true, priority: 100, reviewBy: '2027-01-01' }),
      rule({ id: 'stock', code: 'stock.no_false_stock_claim', tags: ['stock', 'availability'], mandatory: false, priority: 95, riskLevel: 'critical', reviewBy: '2027-01-01' }),
      rule({ id: 'photo', code: 'photo.prefer_bakaut_card', tags: ['photo'], mandatory: false, priority: 30, riskLevel: 'low' })
    ]);

    const selected = selectPolicyRules(pack, {
      tags: ['availability'],
      riskFlags: ['stock'],
      semanticRuleIds: ['photo.prefer_bakaut_card'],
      maxRules: 3
    });

    expect(selected.map((item) => item.code)).toEqual([
      'core.help_first',
      'stock.no_false_stock_claim',
      'photo.prefer_bakaut_card'
    ]);
  });

  it('never drops mandatory rules when maxRules is lower than mandatory count', () => {
    const pack = compilePolicyPack([
      rule({ id: 'm1', code: 'core.one', mandatory: true, priority: 100, reviewBy: '2027-01-01' }),
      rule({ id: 'm2', code: 'core.two', mandatory: true, priority: 99, reviewBy: '2027-01-01' }),
      rule({ id: 'optional', code: 'stock.optional', tags: ['stock'], mandatory: false, priority: 98, riskLevel: 'critical', reviewBy: '2027-01-01' })
    ]);

    const selected = selectPolicyRules(pack, { tags: ['stock'], riskFlags: [], maxRules: 1 });

    expect(selected.map((item) => item.code)).toEqual(['core.one', 'core.two']);
  });

  it('filters selected rules by prompt target', () => {
    const pack = compilePolicyPack([
      rule({ id: 'core', code: 'core.help_first', mandatory: true, appliesTo: ['answer', 'planner'], reviewBy: '2027-01-01' }),
      rule({ id: 'gate', code: 'gate.only', tags: ['stock'], mandatory: false, appliesTo: ['gate'], priority: 99, riskLevel: 'critical', reviewBy: '2027-01-01' }),
      rule({ id: 'planner', code: 'planner.only', tags: ['stock'], mandatory: false, appliesTo: ['planner'], priority: 80 })
    ]);

    const selected = selectPolicyRules(pack, { tags: ['stock'], riskFlags: [], target: 'planner' });

    expect(selected.map((item) => item.code)).toEqual(['core.help_first', 'planner.only']);
  });

  it('formats selected rules as principles and forbids using them as fixed answer scripts', () => {
    const pack = compilePolicyPack([
      rule({ id: 'core', code: 'core.help_first', mandatory: true, reviewBy: '2027-01-01' })
    ]);
    const prompt = formatPolicyRulesForPrompt(selectPolicyRules(pack, { tags: [], riskFlags: [] }));

    expect(prompt).toContain('DYNAMIC SALES POLICY');
    expect(prompt).toContain('core.help_first');
    expect(prompt).toContain('не готовые ответы');
    expect(prompt.length).toBeLessThan(1600);
  });
});
