import type { AgentTurnContract } from '../shared/types.js';

export type LlmFastTurnRouteName = 'none' | 'catalog_selection' | 'commercial_handoff';
export type LlmFastTurnPricePolicy = 'none' | 'visible_cards_only';

export type LlmFastTurnDecision = {
  route: LlmFastTurnRouteName;
  confidence: number;
  rationale: string;
  answerTask: AgentTurnContract['answerTask'];
  taskType: NonNullable<AgentTurnContract['taskType']>;
  catalogAction: NonNullable<AgentTurnContract['catalogAction']>;
  commercialAction: NonNullable<AgentTurnContract['commercialAction']>;
  productCardsPolicy: NonNullable<AgentTurnContract['productCardsPolicy']>;
  cardsRole: AgentTurnContract['cardsRole'];
  leadAllowed: boolean;
  leadAllowedReason: string;
  currentFocus: string;
  mustAnswerNow: string[];
  answerGuidance: string;
  pricePolicy: LlmFastTurnPricePolicy;
  usePriorShownCards: boolean;
  needsCatalogSelection: boolean;
  createLeadIfContactPresent: boolean;
  warnings: string[];
};

export type LlmFastTurnAnswerContract = {
  answer: string;
  leadRequested: boolean;
  namedProductIds: string[];
  factsUsed: string[];
  safetyNotes: string[];
  rationale: string;
};

export const LLM_FAST_TURN_MIN_CONFIDENCE = 0.62;

export const llmFastTurnRouteTextFormat = {
  format: {
    type: 'json_schema',
    name: 'llm_fast_turn_route',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        route: { type: 'string', enum: ['none', 'catalog_selection', 'commercial_handoff'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        rationale: { type: 'string' },
        answerTask: { type: 'string', enum: ['technical_explanation', 'comparison', 'product_selection', 'mixed', 'lead_handoff'] },
        taskType: {
          type: 'string',
          enum: [
            'pure_delivery',
            'pure_availability',
            'product_selection',
            'product_selection_with_delivery',
            'product_selection_with_availability',
            'technical_answer',
            'comparison',
            'contact_refusal_continue_selection'
          ]
        },
        catalogAction: { type: 'string', enum: ['none', 'exact_model_lookup', 'find_matching_products', 'verify_catalog_absence'] },
        commercialAction: { type: 'string', enum: ['none', 'explain_manager_required', 'offer_contact_after_answer'] },
        productCardsPolicy: { type: 'string', enum: ['none', 'show_exact_matches', 'show_matching_products', 'supporting_only'] },
        cardsRole: { type: 'string', enum: ['none', 'supporting', 'primary'] },
        leadAllowed: { type: 'boolean' },
        leadAllowedReason: { type: 'string' },
        currentFocus: { type: 'string' },
        mustAnswerNow: { type: 'array', items: { type: 'string' } },
        answerGuidance: { type: 'string' },
        pricePolicy: { type: 'string', enum: ['none', 'visible_cards_only'] },
        usePriorShownCards: { type: 'boolean' },
        needsCatalogSelection: { type: 'boolean' },
        createLeadIfContactPresent: { type: 'boolean' },
        warnings: { type: 'array', items: { type: 'string' } }
      },
      required: [
        'route',
        'confidence',
        'rationale',
        'answerTask',
        'taskType',
        'catalogAction',
        'commercialAction',
        'productCardsPolicy',
        'cardsRole',
        'leadAllowed',
        'leadAllowedReason',
        'currentFocus',
        'mustAnswerNow',
        'answerGuidance',
        'pricePolicy',
        'usePriorShownCards',
        'needsCatalogSelection',
        'createLeadIfContactPresent',
        'warnings'
      ]
    }
  }
} as const;

export const llmFastTurnAnswerTextFormat = {
  format: {
    type: 'json_schema',
    name: 'llm_fast_turn_answer',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        answer: { type: 'string' },
        leadRequested: { type: 'boolean' },
        namedProductIds: { type: 'array', items: { type: 'string' } },
        factsUsed: { type: 'array', items: { type: 'string' } },
        safetyNotes: { type: 'array', items: { type: 'string' } },
        rationale: { type: 'string' }
      },
      required: ['answer', 'leadRequested', 'namedProductIds', 'factsUsed', 'safetyNotes', 'rationale']
    }
  }
} as const;

function clamp01(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function stringArray(value: unknown, limit = 12) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? value as T
    : fallback;
}

export function coerceLlmFastTurnDecision(value: unknown): LlmFastTurnDecision {
  const object = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const route = enumValue(object.route, ['none', 'catalog_selection', 'commercial_handoff'] as const, 'none');
  const routeDefaults = route === 'commercial_handoff'
    ? {
        answerTask: 'lead_handoff' as const,
        taskType: 'pure_delivery' as const,
        catalogAction: 'none' as const,
        commercialAction: 'explain_manager_required' as const,
        productCardsPolicy: 'none' as const,
        cardsRole: 'none' as const,
        pricePolicy: 'visible_cards_only' as const,
        usePriorShownCards: true,
        needsCatalogSelection: false
      }
    : route === 'catalog_selection'
      ? {
          answerTask: 'product_selection' as const,
          taskType: 'product_selection' as const,
          catalogAction: 'find_matching_products' as const,
          commercialAction: 'none' as const,
          productCardsPolicy: 'show_matching_products' as const,
          cardsRole: 'primary' as const,
          pricePolicy: 'visible_cards_only' as const,
          usePriorShownCards: false,
          needsCatalogSelection: true
        }
      : {
          answerTask: 'technical_explanation' as const,
          taskType: 'technical_answer' as const,
          catalogAction: 'none' as const,
          commercialAction: 'none' as const,
          productCardsPolicy: 'none' as const,
          cardsRole: 'none' as const,
          pricePolicy: 'none' as const,
          usePriorShownCards: false,
          needsCatalogSelection: false
        };
  return {
    route,
    confidence: clamp01(object.confidence, 0),
    rationale: typeof object.rationale === 'string' ? object.rationale.trim() : '',
    answerTask: enumValue(object.answerTask, ['technical_explanation', 'comparison', 'product_selection', 'mixed', 'lead_handoff'] as const, routeDefaults.answerTask),
    taskType: enumValue(object.taskType, ['pure_delivery', 'pure_availability', 'product_selection', 'product_selection_with_delivery', 'product_selection_with_availability', 'technical_answer', 'comparison', 'contact_refusal_continue_selection'] as const, routeDefaults.taskType),
    catalogAction: enumValue(object.catalogAction, ['none', 'exact_model_lookup', 'find_matching_products', 'verify_catalog_absence'] as const, routeDefaults.catalogAction),
    commercialAction: enumValue(object.commercialAction, ['none', 'explain_manager_required', 'offer_contact_after_answer'] as const, routeDefaults.commercialAction),
    productCardsPolicy: enumValue(object.productCardsPolicy, ['none', 'show_exact_matches', 'show_matching_products', 'supporting_only'] as const, routeDefaults.productCardsPolicy),
    cardsRole: enumValue(object.cardsRole, ['none', 'supporting', 'primary'] as const, routeDefaults.cardsRole),
    leadAllowed: object.leadAllowed === true,
    leadAllowedReason: typeof object.leadAllowedReason === 'string' && object.leadAllowedReason.trim()
      ? object.leadAllowedReason.trim()
      : 'LLM fast-turn route did not allow a contact handoff for this turn',
    currentFocus: typeof object.currentFocus === 'string' && object.currentFocus.trim()
      ? object.currentFocus.trim()
      : route,
    mustAnswerNow: stringArray(object.mustAnswerNow, 6),
    answerGuidance: typeof object.answerGuidance === 'string' ? object.answerGuidance.trim() : '',
    pricePolicy: enumValue(object.pricePolicy, ['none', 'visible_cards_only'] as const, routeDefaults.pricePolicy),
    usePriorShownCards: typeof object.usePriorShownCards === 'boolean' ? object.usePriorShownCards : routeDefaults.usePriorShownCards,
    needsCatalogSelection: typeof object.needsCatalogSelection === 'boolean' ? object.needsCatalogSelection : routeDefaults.needsCatalogSelection,
    createLeadIfContactPresent: object.createLeadIfContactPresent === true,
    warnings: stringArray(object.warnings, 12)
  };
}

export function coerceLlmFastTurnAnswerContract(value: unknown): LlmFastTurnAnswerContract {
  const object = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    answer: typeof object.answer === 'string' ? object.answer.trim() : '',
    leadRequested: object.leadRequested === true,
    namedProductIds: stringArray(object.namedProductIds, 24),
    factsUsed: stringArray(object.factsUsed, 24),
    safetyNotes: stringArray(object.safetyNotes, 24),
    rationale: typeof object.rationale === 'string' ? object.rationale.trim() : ''
  };
}
