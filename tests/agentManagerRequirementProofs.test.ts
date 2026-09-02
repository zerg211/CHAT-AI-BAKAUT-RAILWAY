import { describe, expect, it } from 'vitest';

import {
  productCards,
  selectProductsForVisibleCards
} from '../src/ai/agentManagerCardSelection.js';
import type {
  AgentIntentContract,
  SelectionRequirement,
  ToolRequest,
  ToolResult
} from '../src/ai/agentManagerContracts.js';
import type { CustomerNeedState, Product } from '../src/shared/types.js';
import { generatorPhaseProfile } from '../src/ai/productClassifier.js';
import { buildRequirementProofs } from '../src/ai/requirementProofs.js';

function emptyNeedState(): CustomerNeedState {
  return {
    activeNeeds: [],
    semanticMemory: {
      version: 1,
      activeRequirementIds: [],
      requirements: [],
      mentionedProducts: [],
      selectionPolicy: {
        primaryRequirementIds: [],
        alternativeMode: 'none',
        explanationRequired: false
      },
      botCommitments: []
    },
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
    selectionState: {
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      hardConstraints: {
        productIntent: 'generator',
        productRole: 'coreProduct',
        exactModelTokens: [],
        exactModelTokenRoles: [],
        mustHaveTraits: [],
        excludedClasses: [],
        provenance: {}
      },
      softPreferences: {
        productIntent: 'generator',
        productRole: 'coreProduct',
        exactModelTokens: [],
        exactModelTokenRoles: [],
        mustHaveTraits: [],
        excludedClasses: [],
        provenance: {}
      },
      unknowns: [],
      conflicts: [],
      selectedProductIds: [],
      matchedProductIds: [],
      comparisonProductIds: [],
      rejectedProducts: [],
      previousCandidateProductIds: [],
      confidence: 0,
      updatedAt: '2026-07-15T00:00:00.000Z'
    },
    lastSummary: ''
  };
}

function generator(id: string, name: string, specs: Record<string, unknown>): Product {
  return {
    id,
    name,
    brand: 'ИСТОК',
    category: 'Генераторы',
    price: 100_000,
    currency: 'RUB',
    sourceUrl: `https://bakautprof.ru/catalog/${id}`,
    specs
  };
}

function intentFor(input: {
  requirement: SelectionRequirement;
  request: ToolRequest;
  phase?: 'single_phase' | 'three_phase' | 'any';
}): AgentIntentContract {
  return {
    userMessageSummary: 'strict generator selection with checked product facts',
    dialogueUnderstanding: 'bind checked facts to the active hard requirement',
    nextStepRationale: 'show only products that pass deterministic proof comparison',
    requiresTools: true,
    toolRequests: input.request.tool === 'web.researchProductFacts'
      ? [{
          id: 'catalog-search',
          tool: 'catalog.search',
          args: { query: 'generator', productIntent: 'generator' },
          rationale: 'ground visible cards in the catalog',
          required: true
        }, input.request]
      : [input.request],
    productMentions: [],
    selectionPolicy: {
      targetProductClass: 'generator',
      canonicalProductClass: 'generator',
      selectionGoal: 'final_fit',
      needAction: 'continue',
      alternativePolicy: 'same_class_only',
      reusePreviousCards: false,
      maxCards: 8,
      powerSource: 'any',
      phase: input.phase ?? 'any',
      requirements: [input.requirement],
      rationale: 'test proof-bound selection'
    },
    policyRuleIds: [],
    mustNotAskQuestionIds: [],
    riskFlags: []
  };
}

function webResult(input: {
  requestId: string;
  product: Product;
  attribute: string;
  value: string;
  confidence?: 'high' | 'medium';
  sourceUrl?: string;
  conflicts?: Array<Record<string, unknown>>;
}): ToolResult {
  return {
    requestId: input.requestId,
    tool: 'web.researchProductFacts',
    status: 'ok',
    payload: {
      usedWebSearch: true,
      searchDisposition: 'completed',
      researchOutcome: 'answered',
      sourcesExhausted: false,
      facts: [{
        productName: input.product.name,
        attribute: input.attribute,
        value: input.value,
        sourceType: 'web',
        confidence: input.confidence ?? 'high',
        evidence: `${input.product.name}: ${input.attribute}: ${input.value}`,
        sourceUrl: input.sourceUrl ?? `https://manufacturer.example/${input.product.id}`,
        sourceTitle: input.product.name
      }],
      conflicts: input.conflicts ?? [],
      answerGuidance: {
        directAnswer: '',
        completeness: 'answered',
        coverage: []
      },
      summaryForAnswer: '',
      warnings: [],
      targetProductNames: [input.product.name],
      comparisonAttributes: [input.attribute]
    },
    warnings: []
  };
}

function catalogResult(products: Product[]): ToolResult {
  return {
    requestId: 'catalog-search',
    tool: 'catalog.search',
    status: 'ok',
    payload: { products },
    warnings: []
  };
}

function nominalPowerIntent(selectionGoal: 'preliminary_fit' | 'final_fit' = 'preliminary_fit') {
  const requirement: SelectionRequirement = {
    id: 'nominal-power-minimum',
    kind: 'nominal_power_min_kw',
    value: 6,
    unit: 'kW',
    relation: 'must_have',
    role: 'hard_constraint',
    strictness: 'strict',
    evidence: 'the generator must provide at least 6 kW nominal active power',
    verification: { mode: 'product_attribute' }
  };
  const request: ToolRequest = {
    id: 'nominal-power-web',
    tool: 'web.researchProductFacts',
    args: {
      query: 'verify exact generator nominal active power',
      productNames: [],
      comparisonAttributes: ['nominal active power'],
      comparisonAttributeBindings: [{
        attribute: 'nominal active power',
        requirementId: requirement.id
      }]
    },
    rationale: 'verify nominal active power when the catalog does not prove it',
    required: true,
    coversRequirementIds: [requirement.id]
  };
  const intent = intentFor({ requirement, request });
  intent.selectionPolicy!.selectionGoal = selectionGoal;
  return { intent, requirement, request };
}

function select(input: {
  products: Product[];
  intent: AgentIntentContract;
  toolResults: ToolResult[];
}) {
  return selectProductsForVisibleCards({
    products: input.products,
    userMessage: 'Покажите только полностью подходящие варианты.',
    history: [],
    intent: input.intent,
    answerText: input.products.map((product) => product.name).join(', '),
    selectedProductIds: input.products.map((product) => product.id),
    needState: emptyNeedState(),
    toolResults: input.toolResults
  });
}

describe('generic requirement proofs', () => {
  it('binds remote-start catalog facts without treating ATS-only products as satisfied', () => {
    const remote = generator('remote', 'BISON BS6250IE', {
      запуск: 'ручной/электро/дистанционный'
    });
    const atsOnly = generator('ats-only', 'ENERGO YN143C', {
      автозапуск: 'с автозапуском',
      стартер: 'с электростартером'
    });
    const absent = generator('remote-absent', 'TEST No Remote', {
      'remote start': false
    });
    const requirement: SelectionRequirement = {
      id: 'remote-start-required',
      kind: 'remote_start_required',
      value: true,
      unit: null,
      relation: 'must_have',
      role: 'hard_constraint',
      strictness: 'strict',
      evidence: 'remote command start is mandatory',
      verification: { mode: 'product_attribute' }
    };
    const request: ToolRequest = {
      id: 'catalog-search',
      tool: 'catalog.search',
      args: { query: 'generator remote start', productIntent: 'generator' },
      rationale: 'verify remote-start product facts',
      required: true,
      coversRequirementIds: [requirement.id]
    };
    const intent = intentFor({ requirement, request });

    const proofs = buildRequirementProofs({
      intent,
      products: [remote, atsOnly, absent],
      toolResults: [catalogResult([remote, atsOnly, absent])]
    });

    expect(proofs.find((proof) => proof.productId === remote.id)).toMatchObject({
      status: 'satisfied',
      eligibilityStatus: 'satisfied',
      normalizedValue: true
    });
    expect(proofs.find((proof) => proof.productId === atsOnly.id)).toMatchObject({
      status: 'unverified',
      eligibilityStatus: 'unknown',
      normalizedValue: null
    });
    expect(proofs.find((proof) => proof.productId === absent.id)).toMatchObject({
      status: 'violated',
      eligibilityStatus: 'violated',
      normalizedValue: false
    });
  });

  it('keeps an unknown preliminary candidate for required research and excludes only a proven power violation', () => {
    const missing = generator('power-missing', 'Генератор ИСТОК АД6-О230-ВМ131Э', {});
    const violated = generator('power-violated', 'Генератор ИСТОК АД5-О230-ВМ161Э', {
      'Nominal power': '5 kW'
    });
    const { intent, requirement } = nominalPowerIntent();

    const result = select({
      products: [missing, violated],
      intent,
      toolResults: [catalogResult([missing, violated])]
    });

    expect(result.selectedProductIds).toEqual([missing.id]);
    expect(result.requirementProofs).toContainEqual(expect.objectContaining({
      requirementId: requirement.id,
      productId: missing.id,
      status: 'unverified',
      eligibilityStatus: 'unknown'
    }));
    expect(result.requirementProofs).toContainEqual(expect.objectContaining({
      requirementId: requirement.id,
      productId: violated.id,
      status: 'violated',
      eligibilityStatus: 'violated'
    }));
    expect(result.warnings).toContain('product_cards_preliminary:needs_evidence:1');
  });

  it('never treats maximum, peak, engine, or apparent power as nominal active-power proof', () => {
    const products = [
      generator('maximum-only', 'Генератор ИСТОК АД7-О230-МАКС', { 'Maximum power': '7 kW' }),
      generator('peak-only', 'Генератор ИСТОК АД7-О230-ПИК', { 'Peak output power': '7 kW' }),
      generator('engine-only', 'Генератор ИСТОК АД7-О230-ДВС', { 'Nominal engine power': '7 kW' }),
      generator('apparent-only', 'Генератор ИСТОК АД7-О230-КВА', { 'Nominal apparent power': '7 kVA' }),
      generator('nominal-active', 'Генератор ИСТОК АД65-О230-НОМ', { 'Nominal active power': '6.5 kW' })
    ];
    const { intent, requirement } = nominalPowerIntent();

    const preliminary = select({
      products,
      intent,
      toolResults: [catalogResult(products)]
    });

    expect(preliminary.selectedProductIds).toEqual(products.map((product) => product.id));
    for (const product of products.slice(0, 4)) {
      expect(preliminary.requirementProofs).toContainEqual(expect.objectContaining({
        requirementId: requirement.id,
        productId: product.id,
        status: 'unverified',
        eligibilityStatus: 'unknown'
      }));
    }
    expect(preliminary.requirementProofs).toContainEqual(expect.objectContaining({
      requirementId: requirement.id,
      productId: products[4]!.id,
      status: 'satisfied',
      eligibilityStatus: 'satisfied'
    }));

    intent.selectionPolicy!.selectionGoal = 'final_fit';
    const final = select({
      products,
      intent,
      toolResults: [catalogResult(products)]
    });
    // Under final_fit, cards without a confirmed active nominal kW stay visible as
    // preliminary candidates (unconfirmed data gap, AGENTS.md); the confirmed
    // nominal-active match remains the only proven fit.
    expect(final.selectedProductIds).toEqual(products.map((product) => product.id));
    expect(final.warnings.join('\n')).toContain('preliminary');
  });

  it('uses exact authoritative power proof, rejects its violation, and keeps conflicting proof unknown', () => {
    const product = generator('web-power', 'Генератор ИСТОК АД6-О230-ВМ131Э с АВР', {});
    const satisfiedContract = nominalPowerIntent('final_fit');
    const satisfied = select({
      products: [product],
      intent: satisfiedContract.intent,
      toolResults: [
        catalogResult([product]),
        webResult({
          requestId: satisfiedContract.request.id,
          product,
          attribute: 'Nominal active power',
          value: '6.4 kW'
        })
      ]
    });
    expect(satisfied.selectedProductIds).toEqual([product.id]);
    expect(satisfied.requirementProofs).toContainEqual(expect.objectContaining({
      productId: product.id,
      status: 'satisfied',
      eligibilityStatus: 'satisfied',
      sourceAuthority: 'authoritative_web'
    }));

    const violatedContract = nominalPowerIntent();
    const violated = select({
      products: [product],
      intent: violatedContract.intent,
      toolResults: [
        catalogResult([product]),
        webResult({
          requestId: violatedContract.request.id,
          product,
          attribute: 'Nominal active power',
          value: '5.5 kW'
        })
      ]
    });
    expect(violated.selectedProductIds).toEqual([]);
    expect(violated.requirementProofs).toContainEqual(expect.objectContaining({
      productId: product.id,
      status: 'violated',
      eligibilityStatus: 'violated',
      sourceAuthority: 'authoritative_web'
    }));

    const conflictedContract = nominalPowerIntent();
    const conflictedWeb: ToolResult = {
      requestId: conflictedContract.request.id,
      tool: 'web.researchProductFacts',
      status: 'ok',
      payload: {
        facts: ['6.4 kW', '5.5 kW'].map((value) => ({
          productName: product.name,
          attribute: 'Nominal active power',
          value,
          sourceType: 'web',
          confidence: 'high'
        }))
      },
      warnings: []
    };
    const conflicted = select({
      products: [product],
      intent: conflictedContract.intent,
      toolResults: [catalogResult([product]), conflictedWeb]
    });
    expect(conflicted.selectedProductIds).toEqual([product.id]);
    expect(conflicted.requirementProofs).toContainEqual(expect.objectContaining({
      productId: product.id,
      status: 'conflicted',
      eligibilityStatus: 'unknown',
      sourceAuthority: 'corroborated_web'
    }));

    conflictedContract.intent.selectionPolicy!.selectionGoal = 'final_fit';
    const finalConflict = select({
      products: [product],
      intent: conflictedContract.intent,
      toolResults: [catalogResult([product]), conflictedWeb]
    });
    // Conflicting web facts mean the decisive fact is unconfirmed, not that the
    // product provably violates the requirement (AGENTS.md): the candidate stays
    // visible as preliminary under final_fit.
    expect(finalConflict.selectedProductIds).toEqual([product.id]);
    expect(finalConflict.warnings.join('\n')).toContain('preliminary');
  });

  it('binds an authoritative web fact to an open-ended numeric hard requirement', () => {
    const product = generator('quiet-58', 'Генератор ИСТОК АД6-О230-ВМ131Э', {
      'Уровень шума': 'нет данных'
    });
    const requirement: SelectionRequirement = {
      id: 'noise-limit',
      kind: 'noise_max_db',
      value: 60,
      unit: 'dB',
      role: 'hard_constraint',
      strictness: 'strict',
      evidence: 'покупателю нужен уровень шума не выше 60 дБ',
      verification: {
        mode: 'typed_tool',
        toolRequestId: 'noise-web',
        tool: 'web.researchProductFacts',
        verifier: 'technical_source_review',
        bindAs: 'noise_level_db'
      }
    };
    const request: ToolRequest = {
      id: 'noise-web',
      tool: 'web.researchProductFacts',
      args: {
        query: 'уровень шума',
        productNames: [product.name],
        comparisonAttributes: ['noise level dB']
      },
      rationale: 'verify the strict noise limit',
      required: true,
      coversRequirementIds: [requirement.id]
    };
    const intent = intentFor({ requirement, request });
    const result = select({
      products: [product],
      intent,
      toolResults: [webResult({ requestId: request.id, product, attribute: 'Noise level', value: '58 dB' })]
    });

    expect(result.selectedProductIds).toEqual([product.id]);
    expect(result.requirementProofs).toContainEqual(expect.objectContaining({
      requirementId: requirement.id,
      productId: product.id,
      status: 'satisfied',
      normalizedValue: 58,
      normalizedUnit: 'db',
      sourceResultIds: [request.id],
      sourceAuthority: 'authoritative_web'
    }));
  });

  it('does not bind an explicitly different model fact to the sole catalog candidate', () => {
    const catalogProduct = generator('rd3910e', 'FIRMAN RD3910E', {});
    const differentProduct = generator('rd4910e', 'FIRMAN RD4910E', {});
    const requirement: SelectionRequirement = {
      id: 'noise-limit',
      kind: 'noise_max_db',
      value: 60,
      unit: 'dB',
      role: 'hard_constraint',
      strictness: 'strict',
      evidence: 'the selected generator must be no louder than 60 dB',
      verification: {
        mode: 'typed_tool',
        toolRequestId: 'noise-web',
        tool: 'web.researchProductFacts',
        verifier: 'technical_source_review',
        bindAs: 'noise_level_db'
      }
    };
    const request: ToolRequest = {
      id: 'noise-web',
      tool: 'web.researchProductFacts',
      args: {
        query: 'FIRMAN RD3910E noise level',
        productNames: [catalogProduct.name],
        comparisonAttributes: ['noise level dB']
      },
      rationale: 'verify the strict noise limit for the exact catalog model',
      required: true,
      coversRequirementIds: [requirement.id]
    };

    const result = select({
      products: [catalogProduct],
      intent: intentFor({ requirement, request }),
      toolResults: [webResult({
        requestId: request.id,
        product: differentProduct,
        attribute: 'Noise level',
        value: '58 dB'
      })]
    });

    expect(result.selectedProductIds).toEqual([catalogProduct.id]);
    expect(result.warnings).toContain(
      'product_cards_preliminary:unverified_web_covered_strict_requirements:1'
    );
    expect(result.requirementProofs).toContainEqual(expect.objectContaining({
      requirementId: requirement.id,
      productId: catalogProduct.id,
      status: 'unverified'
    }));
  });

  it('deterministically rejects a product when the checked value violates the limit', () => {
    const product = generator('loud-68', 'Генератор ИСТОК АД6-Т400-ВМ131Э', {});
    const requirement: SelectionRequirement = {
      id: 'noise-limit',
      kind: 'noise_max_db',
      value: 60,
      unit: 'dB',
      role: 'hard_constraint',
      strictness: 'strict',
      evidence: 'покупателю нужен уровень шума не выше 60 дБ',
      verification: {
        mode: 'typed_tool',
        toolRequestId: 'noise-web',
        tool: 'web.researchProductFacts',
        verifier: 'technical_source_review',
        bindAs: 'noise_level_db'
      }
    };
    const request: ToolRequest = {
      id: 'noise-web',
      tool: 'web.researchProductFacts',
      args: {
        query: 'уровень шума',
        productNames: [product.name],
        comparisonAttributes: ['noise level dB']
      },
      rationale: 'verify the strict noise limit',
      required: true,
      coversRequirementIds: [requirement.id]
    };
    const result = select({
      products: [product],
      intent: intentFor({ requirement, request }),
      toolResults: [webResult({ requestId: request.id, product, attribute: 'Noise level', value: '68 dB' })]
    });

    expect(result.selectedProductIds).toEqual([]);
    expect(result.requirementProofs).toContainEqual(expect.objectContaining({
      requirementId: requirement.id,
      productId: product.id,
      status: 'violated'
    }));
    expect(result.warnings).toContain('product_cards_filtered_by_requirement_proof:1');
  });

  it('does not let a high-confidence marketplace fact override conflicting catalog evidence', () => {
    const product = generator('secondary-noise', 'Generator TEST G7000', {
      'Noise level': '68 dB'
    });
    const requirement: SelectionRequirement = {
      id: 'noise-limit-secondary',
      kind: 'noise_max_db',
      value: 60,
      unit: 'dB',
      role: 'hard_constraint',
      strictness: 'strict',
      evidence: 'the generator must be no louder than 60 dB',
      verification: {
        mode: 'typed_tool',
        toolRequestId: 'noise-secondary-web',
        tool: 'web.researchProductFacts',
        verifier: 'technical_source_review',
        bindAs: 'noise_level_db'
      }
    };
    const request: ToolRequest = {
      id: 'noise-secondary-web',
      tool: 'web.researchProductFacts',
      args: {
        query: 'Generator TEST G7000 noise level',
        productNames: [product.name],
        comparisonAttributes: ['noise level dB']
      },
      rationale: 'resolve catalog and web noise evidence',
      required: true,
      coversRequirementIds: [requirement.id]
    };

    const result = select({
      products: [product],
      intent: intentFor({ requirement, request }),
      toolResults: [webResult({
        requestId: request.id,
        product,
        attribute: 'Noise level',
        value: '58 dB',
        confidence: 'high',
        sourceUrl: 'https://marketplace.example/generator-test-g7000',
        conflicts: [{
          productName: product.name,
          attribute: 'Noise level',
          catalogValue: '68 dB',
          webValues: ['58 dB'],
          resolution: 'sources disagree'
        }]
      })]
    });

    expect(result.requirementProofs).toContainEqual(expect.objectContaining({
      requirementId: requirement.id,
      productId: product.id,
      status: 'conflicted',
      sourceAuthority: 'corroborated_web'
    }));
  });

  it('uses an authoritative phase proof over a conflicting catalog field and keeps the caveat', () => {
    const product = generator('istok-single', 'Дизельный генератор ИСТОК АД6-О230-ВМ131Э с АВР', {
      'Номинальное напряжение': '230/400 В',
      'Количество фаз': '3'
    });
    const requirement: SelectionRequirement = {
      id: 'single-phase',
      kind: 'phase',
      value: 'single_phase',
      unit: null,
      role: 'hard_constraint',
      strictness: 'strict',
      evidence: 'покупателю нужен однофазный генератор 230 В',
      verification: {
        mode: 'typed_tool',
        toolRequestId: 'phase-web',
        tool: 'web.researchProductFacts',
        verifier: 'technical_source_review',
        bindAs: 'phase'
      }
    };
    const request: ToolRequest = {
      id: 'phase-web',
      tool: 'web.researchProductFacts',
      args: {
        query: 'фазность генератора',
        productNames: [product.name],
        comparisonAttributes: ['phase']
      },
      rationale: 'resolve the conflicting phase fields',
      required: true,
      coversRequirementIds: [requirement.id]
    };
    const result = select({
      products: [product],
      intent: intentFor({ requirement, request, phase: 'single_phase' }),
      toolResults: [webResult({
        requestId: request.id,
        product,
        attribute: 'Фазность',
        value: 'однофазный, 230 В',
        conflicts: [{
          productName: product.name,
          attribute: 'Фазность',
          catalogValue: '230/400 В',
          webValues: ['однофазный, 230 В'],
          resolution: 'официальная документация подтверждает однофазное исполнение'
        }]
      })]
    });

    expect(result.selectedProductIds).toEqual([product.id]);
    const proof = result.requirementProofs.find((item) =>
      item.requirementId === requirement.id && item.productId === product.id
    );
    expect(proof).toMatchObject({
      status: 'satisfied',
      normalizedValue: 'single_phase',
      sourceAuthority: 'authoritative_web'
    });
    expect(proof?.caveats.some((caveat) => caveat.includes('в каталоге есть противоречащее значение'))).toBe(true);
    const cards = productCards(result.products, [], result.productCaveatsById);
    expect(cards[0]?.caveats.some((caveat) => caveat.includes('более авторитетные данные'))).toBe(true);
  });

  it('keeps a visible generator card when authoritative web proof confirms missing catalog autostart data', () => {
    const product = generator('web-autostart', 'Generator TEST G7000', {});
    const requirement: SelectionRequirement = {
      id: 'autostart-required',
      kind: 'autostart_required',
      value: true,
      unit: null,
      relation: 'must_have',
      role: 'hard_constraint',
      strictness: 'strict',
      evidence: 'the buyer requires automatic start',
      verification: {
        mode: 'typed_tool',
        toolRequestId: 'autostart-web',
        tool: 'web.researchProductFacts',
        verifier: 'technical_source_review',
        bindAs: 'auto_start'
      }
    };
    const request: ToolRequest = {
      id: 'autostart-web',
      tool: 'web.researchProductFacts',
      args: {
        query: 'Generator TEST G7000 automatic start',
        productNames: [product.name],
        comparisonAttributes: ['automatic start']
      },
      rationale: 'verify automatic start for the exact catalog model',
      required: true,
      coversRequirementIds: [requirement.id]
    };

    const result = select({
      products: [product],
      intent: intentFor({ requirement, request }),
      toolResults: [webResult({
        requestId: request.id,
        product,
        attribute: 'automatic start',
        value: 'yes'
      })]
    });

    expect(result.selectedProductIds).toEqual([product.id]);
    expect(result.requirementProofs).toContainEqual(expect.objectContaining({
      requirementId: requirement.id,
      productId: product.id,
      status: 'satisfied',
      normalizedValue: true,
      sourceAuthority: 'authoritative_web'
    }));
  });

  it('drops a catalog autostart candidate when authoritative web proof establishes a hard conflict', () => {
    const product = generator('catalog-ats', 'Generator TEST G7000 ATS', {
      'Automatic start': 'yes'
    });
    const requirement: SelectionRequirement = {
      id: 'autostart-required',
      kind: 'autostart_required',
      value: true,
      unit: null,
      relation: 'must_have',
      role: 'hard_constraint',
      strictness: 'strict',
      evidence: 'the buyer requires automatic start',
      verification: {
        mode: 'typed_tool',
        toolRequestId: 'autostart-web',
        tool: 'web.researchProductFacts',
        verifier: 'technical_source_review',
        bindAs: 'auto_start'
      }
    };
    const request: ToolRequest = {
      id: 'autostart-web',
      tool: 'web.researchProductFacts',
      args: {
        query: 'Generator TEST G7000 ATS automatic start',
        productNames: [product.name],
        comparisonAttributes: ['automatic start']
      },
      rationale: 'resolve the automatic-start conflict for the exact model',
      required: true,
      coversRequirementIds: [requirement.id]
    };

    const result = select({
      products: [product],
      intent: intentFor({ requirement, request }),
      toolResults: [webResult({
        requestId: request.id,
        product,
        attribute: 'automatic start',
        value: 'no'
      })]
    });

    expect(result.selectedProductIds).toEqual([]);
    expect(result.requirementProofs).toContainEqual(expect.objectContaining({
      requirementId: requirement.id,
      productId: product.id,
      status: 'violated',
      sourceAuthority: 'authoritative_web'
    }));
  });

  it('binds a catalog field through the same proof contract', () => {
    const product = generator('honda-engine', 'Бензиновый генератор ИСТОК АБ6-О230', {
      'Модель двигателя': 'Honda GX390'
    });
    const requirement: SelectionRequirement = {
      id: 'engine-model',
      kind: 'engine_model',
      value: 'Honda GX390',
      unit: null,
      role: 'hard_constraint',
      strictness: 'strict',
      evidence: 'нужен двигатель Honda GX390',
      verification: {
        mode: 'typed_tool',
        toolRequestId: 'catalog-details',
        tool: 'catalog.getProductDetails',
        verifier: 'product_attribute',
        bindAs: 'engine_model'
      }
    };
    const request: ToolRequest = {
      id: 'catalog-details',
      tool: 'catalog.getProductDetails',
      args: { productIds: [product.id], productIntent: 'generator' },
      rationale: 'read the exact catalog engine field',
      required: true,
      coversRequirementIds: [requirement.id]
    };
    const catalogResult: ToolResult = {
      requestId: request.id,
      tool: request.tool,
      status: 'ok',
      payload: { products: [product], productIds: [product.id] },
      warnings: []
    };
    const result = select({
      products: [product],
      intent: intentFor({ requirement, request }),
      toolResults: [catalogResult]
    });

    expect(result.selectedProductIds).toEqual([product.id]);
    expect(result.requirementProofs).toContainEqual(expect.objectContaining({
      requirementId: requirement.id,
      productId: product.id,
      status: 'satisfied',
      normalizedValue: 'honda_gx390',
      sourceResultIds: [request.id],
      sourceAuthority: 'catalog'
    }));
  });

  it('keeps an open-text mismatch unverified instead of proving incompatibility', () => {
    const product = generator('rato-engine', 'Бензиновый генератор TEST R390', {
      'Модель двигателя': 'Rato R390'
    });
    const requirement: SelectionRequirement = {
      id: 'engine-model-open-text',
      kind: 'engine_model',
      value: 'Honda GX390',
      unit: null,
      role: 'hard_constraint',
      strictness: 'strict',
      evidence: 'нужен двигатель Honda GX390',
      verification: {
        mode: 'typed_tool',
        toolRequestId: 'catalog-details-open-text',
        tool: 'catalog.getProductDetails',
        verifier: 'product_attribute',
        bindAs: 'engine_model'
      }
    };
    const request: ToolRequest = {
      id: 'catalog-details-open-text',
      tool: 'catalog.getProductDetails',
      args: { productIds: [product.id], productIntent: 'generator' },
      rationale: 'read the exact catalog engine field',
      required: true,
      coversRequirementIds: [requirement.id]
    };
    const result = select({
      products: [product],
      intent: intentFor({ requirement, request }),
      toolResults: [{
        requestId: request.id,
        tool: request.tool,
        status: 'ok',
        payload: { products: [product], productIds: [product.id] },
        warnings: []
      }]
    });

    expect(result.selectedProductIds).toEqual([product.id]);
    expect(result.requirementProofs).toContainEqual(expect.objectContaining({
      requirementId: requirement.id,
      productId: product.id,
      status: 'unverified',
      eligibilityStatus: 'unknown',
      normalizedValue: 'rato_r390'
    }));
  });

  it('binds a Russian catalog paving-mat field to a strict protective-mat requirement', () => {
    const withPavingMat = {
      ...generator('masalta-mat', 'Виброплита бензиновая Masalta MSR90-4 (83 кг)', {
        'рабочая масса, кг': '83',
        'коврик для мощения брусчатки': 'Да'
      }),
      category: 'Виброплиты'
    };
    const withoutPavingMat = {
      ...generator('plate-without-mat', 'Виброплита прямоходная Zitrek z3k60 (57 кг)', {
        'рабочая масса, кг': '57',
        'коврик для мощения брусчатки': 'Нет'
      }),
      category: 'Виброплиты'
    };
    const requirement: SelectionRequirement = {
      id: 'protective-mat-for-paving',
      kind: 'protective_mat_for_paving',
      value: true,
      unit: null,
      relation: 'must_have',
      role: 'hard_constraint',
      strictness: 'strict',
      evidence: 'для бережной работы по плитке нужен подтверждённый коврик',
      verification: { mode: 'product_attribute' }
    };
    const request: ToolRequest = {
      id: 'plate-details',
      tool: 'catalog.getProductDetails',
      args: {
        productIds: [withPavingMat.id, withoutPavingMat.id],
        productIntent: 'виброплита',
        canonicalProductIntent: 'plate'
      },
      rationale: 'read the exact catalog paving-mat field',
      required: true,
      coversRequirementIds: [requirement.id]
    };
    const intent = intentFor({ requirement, request });
    intent.selectionPolicy = {
      ...intent.selectionPolicy!,
      targetProductClass: 'виброплита',
      canonicalProductClass: 'plate',
      powerSource: 'any'
    };
    const catalogResult: ToolResult = {
      requestId: request.id,
      tool: request.tool,
      status: 'ok',
      payload: {
        products: [withPavingMat, withoutPavingMat],
        productIds: [withPavingMat.id, withoutPavingMat.id]
      },
      warnings: []
    };

    const result = select({
      products: [withPavingMat, withoutPavingMat],
      intent,
      toolResults: [catalogResult]
    });

    expect(result.selectedProductIds).toEqual([withPavingMat.id]);
    expect(result.requirementProofs).toContainEqual(expect.objectContaining({
      requirementId: requirement.id,
      productId: withPavingMat.id,
      status: 'satisfied',
      normalizedValue: true,
      sourceResultIds: [request.id],
      sourceAuthority: 'catalog'
    }));
    expect(result.requirementProofs).toContainEqual(expect.objectContaining({
      requirementId: requirement.id,
      productId: withoutPavingMat.id,
      status: 'violated',
      normalizedValue: false
    }));
  });

  it('does not treat a numeric model index as a conflicting voltage', () => {
    const product = generator('tss-5000a', 'TSS SGG 5000A', {
      'Номинальное напряжение': '220 V'
    });
    const requirement: SelectionRequirement = {
      id: 'voltage-220',
      kind: 'voltage_v',
      value: 220,
      unit: 'V',
      role: 'hard_constraint',
      strictness: 'strict',
      evidence: 'покупателю нужен генератор на 220 В',
      verification: {
        mode: 'typed_tool',
        toolRequestId: 'catalog-voltage',
        tool: 'catalog.getProductDetails',
        verifier: 'product_attribute',
        bindAs: 'voltage_v'
      }
    };
    const request: ToolRequest = {
      id: 'catalog-voltage',
      tool: 'catalog.getProductDetails',
      args: { productIds: [product.id], productIntent: 'generator' },
      rationale: 'read the exact catalog voltage field',
      required: true,
      coversRequirementIds: [requirement.id]
    };
    const catalogResult: ToolResult = {
      requestId: request.id,
      tool: request.tool,
      status: 'ok',
      payload: { products: [product], productIds: [product.id] },
      warnings: []
    };

    const result = select({
      products: [product],
      intent: intentFor({ requirement, request, phase: 'single_phase' }),
      toolResults: [catalogResult]
    });

    expect(result.selectedProductIds).toEqual([product.id]);
    expect(result.requirementProofs).toContainEqual(expect.objectContaining({
      requirementId: requirement.id,
      productId: product.id,
      status: 'satisfied',
      normalizedValue: 220,
      normalizedUnit: 'v'
    }));
  });

  it('does not treat 220 inside a four-digit model index as proof of single phase', () => {
    const product = generator('tss-2200a', 'Generator TSS SGG 2200A', {});
    expect(generatorPhaseProfile(product)).toBe('unknown');

    const requirement: SelectionRequirement = {
      id: 'single-phase',
      kind: 'phase',
      value: 'single_phase',
      unit: null,
      role: 'hard_constraint',
      strictness: 'strict',
      evidence: 'покупателю нужен однофазный генератор',
      verification: {
        mode: 'typed_tool',
        toolRequestId: 'catalog-phase',
        tool: 'catalog.getProductDetails',
        verifier: 'product_attribute',
        bindAs: 'phase'
      }
    };
    const request: ToolRequest = {
      id: 'catalog-phase',
      tool: 'catalog.getProductDetails',
      args: { productIds: [product.id], productIntent: 'generator' },
      rationale: 'read a real phase field rather than infer it from the model index',
      required: true,
      coversRequirementIds: [requirement.id]
    };
    const catalogResult: ToolResult = {
      requestId: request.id,
      tool: request.tool,
      status: 'ok',
      payload: { products: [product], productIds: [product.id] },
      warnings: []
    };

    const result = select({
      products: [product],
      intent: intentFor({ requirement, request, phase: 'single_phase' }),
      toolResults: [catalogResult]
    });

    expect(result.selectedProductIds).toEqual([]);
    expect(result.requirementProofs).toContainEqual(expect.objectContaining({
      requirementId: requirement.id,
      productId: product.id,
      status: 'unverified'
    }));
  });
});

describe('visible product identity deduplication', () => {
  it('shows one card for duplicate catalog rows with the same normalized product identity', () => {
    const first = generator('duplicate-1', 'Дизельный генератор ИСТОК АД6-Т400-ВМ131Э с АВР', {});
    const second = { ...first, id: 'duplicate-2', sourceUrl: 'https://bakautprof.ru/catalog/duplicate-2' };
    const request: ToolRequest = {
      id: 'catalog-search',
      tool: 'catalog.search',
      args: { query: 'ИСТОК АД6-Т400-ВМ131Э', productIntent: 'generator' },
      rationale: 'find exact catalog variants',
      required: true
    };
    const intent = intentFor({
      requirement: {
        id: 'product-class',
        kind: 'product_class',
        value: 'generator',
        unit: null,
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'buyer needs a generator'
      },
      request
    });
    const result = select({ products: [first, second], intent, toolResults: [] });

    expect(result.selectedProductIds).toEqual([first.id]);
    expect(result.droppedProductIds).toContain(second.id);
    expect(result.warnings).toContain('product_cards_deduplicated_by_product_identity:1');
    expect(productCards([first, second])).toHaveLength(1);
  });
});
