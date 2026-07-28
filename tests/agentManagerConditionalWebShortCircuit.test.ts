import { describe, expect, it } from 'vitest';

import {
  catalogCandidatesSatisfyingConditionalWebRequest,
  enforceSearchBeforeTechnicalSpecialist,
  sourcePolicyMetadataFromIntent,
  webResearchResultProvesSourceExhaustion,
  reconcileNewActiveNeedProductClass
} from '../src/ai/agentManagerOrchestrator.js';
import type {
  AgentIntentContract,
  LedgerStateDelta,
  SelectionRequirement,
  ToolRequest,
  ToolResult
} from '../src/ai/agentManagerContracts.js';
import { selectionRequirementAttributeMatches } from '../src/ai/requirementProofs.js';
import type { Product } from '../src/shared/types.js';

function generator(
  id: string,
  noiseValues: string[] = []
): Product {
  return {
    id,
    name: `TEST DG ${id}`,
    brand: 'TEST',
    category: 'Generators',
    price: 100_000,
    currency: 'RUB',
    sourceUrl: `https://bakautprof.ru/catalog/${id}`,
    specs: Object.fromEntries(noiseValues.map((value, index) => [
      index === 0 ? 'Noise level' : `Sound pressure ${index}`,
      value
    ]))
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

function conditionalWebIntent(input: {
  webRequirement?: 'none' | 'buyer_requested' | 'conditional_on_catalog_gap' | 'independent_required';
  selectionGoal?: 'browse_catalog' | 'preliminary_fit' | 'final_fit';
  verification?: SelectionRequirement['verification'];
  productNames?: readonly string[];
  exactTarget?: boolean;
  needAction?: NonNullable<AgentIntentContract['selectionPolicy']>['needAction'];
  comparisonAttributes?: string[];
  comparisonAttributeBindings?: Array<{ attribute: string; requirementId: string }>;
} = {}): AgentIntentContract {
  const webRequest: ToolRequest = {
    id: 'web-noise-check',
    tool: 'web.researchProductFacts',
    args: {
      query: 'verify generator noise level',
      canonicalProductIntent: 'generator',
      productNames: input.productNames ? [...input.productNames] : [],
      comparisonAttributes: input.comparisonAttributes ?? ['noise level'],
      comparisonAttributeBindings: input.comparisonAttributeBindings ?? [{
        attribute: 'noise level',
        requirementId: 'noise-limit'
      }]
    },
    rationale: 'verify a decisive product attribute only when the catalog cannot prove it',
    required: true,
    coversRequirementIds: ['noise-limit']
  };
  return {
    userMessageSummary: 'buyer needs a quiet generator',
    dialogueUnderstanding: 'select a catalog generator with noise no higher than 60 dB',
    nextStepRationale: 'use catalog proof first and search only if a candidate remains unverified',
    requiresTools: true,
    toolRequests: [{
      id: 'catalog-search',
      tool: 'catalog.search',
      args: {
        query: 'quiet generator',
        canonicalProductIntent: 'generator'
      },
      rationale: 'find current catalog candidates',
      required: true
    }, webRequest],
    productMentions: input.exactTarget
      ? [{
          name: 'TEST DG quiet',
          role: 'target_product',
          productClass: 'generator',
          evidence: 'buyer named TEST DG quiet'
        }]
      : [],
    selectionPolicy: {
      targetProductClass: 'generator',
      canonicalProductClass: 'generator',
      selectionGoal: input.selectionGoal ?? 'preliminary_fit',
      needAction: input.needAction ?? 'open',
      alternativePolicy: 'same_class_only',
      reusePreviousCards: false,
      maxCards: 4,
      powerSource: 'any',
      phase: 'any',
      requirements: [{
        id: 'noise-limit',
        kind: 'noise_max_db',
        value: 60,
        unit: 'dB',
        relation: 'must_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'noise must be no higher than 60 dB',
        verification: input.verification ?? { mode: 'product_attribute' }
      }],
      rationale: 'typed preliminary catalog selection'
    },
    policyRuleIds: [],
    grounding: {
      taskType: 'product_selection',
      sourcePolicy: 'web_required',
      webPurpose: 'technical_specs',
      webRequirement: input.webRequirement ?? 'conditional_on_catalog_gap',
      requiredToolKinds: ['catalog.search', 'web.researchProductFacts'],
      technicalAttributes: ['noise level'],
      rationale: 'web is conditional on a catalog evidence gap'
    },
    mustNotAskQuestionIds: [],
    riskFlags: []
  };
}

function webRequest(intent: AgentIntentContract) {
  return intent.toolRequests.find((request) => request.tool === 'web.researchProductFacts')!;
}

function prematureSpecialistIntent(
  taskType: NonNullable<AgentIntentContract['grounding']>['taskType']
): AgentIntentContract {
  const intent = conditionalWebIntent();
  return {
    ...intent,
    requiresTools: true,
    toolRequests: [{
      id: 'premature-lead',
      tool: 'lead.capture',
      args: { reason: 'planner tried to escalate before searching' },
      rationale: 'premature specialist handoff',
      required: true
    }],
    grounding: {
      taskType,
      sourcePolicy: 'specialist_required',
      webPurpose: 'none',
      webRequirement: 'none',
      requiredToolKinds: ['lead.capture'],
      technicalAttributes: ['noise level'],
      rationale: 'planner requested a specialist before exhausting sources'
    },
    riskFlags: []
  };
}

function candidates(input: {
  intent: AgentIntentContract;
  products: Product[];
}) {
  return catalogCandidatesSatisfyingConditionalWebRequest({
    request: webRequest(input.intent),
    intent: input.intent,
    toolResults: [catalogResult(input.products)],
    products: input.products
  });
}

function openedNeed(
  needId: string,
  input: { activate?: boolean; productClass?: string } = {}
): LedgerStateDelta['events'][number] {
  return {
    eventType: 'need.opened',
    scope: 'need',
    payload: {
      needId,
      productClass: input.productClass ?? 'unknown',
      summary: `${needId} need`,
      constraints: [],
      openQuestions: [],
      selectedProductIds: [],
      rejectedProductIds: [],
      status: 'open',
      activate: input.activate ?? true
    },
    evidence: `buyer opened ${needId}`,
    source: 'llm_state_delta',
    status: 'active'
  };
}

describe('conditional catalog-evidence web short-circuit', () => {
  it('returns a catalog candidate only for conditional preliminary selection with a complete product-attribute proof', () => {
    const quiet = generator('quiet', ['58 dB']);
    const intent = conditionalWebIntent();

    expect(candidates({ intent, products: [quiet] }).map((product) => product.id)).toEqual([
      quiet.id
    ]);
  });

  it.each(['browse_catalog', 'final_fit'] as const)(
    'does not short-circuit for the %s selection goal',
    (selectionGoal) => {
      const quiet = generator('quiet', ['58 dB']);
      expect(candidates({
        intent: conditionalWebIntent({ selectionGoal }),
        products: [quiet]
      })).toEqual([]);
    }
  );

  it.each(['buyer_requested', 'independent_required'] as const)(
    'does not short-circuit when web research is %s',
    (webRequirement) => {
      const quiet = generator('quiet', ['58 dB']);
      expect(candidates({
        intent: conditionalWebIntent({ webRequirement }),
        products: [quiet]
      })).toEqual([]);
    }
  );

  it.each([
    ['an exact target product mention', { exactTarget: true }],
    ['explicit target product names in the web request', { productNames: ['TEST DG quiet'] }]
  ] as const)('does not short-circuit for %s', (_label, override) => {
    const quiet = generator('quiet', ['58 dB']);
    expect(candidates({
      intent: conditionalWebIntent(override),
      products: [quiet]
    })).toEqual([]);
  });

  it.each([
    ['missing', generator('missing')],
    ['violated', generator('loud', ['72 dB'])],
    ['conflicted', generator('conflicted', ['58 dB', '72 dB'])]
  ])('does not short-circuit a candidate with a %s catalog proof', (_status, product) => {
    expect(candidates({
      intent: conditionalWebIntent(),
      products: [product]
    })).toEqual([]);
  });

  it('does not short-circuit while another otherwise valid candidate still needs the covered web proof', () => {
    const proven = generator('proven', ['58 dB']);
    const unverified = generator('unverified');

    expect(candidates({
      intent: conditionalWebIntent(),
      products: [proven, unverified]
    })).toEqual([]);
  });

  it('does not short-circuit while another otherwise valid candidate has conflicting catalog evidence', () => {
    const proven = generator('proven', ['58 dB']);
    const conflicted = generator('conflicted', ['58 dB', '72 dB']);

    expect(candidates({
      intent: conditionalWebIntent(),
      products: [proven, conflicted]
    })).toEqual([]);
  });

  it('does not short-circuit when an equal-count web attribute is bound to an unrelated requirement', () => {
    const quiet = generator('quiet', ['58 dB']);
    const intent = conditionalWebIntent({
      comparisonAttributes: ['oil pressure sensor'],
      comparisonAttributeBindings: [{
        attribute: 'oil pressure sensor',
        requirementId: 'noise-limit'
      }]
    });

    expect(candidates({ intent, products: [quiet] })).toEqual([]);
  });

  it.each([
    ['engine oil pressure sensor', 'engine_model'],
    ['engine type', 'engine_model'],
    ['engine brand', 'engine_model'],
    ['wheel diameter', 'wheel_kit'],
    ['maximum power', 'nominal_power_min_kw'],
    ['nominal power', 'power_max_kw'],
    ['auto start delay', 'autostart_required'],
    ['shipping weight', 'weight_max_kg']
  ])('does not collapse compound attribute %s into broader requirement %s', (attribute, kind) => {
    expect(selectionRequirementAttributeMatches(attribute, kind)).toBe(false);
  });

  it.each([
    ['noise level', 'noise_max_db'],
    ['nominal output power', 'nominal_power_min_kw'],
    ['auto start', 'autostart_required'],
    ['operating mass', 'weight_max_kg'],
    ['engine model', 'engine_model'],
    ['wheel kit', 'wheel_kit']
  ])('keeps valid semantic binding %s -> %s', (attribute, kind) => {
    expect(selectionRequirementAttributeMatches(attribute, kind)).toBe(true);
  });

  it('does not short-circuit a requirement whose verifier is not a product attribute', () => {
    const quiet = generator('quiet', ['58 dB']);
    const intent = conditionalWebIntent({
      verification: {
        mode: 'typed_tool',
        toolRequestId: 'web-noise-check',
        tool: 'web.researchProductFacts',
        verifier: 'technical_source_review',
        bindAs: 'noise_max_db'
      }
    });

    expect(candidates({ intent, products: [quiet] })).toEqual([]);
  });

  it('keeps a preliminary candidate after authoritative web proof fills a missing native autostart field', () => {
    const product = generator('g7000');
    const intent = conditionalWebIntent({
      comparisonAttributes: ['automatic start'],
      comparisonAttributeBindings: [{
        attribute: 'automatic start',
        requirementId: 'autostart-required'
      }]
    });
    intent.selectionPolicy!.requirements = [{
      id: 'autostart-required',
      kind: 'autostart_required',
      value: true,
      unit: null,
      relation: 'must_have',
      role: 'hard_constraint',
      strictness: 'strict',
      evidence: 'automatic start is mandatory',
      verification: { mode: 'product_attribute' }
    }];
    const request = webRequest(intent);
    request.coversRequirementIds = ['autostart-required'];
    const researched: ToolResult = {
      requestId: request.id,
      tool: request.tool,
      status: 'ok',
      payload: {
        usedWebSearch: true,
        searchDisposition: 'completed',
        facts: [{
          productName: product.name,
          attribute: 'automatic start',
          value: 'yes',
          sourceType: 'web',
          confidence: 'high',
          evidence: `${product.name}: automatic start is present`,
          sourceUrl: `https://manufacturer.example/${product.id}`,
          sourceTitle: product.name
        }],
        warnings: []
      },
      warnings: []
    };

    const matched = catalogCandidatesSatisfyingConditionalWebRequest({
      request,
      intent,
      toolResults: [catalogResult([product]), researched],
      products: [product]
    });

    expect(matched.map((candidate) => candidate.id)).toEqual([product.id]);
  });
});

describe('source policy metadata for mixed conditional web execution', () => {
  it('keeps web as required when one web request ran even if another was not needed', () => {
    const intent = conditionalWebIntent();
    const notNeeded: ToolResult = {
      requestId: 'web-noise-check',
      tool: 'web.researchProductFacts',
      status: 'ok',
      payload: { searchDisposition: 'not_needed', facts: [] },
      warnings: []
    };
    const executed: ToolResult = {
      requestId: 'web-independent-check',
      tool: 'web.researchProductFacts',
      status: 'ok',
      payload: {
        searchDisposition: 'completed',
        facts: [{ attribute: 'service interval', value: '100 h' }]
      },
      warnings: []
    };

    expect(sourcePolicyMetadataFromIntent(intent, [notNeeded, executed])).toEqual({
      allowed: ['conversation_memory', 'catalog', 'web'],
      required: ['web'],
      forbidden: ['specialist'],
      webPurpose: 'technical_specs'
    });
  });

  it('uses catalog-only metadata only when every web request is a fact-free not-needed artifact', () => {
    const intent = conditionalWebIntent();
    const notNeeded: ToolResult = {
      requestId: 'web-noise-check',
      tool: 'web.researchProductFacts',
      status: 'ok',
      payload: { searchDisposition: 'not_needed', facts: [] },
      warnings: []
    };

    expect(sourcePolicyMetadataFromIntent(intent, [notNeeded])).toEqual({
      allowed: ['conversation_memory', 'catalog'],
      required: ['catalog'],
      forbidden: ['specialist'],
      webPurpose: 'none'
    });
  });
});

describe('source exhaustion proof', () => {
  const result = (sourceAttempts: unknown[]): ToolResult => ({
    requestId: 'web-exhaustion',
    tool: 'web.researchProductFacts',
    status: 'ok',
    payload: {
      usedWebSearch: true,
      searchDisposition: 'completed',
      sourcesExhausted: true,
      researchOutcome: 'exhausted',
      sourceAttempts
    },
    warnings: []
  });

  it('accepts exhaustion only with catalog and three distinct completed web tiers', () => {
    expect(webResearchResultProvesSourceExhaustion(result([
      { tier: 'catalog', outcome: 'not_found' },
      { tier: 'official_page', outcome: 'not_found', query: 'model official product page' },
      { tier: 'official_manual', outcome: 'not_found', query: 'model official manual PDF' },
      { tier: 'reliable_secondary', outcome: 'not_found', query: 'model reliable distributor specification' }
    ]))).toBe(true);
  });

  it.each([
    ['missing tier', [
      { tier: 'catalog', outcome: 'not_found' },
      { tier: 'official_page', outcome: 'not_found', query: 'official page' }
    ]],
    ['duplicate query', [
      { tier: 'catalog', outcome: 'not_found' },
      { tier: 'official_page', outcome: 'not_found', query: 'same query' },
      { tier: 'official_manual', outcome: 'not_found', query: 'same query' },
      { tier: 'reliable_secondary', outcome: 'not_found', query: 'another query' }
    ]],
    ['unread tier', [
      { tier: 'catalog', outcome: 'not_found' },
      { tier: 'official_page', outcome: 'not_found', query: 'official page' },
      { tier: 'official_manual', outcome: 'unreadable', query: 'official manual' },
      { tier: 'reliable_secondary', outcome: 'not_found', query: 'secondary source' }
    ]]
  ] as const)('rejects %s as exhaustion proof', (_label, attempts) => {
    expect(webResearchResultProvesSourceExhaustion(result([...attempts]))).toBe(false);
  });
});

describe('search before technical specialist enforcement', () => {
  it.each(['technical_answer', 'product_selection', 'comparison'] as const)(
    'repairs premature specialist escalation for %s',
    (taskType) => {
      const repaired = enforceSearchBeforeTechnicalSpecialist(prematureSpecialistIntent(taskType));

      expect(repaired).toMatchObject({
        requiresTools: true,
        grounding: {
          taskType,
          sourcePolicy: 'web_required',
          webPurpose: 'technical_specs',
          webRequirement: 'independent_required',
          requiredToolKinds: ['web.researchProductFacts']
        }
      });
      expect(repaired.toolRequests).toEqual([]);
      expect(repaired.riskFlags).toContain('planner_repaired_premature_technical_specialist');
    }
  );

  it('does not treat a phone in the current technical request as proof that search was already exhausted', () => {
    const intent = {
      ...prematureSpecialistIntent('technical_answer'),
      leadCaptureAuthorization: {
        authorized: true,
        contactSource: 'current_message' as const,
        handoffKind: 'technical_followup' as const,
        purpose: 'answer the technical question',
        buyerQuestion: 'What is the exact noise level? My phone is +7 900 000-00-11.',
        evidence: '+7 900 000-00-11',
        pendingDraftId: null
      }
    };

    const repaired = enforceSearchBeforeTechnicalSpecialist(intent);

    expect(repaired.grounding).toMatchObject({
      sourcePolicy: 'web_required',
      webRequirement: 'independent_required'
    });
    expect(repaired.toolRequests.some((request) => request.tool === 'lead.capture')).toBe(false);
  });

  it('defers an authorized lead when the same first technical turn still requires web research', () => {
    const intent = prematureSpecialistIntent('technical_answer');
    const currentQuestion = 'What is the exact noise level? My phone is +7 900 000-00-11.';
    const webRequest: ToolRequest = {
      id: 'technical-web',
      tool: 'web.researchProductFacts',
      args: {
        query: 'exact generator noise level',
        productNames: [],
        comparisonAttributes: ['noise level'],
        comparisonAttributeBindings: []
      },
      rationale: 'verify the technical fact',
      required: true
    };
    const webAndLeadIntent: AgentIntentContract = {
      ...intent,
      toolRequests: [webRequest, ...intent.toolRequests],
      grounding: {
        ...intent.grounding!,
        sourcePolicy: 'web_required',
        webPurpose: 'technical_specs',
        webRequirement: 'independent_required',
        requiredToolKinds: ['web.researchProductFacts', 'lead.capture']
      },
      leadCaptureAuthorization: {
        authorized: true,
        contactSource: 'current_message',
        handoffKind: 'technical_followup',
        purpose: 'answer the technical question',
        buyerQuestion: currentQuestion,
        evidence: '+7 900 000-00-11',
        pendingDraftId: null
      }
    };

    const repaired = enforceSearchBeforeTechnicalSpecialist(webAndLeadIntent);

    expect(repaired.toolRequests).toEqual([webRequest]);
    expect(repaired.grounding?.requiredToolKinds).toEqual(['web.researchProductFacts']);
    expect(repaired.riskFlags).toContain('planner_deferred_technical_lead_until_search_exhausted');
  });

  it('preserves a technical lead continuation only when prior exhausted handoff proof is supplied', () => {
    const intent = {
      ...prematureSpecialistIntent('technical_answer'),
      leadCaptureAuthorization: {
        authorized: true,
        contactSource: 'current_message' as const,
        handoffKind: 'technical_followup' as const,
        purpose: 'return the exhausted research result',
        buyerQuestion: 'What is the exact noise level?',
        evidence: '+7 900 000-00-11',
        pendingDraftId: null
      }
    };
    const preserved = enforceSearchBeforeTechnicalSpecialist(intent, {
      provenExhaustedHandoffContinuation: true
    });

    expect(preserved).toBe(intent);
  });

  it('repairs a first mixed technical question and phone even if the planner labels it lead_handoff', () => {
    const intent = {
      ...prematureSpecialistIntent('lead_handoff'),
      leadCaptureAuthorization: {
        authorized: true,
        contactSource: 'current_message' as const,
        handoffKind: 'technical_followup' as const,
        purpose: 'answer the technical question',
        buyerQuestion: 'What is the exact noise level?',
        evidence: '+7 900 000-00-11',
        pendingDraftId: null
      }
    };

    const repaired = enforceSearchBeforeTechnicalSpecialist(intent);

    expect(repaired.grounding).toMatchObject({
      sourcePolicy: 'web_required',
      webRequirement: 'independent_required'
    });
    expect(repaired.toolRequests.some((request) => request.tool === 'lead.capture')).toBe(false);
  });

  it.each(['availability_or_delivery'] as const)(
    'preserves specialist escalation for %s',
    (taskType) => {
      const intent = prematureSpecialistIntent(taskType);
      expect(enforceSearchBeforeTechnicalSpecialist(intent)).toBe(intent);
    }
  );

  it('preserves a nontechnical commercial lead handoff', () => {
    const intent = prematureSpecialistIntent('lead_handoff');
    intent.grounding = {
      ...intent.grounding!,
      technicalAttributes: [],
      rationale: 'buyer requests a commercial callback'
    };
    expect(enforceSearchBeforeTechnicalSpecialist(intent)).toBe(intent);
  });
});

describe('new active need product-class reconciliation', () => {
  it('reconciles one newly opened active unknown need and its same-need events to the planner class', () => {
    const delta: LedgerStateDelta = {
      rationale: 'open the generator need and record its hard requirement',
      events: [openedNeed('new-generator'), {
        eventType: 'fact.confirmed',
        scope: 'dialogue',
        payload: {
          factKey: 'generator.phase',
          value: 'three_phase',
          needId: 'new-generator',
          productClass: 'unknown',
          role: 'hard_requirement'
        },
        evidence: 'buyer needs three phase',
        source: 'llm_state_delta',
        status: 'active'
      }, {
        eventType: 'fact.confirmed',
        scope: 'dialogue',
        payload: {
          factKey: 'unrelated.context',
          value: true,
          needId: 'other-need',
          productClass: 'unknown',
          role: 'context'
        },
        evidence: 'unrelated context',
        source: 'llm_state_delta',
        status: 'active'
      }]
    };

    const result = reconcileNewActiveNeedProductClass(delta, conditionalWebIntent());

    expect(result.repairedNeedId).toBe('new-generator');
    expect(result.delta.events.map((event) => event.payload.productClass)).toEqual([
      'generator',
      'generator',
      'unknown'
    ]);
    expect(delta.events.map((event) => event.payload.productClass)).toEqual([
      'unknown',
      'unknown',
      'unknown'
    ]);
  });

  it('does not guess between multiple newly opened active unknown needs', () => {
    const delta: LedgerStateDelta = {
      rationale: 'the reducer ambiguously opened two active needs',
      events: [openedNeed('first'), openedNeed('second')]
    };

    expect(reconcileNewActiveNeedProductClass(delta, conditionalWebIntent())).toEqual({
      delta,
      repairedNeedId: undefined
    });
  });

  it.each(['continue', 'resume', 'close', 'none'] as const)(
    'does not reconcile a new need for the %s planner action',
    (needAction) => {
      const delta: LedgerStateDelta = {
        rationale: 'a need event must agree with the planner lifecycle action',
        events: [openedNeed('new-generator')]
      };

      expect(reconcileNewActiveNeedProductClass(
        delta,
        conditionalWebIntent({ needAction })
      )).toEqual({ delta, repairedNeedId: undefined });
    }
  );

  it('does not reconcile an inactive or already-classified need', () => {
    const delta: LedgerStateDelta = {
      rationale: 'neither event is a single active unknown need',
      events: [
        openedNeed('inactive', { activate: false }),
        openedNeed('classified', { productClass: 'plate' })
      ]
    };

    expect(reconcileNewActiveNeedProductClass(delta, conditionalWebIntent())).toEqual({
      delta,
      repairedNeedId: undefined
    });
  });
});
