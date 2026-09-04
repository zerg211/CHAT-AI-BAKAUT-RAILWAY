import {
  AgentIntentContractSchema,
  ToolResultSchema,
  canonicalToolObservationStatus,
  normalizeToolObservation
} from '../src/ai/agentManagerContracts.js';
import { evaluateAgentManagerPolicyGate } from '../src/ai/agentManagerPolicyGate.js';
import {
  expectedResearchGuidanceText,
  researchGuidanceSemanticallySatisfied
} from '../src/ai/agentManagerOrchestrator.js';
import {
  buildPublicCustomerResponse,
  guardCustomerOutput
} from '../src/ai/agentManagerOutputGuard.js';

function intent(overrides: Record<string, unknown> = {}) {
  return AgentIntentContractSchema.parse({
    turnId: null,
    userMessageSummary: 'Проверить точную модель',
    dialogueUnderstanding: 'Покупатель просит фактическую проверку.',
    nextStepRationale: 'Сначала использовать typed evidence.',
    requiresTools: true,
    toolRequests: [],
    productMentions: [],
    selectionPolicy: undefined,
    leadCaptureAuthorization: undefined,
    policyRuleIds: [],
    mustNotAskQuestionIds: [],
    riskFlags: [],
    grounding: {
      taskType: 'technical_answer',
      sourcePolicy: 'catalog_required',
      webPurpose: 'technical_specs',
      webRequirement: 'conditional_on_catalog_gap',
      requiredToolKinds: ['catalog.getProductDetails'],
      technicalAttributes: ['мощность'],
      buyerQuestion: 'Какая мощность?',
      rationale: 'Карточка каталога является первым источником.'
    },
    ...overrides
  });
}

describe('runtime harness contracts', () => {
  it.each([
    {
      attribute: 'manual_starter', value: 'absent', evidence: 'No manual starter is fitted.',
      directAnswer: 'У SUNREKA G7000iS подтверждён электрический запуск.',
      answerText: 'У SUNREKA G7000iS нет ручного стартера; есть электрический запуск.'
    },
    {
      attribute: 'document_kind', value: 'owner manual', evidence: 'The owner manual describes electric starting.',
      directAnswer: 'В руководстве SUNREKA G7000iS описан электрический запуск.',
      answerText: 'SUNREKA G7000iS запускается электростартером. Само руководство не подтверждает ручной стартер.'
    },
    {
      attribute: 'manual_starter', value: 'present', evidence: 'The model is fitted with a recoil starter.',
      directAnswer: 'У SUNREKA G7000iS подтверждён ручной стартер.',
      answerText: 'У SUNREKA G7000iS ручной стартер есть, а у другой модели ручного стартера нет.'
    }
  ])('preserves the grounded value and product scope for $attribute=$value', ({ attribute, value, evidence, directAnswer, answerText }) => {
    const researchIntent = intent({
      productMentions: [{ name: 'SUNREKA G7000iS', role: 'target_product', evidence: 'SUNREKA G7000iS', productClass: 'generator' }]
    });
    const result = ToolResultSchema.parse({
      requestId: 'web-polarity', tool: 'web.researchProductFacts', status: 'ok', warnings: [],
      payload: {
        targetProductNames: ['SUNREKA G7000iS'], researchOutcome: 'answered',
        answerGuidance: {
          directAnswer, completeness: 'answered',
          coverage: [{ productName: 'SUNREKA G7000iS', attribute, status: 'confirmed', value, evidence }]
        }
      }
    });

    expect(expectedResearchGuidanceText({ intent: researchIntent, toolResults: [result] })).toBe(directAnswer);
    expect(researchGuidanceSemanticallySatisfied({ answerText, intent: researchIntent, toolResults: [result] })).toBe(true);
  });

  it('accepts a faithful research paraphrase and rejects unverified exact-catalog absence', () => {
    const researchIntent = intent({
      userMessageSummary: 'Проверить способ запуска SUNREKA G7000iS',
      productMentions: [{
        name: 'SUNREKA G7000iS',
        role: 'target_product',
        evidence: 'генератор SUNREKA G7000iS',
        productClass: 'generator'
      }]
    });
    const result = ToolResultSchema.parse({
      requestId: 'web-sunreka-start',
      tool: 'web.researchProductFacts',
      status: 'ok',
      payload: {
        targetProductNames: ['SUNREKA G7000iS'],
        researchOutcome: 'answered',
        catalogPresence: [{ productName: 'SUNREKA G7000iS', status: 'unknown' }],
        answerGuidance: {
          directAnswer: 'У SUNREKA G7000iS подтверждены электростартер и ручной стартер; отдельную кнопку источники не подтверждают.',
          completeness: 'partially_answered',
          coverage: [
            { attribute: 'electric starter', status: 'confirmed', value: 'есть' },
            { attribute: 'manual starter', status: 'confirmed', value: 'есть' },
            { attribute: 'push-button start', status: 'not_confirmed', value: '' }
          ]
        }
      },
      warnings: []
    });
    const paraphrase = 'Проверенные источники подтверждают у SUNREKA G7000iS электрический и ручной запуск. Но отдельную кнопку запуска подтвердить не удалось.';

    expect(paraphrase).not.toBe(expectedResearchGuidanceText({
      intent: researchIntent,
      toolResults: [result]
    }));
    expect(researchGuidanceSemanticallySatisfied({
      answerText: paraphrase,
      intent: researchIntent,
      toolResults: [result]
    })).toBe(true);
    expect(researchGuidanceSemanticallySatisfied({
      answerText: 'SUNREKA G7000iS нет в каталоге.',
      intent: researchIntent,
      toolResults: [result]
    })).toBe(false);
  });

  it('normalizes legacy tool statuses into typed observations', () => {
    expect(canonicalToolObservationStatus({ status: 'ok' })).toBe('success');
    expect(canonicalToolObservationStatus({ status: 'not_found' })).toBe('not_found');
    expect(canonicalToolObservationStatus({ status: 'timeout' })).toBe('timeout');
    expect(canonicalToolObservationStatus({ status: 'error', errorCode: 'tool_execution_aborted' })).toBe('aborted');
    expect(canonicalToolObservationStatus({ status: 'error', errorCode: 'tool_result_malformed' })).toBe('malformed');
    expect(canonicalToolObservationStatus({ status: 'error', errorCode: 'conflicting_saved_tool_artifact' })).toBe('conflict');

    const normalized = normalizeToolObservation(ToolResultSchema.parse({
      requestId: 'web-1',
      tool: 'web.researchProductFacts',
      status: 'timeout',
      payload: { searchDisposition: 'timed_out' },
      warnings: []
    }));
    expect(normalized.observationStatus).toBe('timeout');
  });

  it('keeps catalog-first availability and defers conditional web research', () => {
    const result = evaluateAgentManagerPolicyGate({
      intent: intent({
        grounding: {
          taskType: 'availability_or_delivery',
          sourcePolicy: 'catalog_required',
          webPurpose: 'none',
          webRequirement: 'none',
          requiredToolKinds: ['catalog.search'],
          technicalAttributes: [],
          buyerQuestion: null,
          rationale: 'Нужно проверить каталог.'
        },
        toolRequests: [{
          id: 'catalog-1',
          tool: 'catalog.search',
          args: { query: 'точная модель' },
          rationale: 'Exact catalog lookup.',
          required: true,
          coversRequirementIds: []
        }]
      }),
      toolResults: []
    });

    expect(result.ok).toBe(true);
    expect(result.requiredActions).toContain('catalog.search');
    expect(result.requiredActions).not.toContain('web.researchProductFacts');
    expect(result.answerConstraints).toContain('catalog_presence_is_not_live_stock');
  });

  it('requires web for an explicit official-source request', () => {
    const result = evaluateAgentManagerPolicyGate({
      intent: intent({
        grounding: {
          taskType: 'technical_answer',
          sourcePolicy: 'web_required',
          webPurpose: 'technical_specs',
          webRequirement: 'buyer_requested',
          requiredToolKinds: ['web.researchProductFacts'],
          technicalAttributes: ['совместимость'],
          buyerQuestion: 'Проверьте официальный сайт',
          rationale: 'Покупатель явно запросил внешний официальный источник.'
        }
      }),
      toolResults: []
    });

    expect(result.ok).toBe(false);
    expect(result.requiredActions).toContain('web.researchProductFacts');
    expect(result.blockedReasons).toContain('required_web_tool_missing');
  });

  it('removes internal metadata from the customer response', () => {
    const response = buildPublicCustomerResponse({
      turnId: 'turn-1',
      answer: 'Проверил карточку модели.',
      needState: { activeNeeds: [{ id: 'need-1' }] },
      productCards: [{ id: 'p-1', name: 'Модель', specs: {}, reasons: [], caveats: [] }],
      cardDisplay: { initialVisibleCount: 1 },
      usedWebSearch: true,
      leadRequested: false,
      leadCreated: false,
      metadata: {
        intentContract: { toolRequests: [{ tool: 'web.researchProductFacts' }] },
        toolResults: [{ status: 'timeout' }],
        recovery: 'internal-only'
      }
    } as never);

    expect(response).toEqual({
      turnId: 'turn-1',
      answer: 'Проверил карточку модели.',
      productCards: [{ id: 'p-1', name: 'Модель', specs: {}, reasons: [], caveats: [] }],
      cardDisplay: { initialVisibleCount: 1 },
      leadRequested: false
    });
    expect(response).not.toHaveProperty('metadata');
    expect(response).not.toHaveProperty('usedWebSearch');
    expect(response).not.toHaveProperty('needState');
  });

  it('blocks internal runtime vocabulary in customer text', () => {
    const review = guardCustomerOutput({
      answerText: 'Внутренний planner получил timeout web tool и запустил recovery.',
      productCards: []
    });
    expect(review.ok).toBe(false);
    expect(review.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'customer_output_internal_vocabulary'
    ]));

    const russianProcessLeak = guardCustomerOutput({
      answerText: 'Внешняя проверка не завершилась из-за тайм-аута.',
      productCards: []
    });
    expect(russianProcessLeak.ok).toBe(false);
    expect(russianProcessLeak.issues).toContainEqual(expect.objectContaining({
      code: 'customer_output_internal_vocabulary'
    }));

    for (const answerText of [
      'The web search completed after a retry in the pipeline.',
      'Поисковый инструмент завершил повторный запрос в пайплайне.',
      'The search completed successfully.',
      'Two research attempts were required.',
      'Исследовательский инструмент подтвердил характеристику.',
      'I searched online but found nothing.',
      'I checked the manufacturer website but could not complete the check.',
      'Я поискал в интернете, но ничего не нашел.',
      'Проверить это не получилось.'
    ]) {
      expect(guardCustomerOutput({ answerText, productCards: [] }).ok).toBe(false);
    }

    expect(guardCustomerOutput({
      answerText: 'Для этой работы подойдёт аккумуляторный инструмент.',
      productCards: []
    }).ok).toBe(true);
  });

  it('does not reuse stale web guidance after the active product-selection target changes', () => {
    const currentSelection = intent({
      userMessageSummary: 'Показать любые виброплиты 100-120 кг до 180000 рублей.',
      productMentions: [],
      grounding: {
        taskType: 'product_selection',
        sourcePolicy: 'catalog_required',
        webPurpose: 'technical_specs',
        webRequirement: 'conditional_on_catalog_gap',
        requiredToolKinds: ['catalog.search'],
        technicalAttributes: [],
        buyerQuestion: null,
        rationale: 'Текущий запрос заменил прежнюю точную модель каталоговым подбором.'
      }
    });
    const staleWebResult = ToolResultSchema.parse({
      requestId: 'web-stale-bps1550',
      tool: 'web.researchProductFacts',
      status: 'ok',
      payload: {
        targetProductNames: ['Wacker Neuson BPS 1550 Gw-c CE'],
        researchOutcome: 'partial',
        answerGuidance: {
          directAnswer: 'Для Wacker Neuson BPS 1550 Gw-c CE глубина не подтверждена.',
          coverage: [{ attribute: 'depth', status: 'not_confirmed' }]
        }
      },
      warnings: []
    });

    expect(expectedResearchGuidanceText({
      intent: currentSelection,
      toolResults: [staleWebResult]
    })).toBe('');
  });

});
