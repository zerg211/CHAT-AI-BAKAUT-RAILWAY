import { config } from '../config.js';
import { ConversationRepository, LeadRepository, ProductRepository } from '../db/repositories.js';
import type { ChatResponsePayload, ConversationSession, CustomerNeedState, Message, Product, ProductCard, ProductElectricalLoadItem, ProductSelectionClass } from '../shared/types.js';
import {
  AgentIntentContractSchema,
  AnswerContractSchema,
  LedgerStateDeltaSchema,
  PreSendReviewSchema,
  ToolResultSchema,
  normalizeLedgerStateDeltaEvents,
  type AgentIntentContract,
  type AnswerContract,
  type DialogueLedgerEvent,
  type LedgerStateDelta,
  type PreSendReview,
  type ToolRequest,
  type ToolResult
} from './agentManagerContracts.js';
import { deriveNeedStateSnapshotFromLedger, reduceDialogueLedger, type ReducedDialogueLedgerState } from './dialogueLedgerReducer.js';
import { calculateGeneratorLoadProfile } from './loadProfile.js';
import { createEmbedding } from './openaiClient.js';
import { createStructuredJsonResponse } from './openaiStructured.js';
import { researchProductComparisonFacts } from './productComparisonResearch.js';
import { inferProductIntent, isCoreEquipment, productMatchesIntent, productMentionedInText } from './productClassifier.js';
import { emptyNeedState } from './needState.js';
import { safeError } from './responseUtils.js';

export interface AgentManagerGenerateInput {
  sessionId: string;
  userMessage: string;
  turnId?: string;
  skipUserMessage?: boolean;
  onDelta?: (text: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface AgentManagerRecoverInput {
  sessionId: string;
  turnId: string;
  onDelta?: (text: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface AgentManagerModel {
  proposeLedgerDelta(input: AgentManagerModelInput): Promise<LedgerStateDelta>;
  planTurn(input: AgentManagerModelInput & { ledgerState: ReducedDialogueLedgerState }): Promise<AgentIntentContract>;
  composeAnswer(input: AgentManagerAnswerInput): Promise<AnswerContract>;
  reviewAnswer(input: AgentManagerReviewInput): Promise<PreSendReview>;
}

export interface AgentManagerModelInput {
  session: ConversationSession;
  history: Message[];
  userMessage: string;
  ledgerEvents: DialogueLedgerEvent[];
  signal?: AbortSignal;
}

export interface AgentManagerAnswerInput extends AgentManagerModelInput {
  ledgerState: ReducedDialogueLedgerState;
  intent: AgentIntentContract;
  toolResults: ToolResult[];
  products: Product[];
}

export interface AgentManagerReviewInput extends AgentManagerAnswerInput {
  answer: AnswerContract;
}

function compactHistory(history: Message[]) {
  return history.slice(-12).map((message) => ({
    role: message.role,
    content: message.content,
    createdAt: message.createdAt
  }));
}

function compactLedger(state: ReducedDialogueLedgerState) {
  return {
    facts: Object.values(state.factsByKey).map((fact) => ({
      key: fact.factKey,
      value: fact.value,
      status: fact.status,
      evidence: fact.evidence,
      eventId: fact.eventId
    })),
    openQuestions: state.openQuestions.map((question) => ({
      questionId: question.questionId,
      text: question.text,
      status: question.status
    })),
    questions: Object.values(state.questionsById).map((question) => ({
      questionId: question.questionId,
      text: question.text,
      status: question.status,
      answer: question.answer
    }))
  };
}

type DialogueLedgerRow = {
  session_id: string;
  turn_id: string;
  event_id: string;
  event_type: DialogueLedgerEvent['eventType'];
  scope: DialogueLedgerEvent['scope'];
  payload: Record<string, unknown>;
  evidence: string;
  source: DialogueLedgerEvent['source'];
  status: DialogueLedgerEvent['status'];
  created_at?: string | Date | null;
};

function createdAtText(value: unknown) {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object' && 'toISOString' in value && typeof value.toISOString === 'function') {
    return value.toISOString();
  }
  return undefined;
}

function mapLedgerRows(rows: DialogueLedgerRow[]): DialogueLedgerEvent[] {
  return rows.map((row) => ({
    sessionId: row.session_id,
    turnId: row.turn_id,
    eventId: row.event_id,
    eventType: row.event_type,
    scope: row.scope,
    payload: row.payload,
    evidence: row.evidence,
    source: row.source,
    status: row.status,
    createdAt: createdAtText(row.created_at)
  }));
}

function productCards(products: Product[], reasons: string[] = []): ProductCard[] {
  return products.map((product) => ({
    id: product.id,
    name: product.name,
    brand: product.brand,
    category: product.category,
    price: product.price,
    currency: product.currency,
    imageUrl: product.imageUrl,
    sourceUrl: product.sourceUrl,
    specs: product.specs ?? {},
    reasons,
    caveats: []
  }));
}

function uniqueProducts(products: Product[]) {
  const seen = new Set<string>();
  const unique: Product[] = [];
  for (const product of products) {
    if (seen.has(product.id)) continue;
    seen.add(product.id);
    unique.push(product);
  }
  return unique;
}

function latestActiveNeedProductClass(needState: CustomerNeedState): ProductSelectionClass {
  const classes = (needState.activeNeeds ?? [])
    .map((need) => need.productClass)
    .filter((value): value is ProductSelectionClass => value !== 'commercial' && value !== 'unknown');
  return classes.length ? classes[classes.length - 1] : 'unknown';
}

function toolRequestSemanticText(intent: AgentIntentContract) {
  return intent.toolRequests.map((request) => {
    const args = request.args as Record<string, unknown>;
    const productNames = Array.isArray(args.productNames) ? args.productNames.filter((item): item is string => typeof item === 'string') : [];
    const comparisonAttributes = Array.isArray(args.comparisonAttributes) ? args.comparisonAttributes.filter((item): item is string => typeof item === 'string') : [];
    return [
      request.rationale,
      typeof args.query === 'string' ? args.query : '',
      typeof args.reason === 'string' ? args.reason : '',
      typeof args.notes === 'string' ? args.notes : '',
      productNames.join(' '),
      comparisonAttributes.join(' ')
    ].filter(Boolean).join(' ');
  }).join('\n');
}

function inferVisibleCardIntent(input: {
  userMessage: string;
  history: Message[];
  intent: AgentIntentContract;
  answerText: string;
  needState: CustomerNeedState;
}): ProductSelectionClass {
  const recentHistory = input.history
    .slice(-6)
    .map((message) => message.content)
    .join('\n');
  const semanticText = [
    recentHistory,
    input.userMessage,
    input.intent.userMessageSummary,
    input.intent.dialogueUnderstanding,
    input.intent.nextStepRationale,
    toolRequestSemanticText(input.intent),
    input.answerText
  ].filter(Boolean).join('\n');
  const textIntent = inferProductIntent(semanticText);
  return textIntent !== 'unknown' ? textIntent : latestActiveNeedProductClass(input.needState);
}

function selectProductsForVisibleCards(input: {
  products: Product[];
  userMessage: string;
  history: Message[];
  intent: AgentIntentContract;
  answerText: string;
  needState: CustomerNeedState;
}) {
  const unique = uniqueProducts(input.products);
  const cardIntent = inferVisibleCardIntent(input);
  const mentioned = unique.filter((product) => productMentionedInText(product, input.answerText));
  const mentionedMatchingIntent = cardIntent === 'unknown'
    ? mentioned
    : mentioned.filter((product) => productMatchesIntent(product, cardIntent));

  let selected: Product[];
  if (mentionedMatchingIntent.length) {
    selected = mentionedMatchingIntent;
  } else if (mentioned.length && cardIntent === 'unknown') {
    selected = mentioned;
  } else if (cardIntent !== 'unknown') {
    selected = unique.filter((product) => productMatchesIntent(product, cardIntent));
  } else {
    selected = unique.filter((product) => isCoreEquipment(product));
  }

  if (cardIntent === 'unknown' && !mentioned.length) {
    selected = [];
  }

  const selectedProducts = uniqueProducts(selected).slice(0, 8);
  const selectedIds = new Set(selectedProducts.map((product) => product.id));
  const droppedProductIds = unique
    .filter((product) => !selectedIds.has(product.id))
    .map((product) => product.id);
  const warnings = droppedProductIds.length
    ? [`product_cards_filtered:${droppedProductIds.length}`]
    : [];

  return {
    intent: cardIntent,
    products: selectedProducts,
    selectedProductIds: selectedProducts.map((product) => product.id),
    answerMentionedProductIds: mentioned.map((product) => product.id),
    droppedProductIds,
    warnings
  };
}

function extractContact(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const email = normalized.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0];
  const phone = normalized.match(/(?:\+?\d[\d\s().-]{8,}\d)/u)?.[0]?.replace(/\s+/g, ' ').trim();
  const explicitName = normalized.match(/(?:меня\s+зовут|зовут|имя|я)\s+([А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]{1,30}(?:\s+[А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]{1,30})?)/iu)?.[1];
  const contactIndex = [phone ? normalized.indexOf(phone) : -1, email ? normalized.indexOf(email) : -1]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const prefixName = contactIndex !== undefined
    ? normalized.slice(0, contactIndex).match(/([А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]{1,30}(?:\s+[А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]{1,30})?)\s*(?:[,;:-])?\s*$/u)?.[1]
    : undefined;
  const name = (explicitName ?? prefixName)?.trim();
  return {
    name: name && name.length >= 2 ? name : undefined,
    phone,
    email
  };
}

function loadsFromArgs(args: Record<string, unknown>, fallbackEvidence: string): ProductElectricalLoadItem[] {
  const rawLoads = Array.isArray(args.loads) ? args.loads : [];
  return rawLoads
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    .map((item) => ({
      kind: String(item.kind ?? item.name ?? 'unknown_load'),
      name: typeof item.name === 'string' ? item.name : undefined,
      count: Math.max(1, Math.min(12, Math.round(Number(item.count ?? 1)))),
      runningKw: Number.isFinite(Number(item.runningKw)) ? Number(item.runningKw) : undefined,
      startingKw: Number.isFinite(Number(item.startingKw)) ? Number(item.startingKw) : undefined,
      source: item.source === 'web_average' || item.source === 'catalog_fact' || item.source === 'estimated_average'
        ? item.source
        : 'explicit_user',
      evidence: typeof item.evidence === 'string' && item.evidence.trim() ? item.evidence : fallbackEvidence
    }));
}

const nullableStringJsonSchema = { type: ['string', 'null'] } as const;
const nullableNumberJsonSchema = { type: ['number', 'null'] } as const;
const nullableBooleanJsonSchema = { type: ['boolean', 'null'] } as const;
const stringArrayJsonSchema = { type: 'array', items: { type: 'string' } } as const;
const scalarValueJsonSchema = { type: ['string', 'number', 'boolean', 'null'] } as const;

const ledgerPayloadJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    factKey: nullableStringJsonSchema,
    value: scalarValueJsonSchema,
    valueText: nullableStringJsonSchema,
    unit: nullableStringJsonSchema,
    questionId: nullableStringJsonSchema,
    text: nullableStringJsonSchema,
    answer: scalarValueJsonSchema,
    answerKnown: nullableBooleanJsonSchema,
    targetEventIds: stringArrayJsonSchema,
    targetQuestionIds: stringArrayJsonSchema,
    closesQuestionIds: stringArrayJsonSchema,
    supersedesEventIds: stringArrayJsonSchema,
    negatesEventIds: stringArrayJsonSchema,
    needId: nullableStringJsonSchema,
    productId: nullableStringJsonSchema,
    productIds: stringArrayJsonSchema,
    toolRequestId: nullableStringJsonSchema,
    sourceResultId: nullableStringJsonSchema,
    notes: nullableStringJsonSchema
  },
  required: [
    'factKey',
    'value',
    'valueText',
    'unit',
    'questionId',
    'text',
    'answer',
    'answerKnown',
    'targetEventIds',
    'targetQuestionIds',
    'closesQuestionIds',
    'supersedesEventIds',
    'negatesEventIds',
    'needId',
    'productId',
    'productIds',
    'toolRequestId',
    'sourceResultId',
    'notes'
  ]
} as const;

const contactArgsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: nullableStringJsonSchema,
    phone: nullableStringJsonSchema,
    email: nullableStringJsonSchema,
    preferredContact: nullableStringJsonSchema,
    comment: nullableStringJsonSchema
  },
  required: ['name', 'phone', 'email', 'preferredContact', 'comment']
} as const;

const loadItemArgsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: nullableStringJsonSchema,
    name: nullableStringJsonSchema,
    count: nullableNumberJsonSchema,
    runningKw: nullableNumberJsonSchema,
    startingKw: nullableNumberJsonSchema,
    source: { type: ['string', 'null'], enum: ['explicit_user', 'estimated_average', 'catalog_fact', 'web_average', null] },
    evidence: nullableStringJsonSchema
  },
  required: ['kind', 'name', 'count', 'runningKw', 'startingKw', 'source', 'evidence']
} as const;

const toolArgsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: nullableStringJsonSchema,
    limit: nullableNumberJsonSchema,
    productIds: stringArrayJsonSchema,
    productNames: stringArrayJsonSchema,
    comparisonAttributes: stringArrayJsonSchema,
    loads: { type: 'array', items: loadItemArgsJsonSchema },
    simultaneousStarting: nullableBooleanJsonSchema,
    simultaneousStartingKinds: stringArrayJsonSchema,
    contact: contactArgsJsonSchema,
    reason: nullableStringJsonSchema,
    notes: nullableStringJsonSchema
  },
  required: [
    'query',
    'limit',
    'productIds',
    'productNames',
    'comparisonAttributes',
    'loads',
    'simultaneousStarting',
    'simultaneousStartingKinds',
    'contact',
    'reason',
    'notes'
  ]
} as const;

const ledgerDeltaFormat = {
  format: {
    type: 'json_schema',
    name: 'ledger_state_delta',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rationale: { type: 'string' },
        events: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              eventId: nullableStringJsonSchema,
              eventType: {
                type: 'string',
                enum: ['fact.observed', 'fact.confirmed', 'fact.superseded', 'fact.negated', 'question.asked', 'question.answered', 'question.closed', 'need.opened', 'need.updated', 'need.closed', 'tool.artifact.linked']
              },
              scope: { type: 'string', enum: ['dialogue', 'turn', 'need', 'product', 'lead', 'tool', 'question'] },
              payload: ledgerPayloadJsonSchema,
              evidence: { type: 'string' },
              source: { type: 'string', enum: ['llm_state_delta', 'tool_result', 'system_reducer', 'admin_curation', 'catalog', 'web'] },
              status: { type: 'string', enum: ['active', 'superseded', 'negated', 'closed', 'rejected'] }
            },
            required: ['eventId', 'eventType', 'scope', 'payload', 'evidence', 'source', 'status']
          }
        }
      },
      required: ['rationale', 'events']
    }
  }
} as const;

const toolRequestJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    tool: { type: 'string', enum: ['catalog.search', 'catalog.getProductDetails', 'calculator.generatorLoad', 'web.researchProductFacts', 'lead.capture'] },
    args: toolArgsJsonSchema,
    rationale: { type: 'string' },
    required: { type: 'boolean' }
  },
  required: ['id', 'tool', 'args', 'rationale', 'required']
} as const;

const intentContractFormat = {
  format: {
    type: 'json_schema',
    name: 'agent_intent_contract',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        turnId: nullableStringJsonSchema,
        userMessageSummary: { type: 'string' },
        dialogueUnderstanding: { type: 'string' },
        nextStepRationale: { type: 'string' },
        requiresTools: { type: 'boolean' },
        toolRequests: { type: 'array', items: toolRequestJsonSchema },
        mustNotAskQuestionIds: { type: 'array', items: { type: 'string' } },
        riskFlags: { type: 'array', items: { type: 'string' } }
      },
      required: ['turnId', 'userMessageSummary', 'dialogueUnderstanding', 'nextStepRationale', 'requiresTools', 'toolRequests', 'mustNotAskQuestionIds', 'riskFlags']
    }
  }
} as const;

const answerContractFormat = {
  format: {
    type: 'json_schema',
    name: 'agent_answer_contract',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        answerText: { type: 'string' },
        factsUsed: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              factKey: { type: 'string' },
              sourceEventIds: { type: 'array', items: { type: 'string' } },
              value: scalarValueJsonSchema
            },
            required: ['factKey', 'sourceEventIds', 'value']
          }
        },
        questionsAsked: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              questionId: { type: 'string' },
              text: { type: 'string' },
              reason: { type: 'string' }
            },
            required: ['questionId', 'text', 'reason']
          }
        },
        toolResultIds: { type: 'array', items: { type: 'string' } },
        leadAction: { type: 'string', enum: ['none', 'offer_form', 'capture_contact', 'confirm_contact_received'] },
        riskFlags: { type: 'array', items: { type: 'string' } }
      },
      required: ['answerText', 'factsUsed', 'questionsAsked', 'toolResultIds', 'leadAction', 'riskFlags']
    }
  }
} as const;

const preSendReviewFormat = {
  format: {
    type: 'json_schema',
    name: 'agent_pre_send_review',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        verdict: { type: 'string', enum: ['pass', 'rewrite_required', 'block'] },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              code: { type: 'string' },
              severity: { type: 'string', enum: ['low', 'medium', 'high'] },
              message: { type: 'string' },
              evidence: { type: 'string' }
            },
            required: ['code', 'severity', 'message', 'evidence']
          }
        },
        revisedAnswerText: nullableStringJsonSchema
      },
      required: ['verdict', 'issues', 'revisedAnswerText']
    }
  }
} as const;

export const agentManagerStructuredFormats = {
  ledgerDeltaFormat,
  intentContractFormat,
  answerContractFormat,
  preSendReviewFormat
} as const;

class OpenAIAgentManagerModel implements AgentManagerModel {
  async proposeLedgerDelta(input: AgentManagerModelInput): Promise<LedgerStateDelta> {
    const request = {
      model: config.OPENAI_PLANNER_MODEL,
      max_output_tokens: config.OPENAI_PLANNER_MAX_OUTPUT_TOKENS,
      input: [
        {
          role: 'system',
          content: [
            'Ты state-reducer AI менеджера БАКАУТ.',
            'Твоя задача: понять текущую реплику покупателя и историю, затем вернуть только JSON LedgerStateDelta.',
            'Не переносишь контекст из других диалогов. Не добавляешь выдуманные факты.',
            'Если покупатель ответил на уже заданный вопрос, создай question.answered/question.closed.',
            'Если покупатель изменил вводные, создай новый fact.confirmed и укажи supersedesEventIds для старого факта, если он известен.',
            'Не пиши ответ покупателю.'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            userMessage: input.userMessage,
            history: compactHistory(input.history),
            existingLedger: input.ledgerEvents.slice(-80)
          })
        }
      ],
      text: ledgerDeltaFormat
    };
    const { parsed } = await createStructuredJsonResponse({ request, stage: 'agent_ledger_delta', signal: input.signal });
    return LedgerStateDeltaSchema.parse(parsed);
  }

  async planTurn(input: AgentManagerModelInput & { ledgerState: ReducedDialogueLedgerState }): Promise<AgentIntentContract> {
    const request = {
      model: config.OPENAI_PLANNER_MODEL,
      max_output_tokens: config.OPENAI_PLANNER_MAX_OUTPUT_TOKENS,
      input: [
        {
          role: 'system',
          content: [
            'Ты планировщик AI менеджера БАКАУТ.',
            'LLM решает смысл хода без фиксированного списка сценариев.',
            'Код только исполнит typed tools, но не будет подменять твой смысл.',
            'Для доставки, наличия, скидок, сроков и индивидуальных условий не обещай точный результат: планируй lead.capture/offer form, если нужен контакт.',
            'Для сравнения товаров и нехватки важных фактов планируй web.researchProductFacts.',
            'Для подбора товара планируй catalog.search.',
            'Для расчета генератора по нагрузкам планируй calculator.generatorLoad.',
            'Не задавай вопрос, ответ на который уже есть в ledger.'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            userMessage: input.userMessage,
            history: compactHistory(input.history),
            ledger: compactLedger(input.ledgerState)
          })
        }
      ],
      text: intentContractFormat
    };
    const { parsed } = await createStructuredJsonResponse({ request, stage: 'agent_intent_contract', signal: input.signal });
    return AgentIntentContractSchema.parse(parsed);
  }

  async composeAnswer(input: AgentManagerAnswerInput): Promise<AnswerContract> {
    const request = {
      model: config.OPENAI_ANSWER_MODEL,
      max_output_tokens: config.OPENAI_MAX_OUTPUT_TOKENS,
      input: [
        {
          role: 'system',
          content: [
            'Ты AI менеджер-консультант БАКАУТ в чате сайта.',
            'Отвечай по-русски, кратко, понятно, как живой менеджер.',
            'Опирайся только на ledger, catalog/tool results, checked research facts и текущий диалог.',
            'Если точного dB, наличия, доставки, скидки или срока нет в фактах, честно скажи, что это нужно уточнить, и при необходимости предложи форму.',
            'Если контакт уже есть в текущей реплике/tool result, подтверди получение контакта и не проси его повторно.',
            'Не задавай лишних вопросов. Если вопрос нужен, он должен быть реально нужен для следующего шага.',
            'Верни только JSON AnswerContract.'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            userMessage: input.userMessage,
            history: compactHistory(input.history),
            ledger: compactLedger(input.ledgerState),
            intent: input.intent,
            toolResults: input.toolResults,
            products: input.products.map((product) => ({
              id: product.id,
              name: product.name,
              brand: product.brand,
              category: product.category,
              price: product.price,
              currency: product.currency,
              specs: product.specs,
              sourceUrl: product.sourceUrl
            }))
          })
        }
      ],
      text: answerContractFormat
    };
    const { parsed } = await createStructuredJsonResponse({ request, stage: 'agent_answer_contract', signal: input.signal });
    return AnswerContractSchema.parse(parsed);
  }

  async reviewAnswer(input: AgentManagerReviewInput): Promise<PreSendReview> {
    const request = {
      model: config.OPENAI_FACT_MODEL,
      max_output_tokens: config.OPENAI_FACT_MAX_OUTPUT_TOKENS,
      input: [
        {
          role: 'system',
          content: [
            'Ты evidence-bound reviewer ответа AI менеджера БАКАУТ.',
            'Проверь только по фактам ledger/toolResults/products.',
            'Блокируй или требуй rewrite, если ответ спрашивает уже известное, обещает непроверенное наличие/доставку/скидку/срок, противоречит текущему диалогу или просит повторить контакт, который уже есть.',
            'Не оценивай стиль субъективно. Верни только JSON PreSendReview.'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            ledger: compactLedger(input.ledgerState),
            intent: input.intent,
            toolResults: input.toolResults,
            answer: input.answer
          })
        }
      ],
      text: preSendReviewFormat
    };
    const { parsed } = await createStructuredJsonResponse({ request, stage: 'agent_pre_send_review', signal: input.signal });
    return PreSendReviewSchema.parse(parsed);
  }
}

export class AgentManagerOrchestrator {
  private readonly embeddingCoverageCache = new Map<string, { usable: boolean; expiresAt: number }>();
  private readonly queryEmbeddingCache = new Map<string, { value: number[]; expiresAt: number }>();

  constructor(
    private readonly conversations = new ConversationRepository(),
    private readonly products = new ProductRepository(),
    private readonly leads = new LeadRepository(),
    private readonly model: AgentManagerModel = new OpenAIAgentManagerModel(),
    private readonly embedQuery: (text: string, signal?: AbortSignal) => Promise<number[] | undefined | null> = createEmbedding
  ) {}

  async generateAnswer(input: AgentManagerGenerateInput): Promise<ChatResponsePayload> {
    const session = await this.conversations.getSession(input.sessionId);
    if (!session || session.status !== 'active') throw new Error('Conversation session is not active');
    if (!input.turnId) throw new Error('Agent manager harness requires a turn id');
    return this.executeTurn({ ...input, session, turnId: input.turnId, recovered: false });
  }

  async recoverTurn(input: AgentManagerRecoverInput): Promise<ChatResponsePayload> {
    const session = await this.conversations.getSession(input.sessionId);
    if (!session || session.status !== 'active') throw new Error('Conversation session is not active');
    return this.executeTurn({
      sessionId: input.sessionId,
      userMessage: '',
      turnId: input.turnId,
      skipUserMessage: true,
      onDelta: input.onDelta,
      signal: input.signal,
      session,
      recovered: true
    });
  }

  private async executeTurn(input: AgentManagerGenerateInput & {
    session: ConversationSession;
    turnId: string;
    recovered: boolean;
  }): Promise<ChatResponsePayload> {
    const completed = await this.completedPayload(input.session, input.turnId, input.onDelta);
    if (completed) return completed;
    const completedFromAnswerContract = await this.completedFromFinalAnswerContract(input.session, input.turnId, input.recovered, input.onDelta);
    if (completedFromAnswerContract) return completedFromAnswerContract;
    await this.trace(input.sessionId, input.turnId, 'turn', 'started', { recovered: input.recovered });

    let history = await this.conversations.listMessages(input.sessionId, 80);
    let turn = await this.conversations.getTurn(input.sessionId, input.turnId);
    if (!turn) throw new Error('Conversation turn not found');

    let userMessage = input.userMessage;
    if (!turn.userMessageId && !input.skipUserMessage) {
      const user = await this.conversations.addMessage({
        sessionId: input.sessionId,
        role: 'user',
        content: input.userMessage
      });
      await this.conversations.updateTurn({
        sessionId: input.sessionId,
        turnId: input.turnId,
        status: 'received',
        stage: 'user_message_saved',
        userMessageId: user.id,
        activeNeedsBefore: input.session.needState.activeNeeds ?? []
      });
      await this.conversations.upsertTurnCheckpoint({
        sessionId: input.sessionId,
        turnId: input.turnId,
        checkpoint: 'user_message_saved',
        status: 'succeeded',
        artifactRef: user.id,
        payload: { source: 'agent_manager' }
      });
      history = await this.conversations.listMessages(input.sessionId, 80);
      turn = await this.conversations.getTurn(input.sessionId, input.turnId);
    }

    if (!userMessage.trim()) {
      const user = turn?.userMessageId
        ? history.find((message) => message.id === turn?.userMessageId)
        : [...history].reverse().find((message) => message.role === 'user');
      userMessage = user?.content ?? '';
    }
    if (!userMessage.trim()) throw new Error('Cannot recover turn without saved user message');

    const rawLedgerRows = await this.conversations.listDialogueLedgerEvents(input.sessionId, 500);
    const ledgerEvents = mapLedgerRows(rawLedgerRows as DialogueLedgerRow[]);

    const delta = await this.model.proposeLedgerDelta({ session: input.session, history, userMessage, ledgerEvents, signal: input.signal });
    await this.conversations.upsertTurnCheckpoint({
      sessionId: input.sessionId,
      turnId: input.turnId,
      checkpoint: 'ledger_delta_proposed',
      status: 'succeeded',
      payload: delta
    });
    const newEvents = normalizeLedgerStateDeltaEvents({
      sessionId: input.sessionId,
      turnId: input.turnId,
      delta
    });
    for (const event of newEvents) {
      await this.conversations.upsertDialogueLedgerEvent({
        sessionId: event.sessionId,
        turnId: event.turnId,
        eventId: event.eventId,
        eventType: event.eventType,
        scope: event.scope,
        payload: event.payload,
        evidence: event.evidence,
        source: event.source,
        status: event.status
      });
    }
    await this.conversations.upsertTurnCheckpoint({
      sessionId: input.sessionId,
      turnId: input.turnId,
      checkpoint: 'ledger_delta_applied',
      status: 'succeeded',
      payload: { eventIds: newEvents.map((event) => event.eventId) }
    });
    await this.trace(input.sessionId, input.turnId, 'ledger', 'delta_applied', { eventIds: newEvents.map((event) => event.eventId) });

    const ledgerState = reduceDialogueLedger([...ledgerEvents, ...newEvents]);
    const needStateSnapshot = deriveNeedStateSnapshotFromLedger(ledgerState, input.session.needState ?? emptyNeedState());
    const intent = await this.model.planTurn({ session: input.session, history, userMessage, ledgerEvents: [...ledgerEvents, ...newEvents], ledgerState, signal: input.signal });
    await this.conversations.updateTurn({
      sessionId: input.sessionId,
      turnId: input.turnId,
      status: 'planned',
      stage: 'intent_contract_created',
      plannerContract: intent,
      activeNeedsAfter: needStateSnapshot.activeNeeds
    });
    await this.conversations.upsertTurnCheckpoint({
      sessionId: input.sessionId,
      turnId: input.turnId,
      checkpoint: 'intent_contract_created',
      status: 'succeeded',
      payload: intent
    });
    await this.trace(input.sessionId, input.turnId, 'intent', 'contract_created', {
      requiresTools: intent.requiresTools,
      toolRequests: intent.toolRequests.map((tool) => ({ id: tool.id, tool: tool.tool, required: tool.required }))
    });

    const { toolResults, products } = await this.executeTools({
      session: input.session,
      turnId: input.turnId,
      userMessage,
      history,
      toolRequests: intent.toolRequests,
      signal: input.signal
    });

    await this.conversations.upsertTurnCheckpoint({
      sessionId: input.sessionId,
      turnId: input.turnId,
      checkpoint: 'tool_artifacts_saved',
      status: 'succeeded',
      payload: { resultCount: toolResults.length }
    });
    await this.trace(input.sessionId, input.turnId, 'tools', 'artifacts_saved', {
      statuses: toolResults.map((result) => ({ requestId: result.requestId, tool: result.tool, status: result.status }))
    });

    const answer = await this.model.composeAnswer({
      session: input.session,
      history,
      userMessage,
      ledgerEvents: [...ledgerEvents, ...newEvents],
      ledgerState,
      intent,
      toolResults,
      products,
      signal: input.signal
    });
    await this.conversations.saveAnswerContract({
      sessionId: input.sessionId,
      turnId: input.turnId,
      answerText: answer.answerText,
      contract: answer,
      status: 'draft'
    });
    await this.conversations.upsertTurnCheckpoint({
      sessionId: input.sessionId,
      turnId: input.turnId,
      checkpoint: 'answer_contract_created',
      status: 'succeeded',
      payload: answer
    });
    await this.trace(input.sessionId, input.turnId, 'answer', 'contract_created', {
      leadAction: answer.leadAction,
      questionsAsked: answer.questionsAsked.map((question) => question.questionId),
      factsUsed: answer.factsUsed.map((fact) => fact.factKey)
    });

    const review = await this.review({
      session: input.session,
      history,
      userMessage,
      ledgerEvents: [...ledgerEvents, ...newEvents],
      ledgerState,
      intent,
      toolResults,
      products,
      answer,
      signal: input.signal
    });
    const finalText = review.verdict === 'rewrite_required' && review.revisedAnswerText?.trim()
      ? review.revisedAnswerText.trim()
      : answer.answerText.trim();
    if (review.verdict === 'block') {
      throw new Error(`Agent manager answer blocked: ${review.issues.map((issue) => issue.code).join(', ')}`);
    }
    await this.conversations.upsertTurnCheckpoint({
      sessionId: input.sessionId,
      turnId: input.turnId,
      checkpoint: 'review_completed',
      status: 'succeeded',
      payload: review
    });
    await this.trace(input.sessionId, input.turnId, 'review', 'completed', {
      verdict: review.verdict,
      issues: review.issues.map((issue) => issue.code)
    });
    await this.conversations.saveAnswerContract({
      sessionId: input.sessionId,
      turnId: input.turnId,
      answerText: finalText,
      contract: answer,
      review,
      status: 'final'
    });

    const cardSelection = selectProductsForVisibleCards({
      products,
      userMessage,
      history,
      intent,
      answerText: finalText,
      needState: needStateSnapshot
    });
    const cards = productCards(cardSelection.products, ['Найдено в каталоге под текущий запрос.']);
    const metadata = {
      agentManager: true,
      recovered: input.recovered,
      turnId: input.turnId,
      ledgerState,
      ledgerEventIds: newEvents.map((event) => event.eventId),
      intentContract: intent,
      answerContract: answer,
      preSendReview: review,
      toolResults,
      cardSelection,
      productCards: cards,
      needStateSnapshot,
      warnings: [
        ...ledgerState.warnings,
        ...toolResults.flatMap((result) => result.warnings),
        ...cardSelection.warnings
      ]
    };

    await input.onDelta?.(finalText);
    const assistantMessage = await this.conversations.addAssistantMessageForTurn({
      sessionId: input.sessionId,
      turnId: input.turnId,
      content: finalText,
      metadata,
      recovered: input.recovered
    });
    await this.conversations.upsertTurnCheckpoint({
      sessionId: input.sessionId,
      turnId: input.turnId,
      checkpoint: 'assistant_message_saved',
      status: 'succeeded',
      artifactRef: assistantMessage.id,
      payload: { recovered: input.recovered }
    });
    await this.trace(input.sessionId, input.turnId, 'turn', 'assistant_message_saved', {
      assistantMessageId: assistantMessage.id,
      recovered: input.recovered
    });

    return {
      turnId: input.turnId,
      answer: finalText,
      needState: needStateSnapshot,
      productCards: cards,
      usedWebSearch: toolResults.some((result) => result.tool === 'web.researchProductFacts' && result.status === 'ok'),
      leadRequested: answer.leadAction === 'offer_form',
      leadCreated: toolResults.some((result) => result.tool === 'lead.capture' && result.status === 'ok'),
      assistantMessageId: assistantMessage.id,
      metadata
    };
  }

  private async executeTools(input: {
    session: ConversationSession;
    turnId: string;
    userMessage: string;
    history: Message[];
    toolRequests: ToolRequest[];
    signal?: AbortSignal;
  }) {
    const productsById = new Map<string, Product>();
    const toolResults: ToolResult[] = [];

    for (const request of input.toolRequests) {
      const startedAt = Date.now();
      let result: ToolResult;
      try {
        if (request.tool === 'catalog.search') {
          const query = typeof request.args.query === 'string' && request.args.query.trim()
            ? request.args.query
            : input.userMessage;
          const limit = Math.max(1, Math.min(12, Number(request.args.limit ?? 8)));
          const search = await this.searchCatalogProducts(
            query,
            limit,
            input.signal,
            [input.userMessage, query, request.rationale].join('\n')
          );
          const products = search.products;
          products.forEach((product) => productsById.set(product.id, product));
          result = ToolResultSchema.parse({
            requestId: request.id,
            tool: request.tool,
            status: products.length ? 'ok' : 'not_found',
            payload: {
              query,
              productIds: products.map((product) => product.id),
              products,
              retrieval: {
                textCount: search.textCount,
                vectorCount: search.vectorCount,
                usedEmbeddings: search.vectorCount > 0
              }
            },
            warnings: products.length ? search.warnings : [...search.warnings, 'catalog_search_no_matches']
          });
        } else if (request.tool === 'catalog.getProductDetails') {
          const names = Array.isArray(request.args.productNames)
            ? request.args.productNames.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            : [];
          const queries = names.length
            ? names
            : [typeof request.args.query === 'string' && request.args.query.trim() ? request.args.query : input.userMessage];
          for (const query of queries.slice(0, 4)) {
            const found = await this.searchCatalogProducts(
              query,
              4,
              input.signal,
              [input.userMessage, query, request.rationale].join('\n')
            );
            found.products.forEach((product) => productsById.set(product.id, product));
          }
          result = ToolResultSchema.parse({
            requestId: request.id,
            tool: request.tool,
            status: productsById.size ? 'ok' : 'not_found',
            payload: { productIds: [...productsById.keys()], products: [...productsById.values()] },
            warnings: productsById.size ? [] : ['product_details_no_matches']
          });
        } else if (request.tool === 'calculator.generatorLoad') {
          const loads = loadsFromArgs(request.args, input.userMessage);
          const profile = calculateGeneratorLoadProfile(loads, {
            simultaneousStarting: request.args.simultaneousStarting === true,
            simultaneousStartingKinds: Array.isArray(request.args.simultaneousStartingKinds)
              ? request.args.simultaneousStartingKinds.filter((item): item is string => typeof item === 'string')
              : undefined
          });
          result = ToolResultSchema.parse({
            requestId: request.id,
            tool: request.tool,
            status: profile ? 'ok' : 'not_found',
            payload: { loads, profile },
            warnings: profile ? [] : ['no_usable_loads_for_generator_calculation']
          });
        } else if (request.tool === 'web.researchProductFacts') {
          if (productsById.size < 2) {
            const found = await this.searchCatalogProducts(input.userMessage, 4, input.signal, input.userMessage);
            found.products.forEach((product) => productsById.set(product.id, product));
          }
          const selectedProducts = [...productsById.values()].slice(0, 4);
          const research = await researchProductComparisonFacts({
            userMessage: input.userMessage,
            products: selectedProducts,
            signal: input.signal
          });
          for (const conflict of research.conflicts) {
            const product = selectedProducts.find((item) => item.name === conflict.productName);
            await this.products.recordDataQualityIssue({
              productId: product?.id ?? null,
              issueType: 'web_catalog_conflict',
              fieldName: conflict.attribute,
              conflictingValues: [conflict.catalogValue, ...conflict.webValues].filter(Boolean),
              evidence: [conflict.resolution]
            }).catch((error) => console.warn('Data quality issue write failed', safeError(error)));
          }
          result = ToolResultSchema.parse({
            requestId: request.id,
            tool: request.tool,
            status: research.warnings.includes('not_enough_products_for_comparison') ? 'not_found' : 'ok',
            payload: research,
            warnings: research.warnings
          });
        } else if (request.tool === 'lead.capture') {
          const contact = {
            ...extractContact(input.userMessage),
            ...(request.args.contact && typeof request.args.contact === 'object' ? request.args.contact as Record<string, unknown> : {})
          };
          if (!contact.phone && !contact.email) {
            result = ToolResultSchema.parse({
              requestId: request.id,
              tool: request.tool,
              status: 'not_found',
              payload: { missing: 'contact' },
              warnings: ['lead_contact_missing']
            });
          } else if (!contact.name) {
            result = ToolResultSchema.parse({
              requestId: request.id,
              tool: request.tool,
              status: 'not_found',
              payload: { missing: 'name', contact },
              warnings: ['lead_name_missing']
            });
          } else {
            const lead = await this.leads.createLead({
              sessionId: input.session.id,
              name: String(contact.name),
              phone: typeof contact.phone === 'string' ? contact.phone : undefined,
              email: typeof contact.email === 'string' ? contact.email : undefined,
              question: input.userMessage
            });
            await this.conversations.enqueueLeadOutbox({
              leadId: lead.id,
              sessionId: input.session.id,
              turnId: input.turnId,
              destination: 'lead_email',
              payload: { leadId: lead.id }
            });
            result = ToolResultSchema.parse({
              requestId: request.id,
              tool: request.tool,
              status: 'ok',
              payload: { leadId: lead.id, outbox: true },
              warnings: []
            });
          }
        } else {
          result = ToolResultSchema.parse({
            requestId: request.id,
            tool: request.tool,
            status: 'denied',
            payload: {},
            warnings: ['tool_not_implemented']
          });
        }
      } catch (error) {
        result = ToolResultSchema.parse({
          requestId: request.id,
          tool: request.tool,
          status: 'error',
          payload: { error: safeError(error) },
          warnings: ['tool_execution_error'],
          errorCode: safeError(error).code ?? safeError(error).message
        });
      }
      await this.conversations.saveToolArtifact({
        sessionId: input.session.id,
        turnId: input.turnId,
        toolName: request.tool,
        toolRequestId: request.id,
        status: result.status,
        payload: result.payload,
        warnings: [...result.warnings, `duration_ms:${Date.now() - startedAt}`]
      });
      toolResults.push(result);
    }

    return { toolResults, products: [...productsById.values()] };
  }

  private async canUseProductEmbeddings() {
    const coverageFn = (this.products as unknown as {
      getEmbeddingCoverage?: ProductRepository['getEmbeddingCoverage'];
    }).getEmbeddingCoverage;
    if (!coverageFn) return false;

    const key = `products:${config.OPENAI_EMBEDDING_MODEL}`;
    const cached = this.embeddingCoverageCache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.usable;

    try {
      const coverage = await coverageFn.call(this.products, 'products', config.OPENAI_EMBEDDING_MODEL);
      const usable = coverage.total > 0 && coverage.coverage >= config.EMBEDDING_MIN_COVERAGE;
      this.embeddingCoverageCache.set(key, { usable, expiresAt: now + 60_000 });
      return usable;
    } catch (error) {
      console.warn('Agent manager embedding coverage check failed', safeError(error));
      this.embeddingCoverageCache.set(key, { usable: false, expiresAt: now + 15_000 });
      return false;
    }
  }

  private async createCachedQueryEmbedding(text: string, signal?: AbortSignal) {
    const key = `${config.OPENAI_EMBEDDING_MODEL}:${text.slice(0, 8000)}`;
    const cached = this.queryEmbeddingCache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.value;

    const embedding = await this.embedQuery(text, signal).catch(() => null);
    if (!embedding?.length) return null;

    if (this.queryEmbeddingCache.size >= 200) {
      const oldest = this.queryEmbeddingCache.keys().next().value;
      if (oldest) this.queryEmbeddingCache.delete(oldest);
    }
    this.queryEmbeddingCache.set(key, { value: embedding, expiresAt: now + 10 * 60_000 });
    return embedding;
  }

  private async searchCatalogProducts(query: string, limit: number, signal?: AbortSignal, semanticContext = query) {
    const warnings: string[] = [];
    let firstError: unknown = null;
    let textProducts: Product[] = [];
    let vectorProducts: Product[] = [];

    try {
      textProducts = await this.products.searchProducts(query, Math.max(limit, limit * 3));
    } catch (error) {
      firstError = error;
      warnings.push(`catalog_text_search_error:${safeError(error).code ?? safeError(error).message}`);
    }

    const vectorSearchFn = (this.products as unknown as {
      vectorSearch?: ProductRepository['vectorSearch'];
    }).vectorSearch;
    if (vectorSearchFn && await this.canUseProductEmbeddings()) {
      const embedding = await this.createCachedQueryEmbedding(query, signal);
      if (embedding) {
        try {
          vectorProducts = await vectorSearchFn.call(this.products, embedding, Math.max(limit, limit * 3));
        } catch (error) {
          firstError ??= error;
          warnings.push(`catalog_vector_search_error:${safeError(error).code ?? safeError(error).message}`);
        }
      }
    }

    const byId = new Map<string, Product>();
    for (const product of [...textProducts, ...vectorProducts]) byId.set(product.id, product);
    const mergedProducts = [...byId.values()];
    const productIntent = inferProductIntent(semanticContext);
    const matchingProducts = productIntent === 'unknown'
      ? mergedProducts
      : mergedProducts.filter((product) => productMatchesIntent(product, productIntent));
    if (productIntent !== 'unknown' && matchingProducts.length !== mergedProducts.length) {
      warnings.push(`catalog_products_filtered_by_intent:${productIntent}:${mergedProducts.length - matchingProducts.length}`);
    }
    const products = matchingProducts.slice(0, limit);
    if (!products.length && firstError) throw firstError;
    return {
      products,
      textCount: textProducts.length,
      vectorCount: vectorProducts.length,
      warnings
    };
  }

  private async review(input: AgentManagerReviewInput): Promise<PreSendReview> {
    const mechanicalIssues: PreSendReview['issues'] = [];
    const contactInTurn = extractContact(input.userMessage);
    if ((contactInTurn.phone || contactInTurn.email) && /остав(ь|ьте).{0,40}(телефон|номер|контакт|имя)/iu.test(input.answer.answerText)) {
      mechanicalIssues.push({
        code: 'asks_contact_already_provided',
        severity: 'high',
        message: 'Answer asks for contact even though the current buyer message already contains contact details.',
        evidence: input.userMessage
      });
    }
    for (const question of input.answer.questionsAsked) {
      const existing = input.ledgerState.questionsById[question.questionId];
      if (existing && existing.status !== 'open') {
        mechanicalIssues.push({
          code: 'asks_closed_question',
          severity: 'high',
          message: `Question ${question.questionId} was already ${existing.status}.`,
          evidence: existing.text
        });
      }
    }
    const trustedSourceIds = new Set<string>([
      ...input.ledgerState.eventIds,
      ...input.toolResults.map((result) => result.requestId)
    ]);
    for (const fact of input.answer.factsUsed) {
      const unknownSourceIds = fact.sourceEventIds.filter((sourceId) => !trustedSourceIds.has(sourceId));
      if (unknownSourceIds.length) {
        mechanicalIssues.push({
          code: 'unsupported_fact_source',
          severity: 'high',
          message: `Answer fact ${fact.factKey} references sources that are absent from ledger/tool artifacts.`,
          evidence: unknownSourceIds.join(', ')
        });
      }
    }
    const unknownToolResultIds = input.answer.toolResultIds.filter((toolResultId) => !trustedSourceIds.has(toolResultId));
    if (unknownToolResultIds.length) {
      mechanicalIssues.push({
        code: 'unknown_tool_result_reference',
        severity: 'high',
        message: 'Answer references tool results that were not executed for this turn.',
        evidence: unknownToolResultIds.join(', ')
      });
    }
    const leadCaptureOk = input.toolResults.some((result) => result.tool === 'lead.capture' && result.status === 'ok');
    if ((input.answer.leadAction === 'capture_contact' || input.answer.leadAction === 'confirm_contact_received') && !leadCaptureOk) {
      mechanicalIssues.push({
        code: 'lead_confirmation_without_local_capture',
        severity: 'high',
        message: 'The bot may confirm a contact only after local lead and outbox capture succeeded.',
        evidence: JSON.stringify(input.toolResults.filter((result) => result.tool === 'lead.capture'))
      });
    }
    const requiresAdjudication = input.answer.riskFlags.some((flag) => /high[_-]?risk[_-]?disagreement|needs?[_-]?adjudication|requires?[_-]?adjudication|source[_-]?conflict[_-]?unresolved/iu.test(flag))
      || input.toolResults.some((result) => result.warnings.some((warning) => /high[_-]?risk[_-]?disagreement|unresolved[_-]?conflict|needs?[_-]?adjudication|requires?[_-]?adjudication/iu.test(warning)));
    if (requiresAdjudication) {
      mechanicalIssues.push({
        code: 'requires_adjudication',
        severity: 'high',
        message: 'High-risk source disagreement must be adjudicated before a buyer-visible factual answer.',
        evidence: JSON.stringify({ answerRiskFlags: input.answer.riskFlags, toolWarnings: input.toolResults.flatMap((result) => result.warnings) })
      });
    }
    const unsupportedClaimRisk = input.answer.riskFlags.some((flag) => /unsupported|unverified|no[_-]?evidence|hallucination/iu.test(flag));
    if (unsupportedClaimRisk) {
      mechanicalIssues.push({
        code: 'unsupported_claim_risk_flag',
        severity: 'high',
        message: 'Answer contract marks a factual claim as unsupported or unverified.',
        evidence: input.answer.riskFlags.join(', ')
      });
    }
    const blockingIssueCodes = new Set([
      'unsupported_fact_source',
      'unknown_tool_result_reference',
      'lead_confirmation_without_local_capture',
      'requires_adjudication',
      'unsupported_claim_risk_flag'
    ]);
    const blockingIssues = mechanicalIssues.filter((issue) => blockingIssueCodes.has(issue.code));
    if (blockingIssues.length) {
      return {
        verdict: 'block',
        issues: blockingIssues
      };
    }
    if (mechanicalIssues.length) {
      return {
        verdict: 'rewrite_required',
        issues: mechanicalIssues,
        revisedAnswerText: input.answer.answerText.replace(/(?:оставьте|оставь)[^.!?\n]*(?:телефон|номер|контакт|имя)[^.!?\n]*[.!?]?/giu, '').trim()
      };
    }
    if (!config.AGENT_MANAGER_PRE_SEND_REVIEW_ENABLED) {
      return { verdict: 'pass', issues: [] };
    }
    return this.model.reviewAnswer(input);
  }

  private async completedPayload(
    session: ConversationSession,
    turnId: string,
    onDelta?: (text: string) => void | Promise<void>
  ): Promise<ChatResponsePayload | null> {
    const turn = await this.conversations.getTurn(session.id, turnId);
    if (!turn?.assistantMessageId || !['completed', 'recovered'].includes(turn.status)) return null;
    const history = await this.conversations.listMessages(session.id, 80);
    const message = history.find((item) => item.id === turn.assistantMessageId && item.role === 'assistant');
    if (!message?.content?.trim()) return null;
    await onDelta?.(message.content);
    const needState = (message.metadata?.needStateSnapshot as CustomerNeedState | undefined) ?? session.needState ?? emptyNeedState();
    return {
      turnId,
      answer: message.content,
      needState,
      productCards: (message.metadata?.productCards as ProductCard[] | undefined) ?? [],
      usedWebSearch: Boolean(message.metadata?.usedWebSearch),
      assistantMessageId: message.id,
      metadata: {
        ...(message.metadata ?? {}),
        agentManager: true,
        recoveredFromExistingTurn: true
      }
    };
  }

  private async completedFromFinalAnswerContract(
    session: ConversationSession,
    turnId: string,
    recovered: boolean,
    onDelta?: (text: string) => void | Promise<void>
  ): Promise<ChatResponsePayload | null> {
    const row = await this.conversations.getFinalAnswerContract(session.id, turnId);
    const answerText = typeof row?.answer_text === 'string' ? row.answer_text.trim() : '';
    if (!answerText) return null;
    const rawLedgerRows = await this.conversations.listDialogueLedgerEvents(session.id, 500);
    const ledgerState = reduceDialogueLedger(mapLedgerRows(rawLedgerRows as DialogueLedgerRow[]));
    const needStateSnapshot = deriveNeedStateSnapshotFromLedger(ledgerState, session.needState ?? emptyNeedState());
    const metadata = {
      agentManager: true,
      recovered,
      recoveredFromAnswerContract: true,
      turnId,
      answerContract: row.contract,
      preSendReview: row.review,
      needStateSnapshot
    };
    await onDelta?.(answerText);
    const assistantMessage = await this.conversations.addAssistantMessageForTurn({
      sessionId: session.id,
      turnId,
      content: answerText,
      metadata,
      recovered
    });
    await this.conversations.upsertTurnCheckpoint({
      sessionId: session.id,
      turnId,
      checkpoint: 'assistant_message_saved',
      status: 'succeeded',
      artifactRef: assistantMessage.id,
      payload: { recoveredFromAnswerContract: true }
    });
    await this.trace(session.id, turnId, 'turn', 'assistant_message_saved_from_answer_contract', {
      assistantMessageId: assistantMessage.id,
      recovered
    });
    return {
      turnId,
      answer: answerText,
      needState: needStateSnapshot,
      productCards: [],
      usedWebSearch: false,
      assistantMessageId: assistantMessage.id,
      metadata
    };
  }

  private async trace(sessionId: string, turnId: string, phase: string, eventType: string, payload: Record<string, unknown>) {
    await this.conversations.addAgentTrace({
      sessionId,
      turnId,
      phase,
      eventType,
      payload,
      redacted: true
    }).catch((error) => console.warn('Agent manager trace write failed', safeError(error)));
  }
}
