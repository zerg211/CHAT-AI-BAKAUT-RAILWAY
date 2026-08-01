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
        sourceUrl: `https://manufacturer.example/${input.product.id}`,
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

    expect(result.selectedProductIds).toEqual([]);
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
