import { describe, expect, it } from 'vitest';
import { resolveTurnContract } from '../src/ai/turnContract.js';
import { assistantTestHooks } from '../src/ai/assistant.js';

const basePlan = {
  action: 'recommend_products' as const,
  answerMode: 'productRecommendation' as const,
  cardPolicy: 'showProducts' as const,
  followUpPolicy: 'auto' as const,
  contextScope: 'activeNeed' as const,
  searchScope: 'focusedNeed' as const,
  catalogSearchQuery: 'генератор для дома',
  selectedProductIds: ['p1'],
  needsWebSearch: false,
  missingInformation: [],
  answerGuidance: 'answer briefly'
};

describe('turn contract resolver', () => {
  it('preserves planner action scopes and exposes render policy as one contract', () => {
    const contract = resolveTurnContract({ plan: basePlan });

    expect(contract.action.primary).toBe('recommend_products');
    expect(contract.scope.context).toBe('activeNeed');
    expect(contract.scope.search).toBe('focusedNeed');
    expect(contract.render.cards).toBe('showProducts');
    expect(contract.render.leadForm).toBe(false);
    expect(contract.knowledge.webRequired).toBe(false);
    expect(contract.selection.selectedProductIds).toEqual(['p1']);
  });

  it('makes lead form explicit for collect-lead plans and suppresses product cards by default', () => {
    const contract = resolveTurnContract({
      plan: {
        ...basePlan,
        action: 'collect_lead',
        answerMode: 'leadCollection',
        cardPolicy: 'auto',
        followUpPolicy: 'collectLead'
      }
    });

    expect(contract.render.leadForm).toBe(true);
    expect(contract.render.cards).toBe('selectedOnly');
    expect(contract.action.primary).toBe('collect_lead');
  });

  it('keeps factual web-required answers text-only and traceable', () => {
    const contract = resolveTurnContract({
      plan: {
        ...basePlan,
        action: 'verify_with_web',
        answerMode: 'currentLineup',
        cardPolicy: 'textOnly',
        followUpPolicy: 'answerNowNoDeferredOffer',
        needsWebSearch: true
      },
      forceTextOnlyReason: 'current_lineup'
    });

    expect(contract.knowledge.webRequired).toBe(true);
    expect(contract.render.cards).toBe('none');
    expect(contract.render.textOnlyReason).toBe('current_lineup');
    expect(contract.diagnostics.sourcePlan.action).toBe('verify_with_web');
  });

  it('downgrades generator recommendations when 220/380 phase is only inferred from load context', () => {
    const contract = resolveTurnContract({
      plan: {
        ...basePlan,
        requiredProductTraits: {
          productIntent: 'generator',
          singlePhase220: true,
          provenance: { singlePhase220: 'inferred_from_load' }
        },
        selectedProductIds: ['g1', 'g2'],
        missingInformation: []
      }
    });

    expect(contract.action.primary).toBe('ask_clarifying_question');
    expect(contract.action.answerMode).toBe('short');
    expect(contract.action.followUpPolicy).toBe('askClarifyingQuestion');
    expect(contract.render.cards).toBe('none');
    expect(contract.selection.selectedProductIds).toEqual([]);
    expect(contract.knowledge.missingInformation).toContain('220 В или 380 В');
    expect(contract.guidance).toContain('не финально рекомендуй генератор');
    expect(contract.diagnostics.overrides).toContain('generator_phase_requires_explicit_confirmation');
  });

  it('allows generator recommendations when the phase was explicitly provided by the buyer', () => {
    const contract = resolveTurnContract({
      plan: {
        ...basePlan,
        requiredProductTraits: {
          productIntent: 'generator',
          singlePhase220: false,
          provenance: { singlePhase220: 'explicit_user' }
        },
        selectedProductIds: ['g380']
      }
    });

    expect(contract.action.primary).toBe('recommend_products');
    expect(contract.render.cards).toBe('showProducts');
    expect(contract.selection.selectedProductIds).toEqual(['g380']);
    expect(contract.knowledge.missingInformation).not.toContain('220 В или 380 В');
  });

  it('does not change authoritative recommendation cards to follow an LLM text mention', () => {
    const firstCard = {
      id: 'main-card',
      name: 'Генератор бензиновый основной 5.0 кВт',
      category: 'Генераторы',
      price: 61000,
      currency: 'RUB',
      sourceUrl: 'https://example.test/main-card/',
      specs: { 'Номинальная мощность': '5.0 кВт' },
      reasons: [],
      caveats: []
    };
    const otherProduct = {
      id: 'other-card',
      name: 'Генератор бензиновый альтернативный 5.0 кВт',
      category: 'Генераторы',
      price: 99000,
      currency: 'RUB',
      sourceUrl: 'https://example.test/other-card/',
      specs: { 'Номинальная мощность': '5.0 кВт' }
    };
    const needState = {
      explicitNeeds: [],
      implicitNeeds: [],
      constraints: [],
      importantCriteria: [],
      confirmedFacts: [],
      uncertainInferences: [],
      contradictions: [],
      featureSignals: {
        portable: 0,
        homeUse: 0,
        compact: 0,
        lowNoise: 0,
        coldStart: 0,
        professionalDuty: 0,
        budgetSensitive: 0
      },
      lastSummary: '',
      selectionState: {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        activeRequirement: undefined,
        hardConstraints: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          exactModelTokens: [],
          exactModelTokenRoles: [],
          mustHaveTraits: [],
          excludedClasses: [],
          fuel: 'gasoline',
          singlePhase220: true,
          nominalPowerKwMin: 4.5,
          nominalPowerKwMax: 5.5,
          provenance: {}
        },
        softPreferences: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          mustHaveTraits: [],
          exactModelTokens: [],
          excludedClasses: []
        },
        unknowns: [],
        conflicts: [],
        selectedProductIds: ['main-card'],
        matchedProductIds: ['main-card', 'other-card'],
        previousCandidateProductIds: ['main-card', 'other-card'],
        comparisonProductIds: [],
        rejectedProducts: [],
        confidence: 0.9,
        updatedAt: '2026-05-01T00:00:00.000Z'
      }
    } as any;

    const result = assistantTestHooks.enforceAnswerCardContract(
      'Лучший вариант — Генератор бензиновый альтернативный 5.0 кВт.',
      [firstCard] as any,
      [otherProduct] as any,
      needState,
      'Подбери бензиновый генератор 5 кВт до 100 тысяч',
      basePlan as any
    );

    expect(result.cards.map((card: { id: string }) => card.id)).toEqual(['main-card']);
    expect(result.diagnostics.addedCardIds).toEqual([]);
    expect(result.diagnostics.reordered).toBe(false);
  });

  it('caps visible product cards when buyer explicitly asks for one main and one backup option', () => {
    expect(assistantTestHooks.requestedVisibleCardLimitFromText('Выберите конкретно: один основной генератор и один запасной.'))
      .toBe(2);
    expect(assistantTestHooks.requestedVisibleCardLimitFromText('Покажи 2 варианта, без длинного списка.'))
      .toBe(2);
    expect(assistantTestHooks.requestedVisibleCardLimitFromText('Мне не нужен большой список. Скажите по-человечески: какой вариант вы бы взяли первым, и какая нормальная альтернатива?'))
      .toBe(2);
  });
});
