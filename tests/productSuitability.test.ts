import { describe, expect, it } from 'vitest';

import {
  buildProductCandidateSet,
  classifyProductSuitability,
  selectProductsBySuitability,
  type BuyerRequirementContract
} from '../src/ai/productSuitability.js';
import type { Product } from '../src/shared/types.js';

function plate(id: string, name: string, weightKg: number, price: number, forceKn = 10.5): Product {
  return {
    id,
    name,
    brand: name.includes('TSS') || name.includes('ТСС') ? 'ТСС' : 'Brand',
    category: 'Виброплиты',
    price,
    currency: 'RUB',
    specs: {
      'рабочая масса, кг': String(weightKg),
      'центробежная сила, кН': String(forceKn).replace('.', ',')
    }
  };
}

function generator(id: string): Product {
  return {
    id,
    name: 'Генератор 220 В 5 кВт',
    brand: 'ТСС',
    category: 'Генераторы',
    price: 90000,
    currency: 'RUB',
    specs: { 'напряжение, В': '220' }
  };
}

const requirements: BuyerRequirementContract = {
  buyerGoal: 'уплотнить песок под тротуарную плитку на небольшом участке',
  targetProductClass: 'plate',
  hardRequirements: [{ kind: 'budgetMaxRub', value: 60000, evidence: 'до 60 тысяч', strictness: 'strict' }],
  softRequirements: [
    { kind: 'notTooHeavy', value: true, evidence: 'не тяжёлая', strictness: 'soft' },
    { kind: 'notCheapest', value: true, evidence: 'самую дешёвую не надо', strictness: 'soft' }
  ],
  allowedCompromises: [{ kind: 'slightlyHeavierForBetterCompaction', value: true, evidence: 'чтобы нормально трамбовала' }],
  forbiddenRecommendations: [],
  criticalAttributes: ['weightKg', 'centrifugalForceKn'],
  budgetPolicy: { maxRub: 60000, strictness: 'strict', allowSlightlyAboveWhenFewMatches: true },
  topicAction: 'continue_current_need',
  rationale: 'small-site vibroplate selection'
};

describe('productSuitability', () => {
  it('builds a complete candidate set instead of collapsing to the first mentioned product', () => {
    const products = [
      generator('g1'),
      plate('p1', 'Виброплита TSS-WP60L 60 кг', 60, 49907),
      plate('p2', 'Виброплита Masalta MS50-2 54 кг', 54, 55000),
      plate('p3', 'Виброплита Zitrek z3k60 57 кг', 57, 38000),
      plate('p4', 'Виброплита TSS-WP70TL 72 кг', 72, 38766),
      plate('p5', 'Виброплита TSS-WP60TH 60 кг', 60, 79592)
    ];

    const candidateSet = buildProductCandidateSet({ products, requirements, uiSafeCap: 8 });

    expect(candidateSet.primaryCandidates.map((product) => product.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(candidateSet.nearBudgetCandidates.map((product) => product.id)).toEqual(['p5']);
    expect(candidateSet.rejectedEarly.map((item) => item.product.id)).toEqual(['g1']);
    expect(candidateSet.audit).toMatchObject({ totalProducts: 6, sameClassCandidates: 5 });
  });

  it('classifies 72 kg under not-heavy as compromise, not as a light match', () => {
    const decision = classifyProductSuitability({
      product: plate('heavy', 'Виброплита TSS-WP70TL 72 кг', 72, 38766),
      requirements,
      matchContext: { inBudgetMatchCount: 2 }
    });

    expect(decision.status).toBe('compromise');
    expect(decision.softTradeoffs).toContain('72 кг тяжелее лёгких 54–60 кг, зато может трамбовать увереннее');
    expect(decision.customerFacingReason).toContain('тяжелее');
  });

  it('ranks all honest matches before compromises and is independent of catalog order', () => {
    const shuffled = [
      plate('comp-heavy', 'Виброплита тяжелее 72 кг', 72, 39000),
      plate('match-mid', 'Виброплита нормальная 60 кг', 60, 50000),
      plate('reject-over', 'Виброплита дорогая 60 кг', 60, 150000),
      plate('match-light', 'Виброплита легкая 54 кг', 54, 55000),
      plate('match-budget', 'Виброплита рабочая 57 кг', 57, 43000)
    ];

    const decisions = shuffled.map((product) => classifyProductSuitability({
      product,
      requirements,
      matchContext: { inBudgetMatchCount: 3 }
    }));

    const selected = selectProductsBySuitability({ decisions, uiSafeCap: 8, minimumGoodMatchesBeforeCompromises: 3 });

    expect(selected.map((item) => item.product.id)).toEqual(['match-mid', 'match-light', 'match-budget']);
    expect(selected.every((item) => item.status === 'match' || item.status === 'soft_match')).toBe(true);
  });

  it('allows one useful compromise when honest matches are few', () => {
    const decisions = [
      classifyProductSuitability({ product: plate('match-only', 'Виброплита 60 кг', 60, 50000), requirements, matchContext: { inBudgetMatchCount: 1 } }),
      classifyProductSuitability({ product: plate('comp-heavy', 'Виброплита 72 кг', 72, 39000), requirements, matchContext: { inBudgetMatchCount: 1 } }),
      classifyProductSuitability({ product: plate('comp-above-budget', 'Виброплита 60 кг премиум', 60, 75000), requirements, matchContext: { inBudgetMatchCount: 1 } })
    ];

    const selected = selectProductsBySuitability({ decisions, uiSafeCap: 8, minimumGoodMatchesBeforeCompromises: 3 });

    expect(selected.map((item) => [item.product.id, item.status])).toEqual([
      ['match-only', 'match'],
      ['comp-heavy', 'compromise'],
      ['comp-above-budget', 'compromise']
    ]);
  });
});
