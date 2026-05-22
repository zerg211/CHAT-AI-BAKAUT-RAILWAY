import { config } from '../config.js';
import { ConversationRepository, LeadRepository, ProductRepository } from '../db/repositories.js';
import type { ChatResponsePayload, ConversationSession, CustomerNeedState, Message, Product, ProductCard, ProductSelectionClass } from '../shared/types.js';
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
import { createEmbedding } from './openaiClient.js';
import { createStructuredJsonResponse } from './openaiStructured.js';
import { researchProductComparisonFacts } from './productComparisonResearch.js';
import { inferProductIntent, productMatchesIntent } from './productClassifier.js';
import { emptyNeedState } from './needState.js';
import { safeError } from './responseUtils.js';
import { getAgentManagerRuntimeDecision } from './agentManagerRuntime.js';
import {
  assessVisibleCardReadiness,
  productSelectionClasses,
  productCards,
  rankCatalogProductsByNumericFit,
  selectProductsForVisibleCards,
  suppressVisibleCardsForReadiness,
  toolRequestProductIntent,
  toolRequestScopedQuery,
  uniqueStrings
} from './agentManagerCardSelection.js';
import {
  buildGeneratorLoadToolPayload,
  hasUnconfirmedGeneratorLoadBasisResult,
  isGeneratorProductClass
} from './agentManagerGeneratorLoad.js';
import { approvedAnswerStyleExamplesPromptBlock } from './answerStyleExamples.js';

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
  requiredResponseClauses?: RequiredResponseClause[];
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

type RequiredResponseClause = {
  code: string;
  sourceRequestId: string;
  instruction: string;
  productName?: string;
  catalogProductNames?: string[];
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

function hasLeadContact(contact: ReturnType<typeof extractContact>) {
  return Boolean(contact.phone || contact.email);
}

function leadCaptureMissingContact(toolResults: ToolResult[]) {
  return toolResults.some((result) =>
    result.tool === 'lead.capture' &&
    result.status !== 'ok' &&
    result.warnings.some((warning) => warning === 'lead_contact_missing' || warning === 'lead_name_missing')
  );
}

function leadCaptureMissingName(toolResults: ToolResult[]) {
  return toolResults.some((result) =>
    result.tool === 'lead.capture' &&
    result.status !== 'ok' &&
    result.warnings.includes('lead_name_missing')
  );
}

function leadCaptureRepairText(input: {
  contact: ReturnType<typeof extractContact>;
  toolResults: ToolResult[];
}) {
  if (hasLeadContact(input.contact) && leadCaptureMissingName(input.toolResults)) {
    return 'Телефон получил. Напишите, пожалуйста, имя, и я передам выбранные позиции на проверку наличия, доставки и условий. После проверки с вами свяжутся с точным ответом.';
  }
  return 'Наличие, доставку, сроки и индивидуальные условия нужно проверить по складу и логистике. Оставьте имя и телефон в форме, и я передам выбранные позиции на проверку; после проверки с вами свяжутся с точным ответом.';
}

function answerEvidenceSourceHints(input: {
  ledgerState: ReducedDialogueLedgerState;
  toolResults: ToolResult[];
}) {
  const ledgerFacts = Object.values(input.ledgerState.factsByKey).map((fact) => ({
    id: fact.eventId,
    factKey: fact.factKey,
    value: fact.value,
    evidence: fact.evidence,
    status: fact.status
  }));
  const toolResults = input.toolResults.map((result) => ({
    id: result.requestId,
    tool: result.tool,
    status: result.status,
    warnings: result.warnings
  }));
  return {
    allowedSourceIds: [
      ...ledgerFacts.map((fact) => fact.id),
      ...toolResults.map((result) => result.id)
    ],
    ledgerFacts,
    toolResults
  };
}

function normalizeAnswerEvidenceSources(input: {
  answer: AnswerContract;
  ledgerState: ReducedDialogueLedgerState;
  toolResults: ToolResult[];
}): AnswerContract {
  const trustedSourceIds = new Set<string>([
    ...input.ledgerState.eventIds,
    ...input.toolResults.map((result) => result.requestId)
  ]);
  const toolResultIds = new Set(input.toolResults.map((result) => result.requestId));
  const validAnswerToolResultIds = input.answer.toolResultIds.filter((toolResultId) => toolResultIds.has(toolResultId));
  const okToolResultIds = input.toolResults
    .filter((result) => result.status === 'ok')
    .map((result) => result.requestId);
  const fallbackOkToolResultIds = validAnswerToolResultIds.length || okToolResultIds.length !== 1
    ? []
    : okToolResultIds;

  const factsUsed = input.answer.factsUsed.map((fact) => {
    const exactSourceIds = fact.sourceEventIds.filter((sourceId) => trustedSourceIds.has(sourceId));
    if (exactSourceIds.length) {
      return { ...fact, sourceEventIds: [...new Set(exactSourceIds)] };
    }

      const ledgerFact = input.ledgerState.factsByKey[fact.factKey];
      const repairedSourceIds = [
        ledgerFact?.eventId,
        ...validAnswerToolResultIds,
      ...fallbackOkToolResultIds
      ].filter((sourceId): sourceId is string => Boolean(sourceId && trustedSourceIds.has(sourceId)));

    return repairedSourceIds.length
      ? { ...fact, sourceEventIds: [...new Set(repairedSourceIds)] }
      : fact;
  });

  return {
    ...input.answer,
    toolResultIds: validAnswerToolResultIds,
    factsUsed
  };
}

const modelTextConfusables: Record<string, string> = {
  а: 'a',
  в: 'b',
  е: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x'
};

function normalizeModelText(value: unknown) {
  const chars: string[] = [];
  for (const char of String(value ?? '').normalize('NFKD').toLocaleLowerCase('ru-RU')) {
    chars.push(modelTextConfusables[char] ?? char);
  }
  return chars.join('');
}

function compactModelText(value: unknown) {
  return modelTextTokens(value).join('');
}

function charCode(char: string) {
  return char.codePointAt(0) ?? 0;
}

function isAsciiDigit(char: string) {
  const code = charCode(char);
  return code >= 48 && code <= 57;
}

function isAsciiLetter(char: string) {
  const code = charCode(char);
  return code >= 97 && code <= 122;
}

function isCyrillicLetter(char: string) {
  const code = charCode(char);
  return (code >= 0x0430 && code <= 0x044f) || code === 0x0451;
}

function isModelTokenChar(char: string) {
  return isAsciiDigit(char) || isAsciiLetter(char) || isCyrillicLetter(char);
}

function tokenHasLetter(token: string) {
  for (const char of token) {
    if (isAsciiLetter(char) || isCyrillicLetter(char)) return true;
  }
  return false;
}

function tokenHasDigit(token: string) {
  for (const char of token) {
    if (isAsciiDigit(char)) return true;
  }
  return false;
}

function modelTextTokens(value: unknown) {
  const tokens: string[] = [];
  let current = '';
  for (const char of normalizeModelText(value)) {
    if (isModelTokenChar(char)) {
      current += char;
    } else if (current) {
      tokens.push(current);
      current = '';
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function modelIdentifierTokens(value: unknown) {
  return uniqueStrings(
    modelTextTokens(value)
      .map(compactModelText)
      .filter((token) => token.length >= 4 && tokenHasLetter(token) && tokenHasDigit(token))
  );
}

function modelIdentifierDisplayTokens(value: unknown) {
  const tokens: string[] = [];
  let current = '';
  for (const rawChar of String(value ?? '').normalize('NFKD')) {
    const normalizedChar = normalizeModelText(rawChar);
    if (normalizedChar.length === 1 && isModelTokenChar(normalizedChar)) {
      current += rawChar;
    } else if (current) {
      tokens.push(current);
      current = '';
    }
  }
  if (current) tokens.push(current);
  const seen = new Set<string>();
  const displayTokens: string[] = [];
  for (const token of tokens) {
    const canonical = compactModelText(token);
    if (canonical.length < 4 || !tokenHasLetter(canonical) || !tokenHasDigit(canonical) || seen.has(canonical)) continue;
    seen.add(canonical);
    displayTokens.push(token);
  }
  return displayTokens;
}

function requestStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean)
    : [];
}

function targetProductNamesForRequest(request: ToolRequest) {
  return uniqueStrings(requestStringArray(request.args.productNames));
}

function comparisonAttributesForRequest(request: ToolRequest) {
  return uniqueStrings(requestStringArray(request.args.comparisonAttributes));
}

function productLookupText(product: Product) {
  return [
    product.name,
    product.brand,
    product.category,
    product.externalId,
    product.slug,
    product.sourceUrl,
    JSON.stringify(product.specs ?? {})
  ].filter(Boolean).join(' ');
}

function compactProductDescription(value: unknown, limit = 1200) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function answerProductContext(product: Product) {
  return {
    id: product.id,
    name: product.name,
    brand: product.brand,
    category: product.category,
    price: product.price,
    currency: product.currency,
    specs: product.specs,
    description: compactProductDescription(product.description),
    sourceUrl: product.sourceUrl
  };
}

function textMatchesTargetName(value: unknown, targetName: string) {
  const targetTokens = modelIdentifierTokens(targetName);
  if (targetTokens.length) {
    const valueIdentifierTokens = new Set(modelIdentifierTokens(value));
    return targetTokens.every((token) => valueIdentifierTokens.has(token));
  }
  const productText = compactModelText(value);
  const targetText = compactModelText(targetName);
  return targetText.length >= 5 && productText.includes(targetText);
}

function productMatchesTargetName(product: Product, targetName: string) {
  return textMatchesTargetName(productLookupText(product), targetName);
}

function toolRequestEvidenceText(request: ToolRequest) {
  return [
    request.args.query,
    request.args.semanticQuery,
    request.args.reason,
    request.args.notes,
    ...requestStringArray(request.args.productNames)
  ].filter(Boolean).join(' ');
}

function exactModelEvidenceToolCoversToken(request: ToolRequest, token: string) {
  if (!['catalog.search', 'catalog.getProductDetails', 'web.researchProductFacts'].includes(request.tool)) return false;
  return modelIdentifierTokens(toolRequestEvidenceText(request)).includes(token);
}

function repairIntentForExactModelEvidence(intent: AgentIntentContract, userMessage: string): AgentIntentContract {
  const targetTokens = modelIdentifierTokens(userMessage);
  if (!targetTokens.length) return intent;
  const uncoveredTokens = targetTokens.filter((token) =>
    !intent.toolRequests.some((request) => exactModelEvidenceToolCoversToken(request, token))
  );
  if (!uncoveredTokens.length) return intent;
  const displayTargets = modelIdentifierDisplayTokens(userMessage)
    .filter((token) => uncoveredTokens.includes(compactModelText(token)));
  const idBase = `auto:exact-model:${uncoveredTokens.map(compactModelText).join('-')}`;
  const existingIds = new Set(intent.toolRequests.map((request) => request.id));
  const requestId = existingIds.has(idBase) ? `${idBase}:${intent.toolRequests.length + 1}` : idBase;
  const repairRequest: ToolRequest = {
    id: requestId,
    tool: 'web.researchProductFacts',
    args: {
      query: userMessage,
      semanticQuery: `Current turn exact-model evidence check. Verify only the named model identifiers in this buyer message: ${userMessage}`,
      productIntent: inferProductIntent(userMessage),
      limit: 4,
      productIds: [],
      productNames: displayTargets.length ? displayTargets : uncoveredTokens,
      comparisonAttributes: ['current buyer question'],
      loads: [],
      simultaneousStarting: null,
      simultaneousStartingKinds: [],
      estimateBasis: null,
      contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
      reason: 'Current turn names an exact model but the planner did not request same-turn evidence for that model.',
      notes: 'Do not reuse technical or catalog facts from a different model identifier. Verify the current exact model before answering.'
    },
    rationale: 'Exact model facts are scoped by model identifier; previous model facts are not evidence for a newly named model.',
    required: true
  };
  return {
    ...intent,
    requiresTools: true,
    toolRequests: [...intent.toolRequests, repairRequest],
    riskFlags: uniqueStrings([...intent.riskFlags, 'planner_repaired_exact_model_evidence'])
  };
}

function targetBrandCandidates(targetNames: string[]) {
  const genericProductWords = new Set([
    'generator',
    'generators',
    'gasoline',
    'diesel',
    'electric',
    'benzinovyj',
    'dizelnyj',
    'генератор',
    'генераторы',
    'бензиновый',
    'дизельный',
    'электрический'
  ]);
  return uniqueStrings(
    targetNames.flatMap((name) =>
      modelTextTokens(name)
        .map((token) => token.trim())
        .filter((token) => token.length > 1 && tokenHasLetter(token) && !tokenHasDigit(token) && !genericProductWords.has(token))
        .slice(0, 1)
    )
  );
}

function productHasTargetBrand(product: Product, brandCandidates: string[]) {
  if (!brandCandidates.length) return false;
  const productText = compactModelText([product.brand, product.name, product.sourceUrl].filter(Boolean).join(' '));
  return brandCandidates.some((brand) => productText.includes(compactModelText(brand)));
}

function compactCatalogProduct(product: Product, relation: string) {
  return {
    productId: product.id,
    name: product.name,
    brand: product.brand ?? null,
    category: product.category ?? null,
    sourceUrl: product.sourceUrl ?? null,
    specs: product.specs ?? {},
    relation
  };
}

function catalogPresenceForTargets(targetNames: string[], products: Product[]) {
  return targetNames.map((productName) => {
    const exactMatches = products.filter((product) => productMatchesTargetName(product, productName));
    return {
      productName,
      status: exactMatches.length ? 'present' : 'absent',
      exactProductIds: exactMatches.map((product) => product.id)
    };
  });
}

function nearbyCatalogProductsForTargets(targetNames: string[], products: Product[]) {
  if (!targetNames.length) return [];
  const brandCandidates = targetBrandCandidates(targetNames);
  const candidates = products
    .filter((product) => !targetNames.some((targetName) => productMatchesTargetName(product, targetName)))
    .map((product) => ({
      product,
      sameBrand: productHasTargetBrand(product, brandCandidates)
    }));
  const sameBrandCandidates = candidates.filter((candidate) => candidate.sameBrand);
  return (sameBrandCandidates.length ? sameBrandCandidates : candidates)
    .sort((a, b) => Number(b.sameBrand) - Number(a.sameBrand))
    .slice(0, 4)
    .map(({ product, sameBrand }) => compactCatalogProduct(
      product,
      sameBrand ? 'same_brand_same_product_class' : 'same_product_class_comparable'
    ));
}

function requiredResponseClausesForToolResults(toolResults: ToolResult[]): RequiredResponseClause[] {
  const clauses: RequiredResponseClause[] = [];
  for (const result of toolResults) {
    if (result.tool !== 'web.researchProductFacts') continue;
    if (result.status !== 'ok') {
      clauses.push({
        code: 'web_research_unavailable_grounding',
        sourceRequestId: result.requestId,
        instruction: 'The requested web fact check did not complete successfully. Answer only at the truthful general engineering level from the current dialogue and already available facts; explicitly separate that from exact/current verification, and do not claim that web facts were checked or verified by this failed tool result.'
      });
      continue;
    }
    const payload = result.payload as {
      catalogPresence?: Array<{ productName?: string; status?: string }>;
      nearbyCatalogProducts?: Array<{ name?: string }>;
      facts?: Array<{ productName?: string; sourceType?: string; confidence?: string }>;
      answerGuidance?: { directAnswer?: string; completeness?: string };
    };
    const directAnswer = typeof payload.answerGuidance?.directAnswer === 'string'
      ? payload.answerGuidance.directAnswer.trim()
      : '';
    if (directAnswer && payload.answerGuidance?.completeness !== 'not_answered') {
      clauses.push({
        code: 'answer_checked_research_guidance',
        sourceRequestId: result.requestId,
        instruction: `Use this checked research guidance to answer the buyer's direct question in simple words, without turning unverified choices into false negatives: ${directAnswer}`
      });
    }
    const nearbyNames = uniqueStrings((payload.nearbyCatalogProducts ?? [])
      .map((product) => typeof product.name === 'string' ? product.name.trim() : '')
      .filter(Boolean))
      .slice(0, 4);
    for (const presence of payload.catalogPresence ?? []) {
      if (presence.status !== 'absent' || !presence.productName) continue;
      const targetProductName = presence.productName;
      const targetFacts = (payload.facts ?? []).filter((fact) =>
        fact.sourceType === 'web' &&
        typeof fact.productName === 'string' &&
        ['high', 'medium'].includes(String(fact.confidence ?? '')) &&
        textMatchesTargetName(fact.productName, targetProductName)
      );
      if (targetFacts.length) {
        clauses.push({
          code: 'answer_direct_checked_external_fact',
          sourceRequestId: result.requestId,
          productName: targetProductName,
          instruction: `Use checked external web facts to answer the buyer's direct technical question about ${targetProductName}.`
        });
      }
      clauses.push({
        code: 'state_exact_catalog_absence',
        sourceRequestId: result.requestId,
        productName: targetProductName,
        instruction: `Say plainly that the exact model ${targetProductName} is not in the BAKAUT catalog.`
      });
      if (nearbyNames.length) {
        clauses.push({
          code: 'mention_nearby_catalog_models',
          sourceRequestId: result.requestId,
          productName: targetProductName,
          catalogProductNames: nearbyNames,
          instruction: `Mention these nearby BAKAUT catalog models only as catalog orientation, not as proof about ${targetProductName}: ${nearbyNames.join('; ')}.`
        });
      }
    }
  }
  return clauses;
}

type StartControlCoverageItem = {
  attribute?: unknown;
  status?: unknown;
  value?: unknown;
  evidence?: unknown;
};

const startControlUncertaintyStatuses = new Set(['not_confirmed', 'ambiguous', 'not_found']);

function normalizedTextIncludesAny(normalizedText: string, fragments: string[]) {
  return fragments.some((fragment) => {
    const normalizedFragment = normalizeModelText(fragment);
    return normalizedFragment.length > 0 && normalizedText.includes(normalizedFragment);
  });
}

function startControlCoverageText(coverageItem: StartControlCoverageItem) {
  return normalizeModelText([
    coverageItem.attribute,
    coverageItem.value,
    coverageItem.evidence
  ].filter(Boolean).join(' '));
}

function startControlCoverageLabels(attribute: unknown, value: unknown) {
  const text = normalizeModelText([attribute, value].filter(Boolean).join(' '));
  const labels: string[] = [];
  if (
    normalizedTextIncludesAny(text, ['key', 'ignition', 'switch', 'ключ', 'зажиган', 'выключател'])
  ) {
    labels.push('Запуск с ключа/через выключатель');
  }
  if (
    normalizedTextIncludesAny(text, ['button', 'pushbutton', 'кноп'])
  ) {
    labels.push('Кнопочный запуск');
  }
  return labels;
}

function normalizedAnswerMentionsStartControlLabel(normalizedAnswer: string, label: string) {
  if (label === 'Кнопочный запуск') {
    return normalizedTextIncludesAny(normalizedAnswer, ['button', 'pushbutton', 'кноп']);
  }
  if (label === 'Запуск с ключа/через выключатель') {
    return normalizedTextIncludesAny(normalizedAnswer, ['key', 'ignition', 'switch', 'ключ', 'зажиган', 'выключател']);
  }
  return normalizedTextIncludesAny(normalizedAnswer, [label]);
}

function answerAlreadyCoversStartControlUncertainty(answerText: string, label: string) {
  const normalizedAnswer = normalizeModelText(answerText);
  if (!normalizedAnswerMentionsStartControlLabel(normalizedAnswer, label)) return false;
  return normalizedTextIncludesAny(normalizedAnswer, [
    'не виж',
    'не видно',
    'не указан',
    'не указано',
    'не найден',
    'не нашел',
    'не нашли',
    'не подтверж',
    'не могу подтвердить',
    'нет подтверждения',
    'точно подтвердить не могу',
    'not confirmed',
    'not found',
    'not specified',
    'unknown',
    'unclear'
  ]);
}

function coverageItemConfirmsManualStarter(coverageItem: StartControlCoverageItem) {
  if (coverageItem.status !== 'confirmed') return false;
  const text = startControlCoverageText(coverageItem);
  return normalizedTextIncludesAny(text, ['manual', 'recoil', 'ручной стартер', 'ручной запуск', 'ручн']);
}

function answerMentionsManualStarter(answerText: string) {
  const text = normalizeModelText(answerText);
  return normalizedTextIncludesAny(text, ['manual', 'recoil', 'ручной стартер', 'ручной запуск', 'ручн']);
}

function startControlConfirmedSupplementLines(coverage: unknown[], answerText: string) {
  const lines: string[] = [];
  const coverageItems = coverage
    .filter((item): item is StartControlCoverageItem => Boolean(item) && typeof item === 'object');
  if (!answerMentionsManualStarter(answerText) && coverageItems.some(coverageItemConfirmsManualStarter)) {
    lines.push('Ручной стартер тоже есть.');
  }
  return lines;
}

function startControlCoverageUncertaintyLine(coverage: unknown[], answerText = '') {
  const statements: string[] = [];
  const seen = new Set<string>();
  for (const item of coverage) {
    if (!item || typeof item !== 'object') continue;
    const coverageItem = item as StartControlCoverageItem;
    const status = coverageItem.status;
    if (typeof status !== 'string' || !startControlUncertaintyStatuses.has(status)) continue;
    for (const label of startControlCoverageLabels(coverageItem.attribute, coverageItem.value)) {
      if (seen.has(label)) continue;
      seen.add(label);
      if (answerAlreadyCoversStartControlUncertainty(answerText, label)) continue;
      const suffix = status === 'ambiguous' ? 'точно подтвердить не могу' : 'в данных не вижу';
      statements.push(`${label} ${suffix}`);
    }
  }
  return statements.length ? `${statements.join('. ')}.` : '';
}

function hasConfirmedStartControlCoverage(coverage: unknown[]) {
  return coverage.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const coverageItem = item as StartControlCoverageItem;
    return coverageItem.status === 'confirmed' &&
      (
        startControlCoverageLabels(coverageItem.attribute, coverageItem.value).length > 0 ||
        coverageItemConfirmsManualStarter(coverageItem)
      );
  });
}

function presentCatalogPresenceLine(productName: string, directAnswer: string) {
  if (textMatchesTargetName(directAnswer, productName)) {
    return 'У нас эта модель есть в каталоге.';
  }
  return `У нас ${productName} есть в каталоге.`;
}

function researchGuidanceSafeRewrite(toolResults: ToolResult[]) {
  const lines: string[] = [];
  for (const result of toolResults) {
    if (result.tool !== 'web.researchProductFacts' || result.status !== 'ok') continue;
    const payload = result.payload as {
      targetProductNames?: unknown;
      catalogPresence?: Array<{ productName?: string; status?: string }>;
      nearbyCatalogProducts?: Array<{ name?: string }>;
      answerGuidance?: {
        directAnswer?: unknown;
        coverage?: unknown;
      };
    };
    const targetNames = Array.isArray(payload.targetProductNames)
      ? payload.targetProductNames.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    if (targetNames.length !== 1) continue;
    const directAnswer = typeof payload.answerGuidance?.directAnswer === 'string'
      ? payload.answerGuidance.directAnswer.trim()
      : '';
    if (!directAnswer) continue;
    const coverage = Array.isArray(payload.answerGuidance?.coverage)
      ? payload.answerGuidance.coverage
      : [];
    const hasUncertainCoverage = coverage.some((item) => {
      if (!item || typeof item !== 'object') return false;
      const status = (item as { status?: unknown }).status;
      return status === 'not_confirmed' || status === 'ambiguous' || status === 'not_found';
    });
    const hasConfirmedStartControl = hasConfirmedStartControlCoverage(coverage);
    if (!hasUncertainCoverage && !hasConfirmedStartControl) continue;
    lines.push(directAnswer);
    lines.push(...startControlConfirmedSupplementLines(coverage, directAnswer));
    const uncertaintyLine = startControlCoverageUncertaintyLine(coverage, directAnswer);
    if (uncertaintyLine) lines.push(uncertaintyLine);
    let hasAbsentTarget = false;
    for (const presence of payload.catalogPresence ?? []) {
      if (!presence.productName) continue;
      if (presence.status === 'absent') {
        hasAbsentTarget = true;
        lines.push(`У нас точной модели ${presence.productName} в каталоге нет.`);
      } else if (presence.status === 'present') {
        lines.push(presentCatalogPresenceLine(presence.productName, directAnswer));
      }
    }
    const nearbyNames = uniqueStrings((payload.nearbyCatalogProducts ?? [])
      .map((product) => typeof product.name === 'string' ? product.name.trim() : '')
      .filter(Boolean))
      .slice(0, 4);
    if (hasAbsentTarget && nearbyNames.length) {
      lines.push(`Рядом по каталогу есть: ${nearbyNames.join('; ')}.`);
    }
  }
  return uniqueStrings(lines).join(' ').trim();
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
    evidence: nullableStringJsonSchema,
    basisKind: {
      type: ['string', 'null'],
      enum: ['exact_power', 'checked_fact', 'specific_type_or_function', 'generic_load_name', 'unknown', null]
    },
    basisSignals: {
      type: 'array',
      items: {
        type: 'string',
        enum: [
          'consumer_type_known',
          'consumer_function_known',
          'voltage_or_phase_known',
          'usage_scope_known',
          'simultaneous_operation_known',
          'buyer_requested_approximation',
          'catalog_or_web_fact',
          'explicit_power'
        ]
      }
    }
  },
  required: ['kind', 'name', 'count', 'runningKw', 'startingKw', 'source', 'evidence', 'basisKind', 'basisSignals']
} as const;

const toolArgsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: nullableStringJsonSchema,
    semanticQuery: nullableStringJsonSchema,
    productIntent: { type: ['string', 'null'], enum: [...productSelectionClasses, null] },
    limit: nullableNumberJsonSchema,
    productIds: stringArrayJsonSchema,
    productNames: stringArrayJsonSchema,
    comparisonAttributes: stringArrayJsonSchema,
    loads: { type: 'array', items: loadItemArgsJsonSchema },
    simultaneousStarting: nullableBooleanJsonSchema,
    simultaneousStartingKinds: stringArrayJsonSchema,
    estimateBasis: {
      type: ['string', 'null'],
      enum: ['exact_or_user_provided', 'catalog_or_web_fact', 'bounded_assumption', 'unbounded_guess', null]
    },
    contact: contactArgsJsonSchema,
    reason: nullableStringJsonSchema,
    notes: nullableStringJsonSchema
  },
  required: [
    'query',
    'semanticQuery',
    'productIntent',
    'limit',
    'productIds',
    'productNames',
    'comparisonAttributes',
    'loads',
    'simultaneousStarting',
    'simultaneousStartingKinds',
    'estimateBasis',
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
        riskFlags: { type: 'array', items: { type: 'string' } },
        selectionReadiness: {
          type: 'object',
          additionalProperties: false,
          properties: {
            productClass: { type: 'string' },
            status: {
              type: 'string',
              enum: ['not_applicable', 'needs_more_info', 'ready_for_preliminary_cards', 'ready_for_exact_cards']
            },
            canShowProductCards: { type: 'boolean' },
            missingFacts: { type: 'array', items: { type: 'string' } },
            rationale: { type: 'string' }
          },
          required: ['productClass', 'status', 'canShowProductCards', 'missingFacts', 'rationale']
        }
      },
      required: ['answerText', 'factsUsed', 'questionsAsked', 'toolResultIds', 'leadAction', 'riskFlags', 'selectionReadiness']
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
            'For exact technical facts about a named model that may be outside the catalog, plan web.researchProductFacts with args.productNames and comparisonAttributes. The answer should still answer the direct question if an external fact is found.',
            'When the buyer names a different exact model in the current turn, do not reuse technical facts from a previous model even if the buyer says "same". Plan current-turn evidence for the newly named model unless ledger/tool evidence is already scoped to that exact same model identifier.',
            'For generator selection, decide tool order semantically: use calculator.generatorLoad when load sizing is needed, and add catalog.search only when exact cards or clearly preliminary cards are appropriate for the current buyer request.',
            'For calculator.generatorLoad, fill args.loads with structured load items only when the dialogue gives a defensible explicit, checked, or bounded estimated basis; the runtime will not infer pump/fridge/tool loads from raw text.',
            'For calculator.generatorLoad, set args.estimateBasis: "exact_or_user_provided" for explicit powers, "catalog_or_web_fact" for checked facts, "bounded_assumption" when the buyer wants an approximate selection and the unknown load is bounded by type/function/scenario, or "unbounded_guess" when only vague load names are known.',
            'For every calculator.generatorLoad load item, set basisKind: exact_power for explicit nameplate or user kW, checked_fact for catalog or web facts, specific_type_or_function when an estimated load is bounded by a concrete type, function, or scenario, generic_load_name when only a broad name such as pump, compressor, or tool is known, and unknown when the load source itself is unclear.',
            'For every calculator.generatorLoad load item, set basisSignals from dialogue/tool facts only. Do not set basisKind=specific_type_or_function merely because a broad load class is named; "pump" alone is generic_load_name, while a borehole pump, drainage pump, circulation pump, irrigation pump, or a pump function/scenario can be specific_type_or_function.',
            'For a motor load estimate such as a pump/compressor/pressure washer, bounded_assumption requires basisKind=specific_type_or_function plus consumer_type_known or consumer_function_known and voltage_or_phase_known; otherwise use unbounded_guess and ask one minimal question.',
            'For bounded_assumption, every estimated_average load that should affect the generator calculation must include numeric runningKw or startingKw. A load with null kW is only a missing fact and will not be counted by the calculator.',
            'For a bounded unknown load, use source="estimated_average" with numeric runningKw and startingKw; do not use source="explicit_user" for a load whose kW was not explicitly provided.',
            'When the buyer asks for preliminary generator variants and the context identifies a specific motor/function plus voltage or phase, supply conservative numeric estimates for that bounded load and preserve the exact nameplate/model as a missing fact.',
            'Use canonical load kinds in args.loads.kind such as pump, refrigerator, lighting, handheld_tool, compressor, pressure_washer, boiler, television, router, laptop, or unknown_load; put descriptive wording in name/evidence, not in kind.',
            'For unknown load sources, ask the minimum useful question before exact selection: identify what the consumer does, its type/class, voltage/phase, and simultaneous operation only as needed for the current calculation.',
            'For generator selection, do not plan catalog.search when the only available load basis is an unbounded guess. Ask for the missing type/function/scenario first.',
            'If the buyer asks for preliminary minimum/reserve variants after enough load context exists for a bounded estimate, plan both calculator.generatorLoad and catalog.search; if the load context is too vague for any useful selection, plan clarification instead of catalog.search.',
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
    const styleExamples = approvedAnswerStyleExamplesPromptBlock();
    const request = {
      model: config.OPENAI_ANSWER_MODEL,
      max_output_tokens: config.OPENAI_MAX_OUTPUT_TOKENS,
      input: [
        {
          role: 'system',
          content: [
            'Ты AI менеджер-консультант БАКАУТ в чате сайта.',
            'Отвечай по-русски, кратко, понятно, как живой менеджер.',
            'Пиши как знакомый знакомому: просто, легко, без канцелярита и третьего лица. Говори от лица магазина: "у нас есть", "можем уточнить", а не "В каталоге БАКАУТ". Не используй роботизированные связки вроде "по деталям запуска"; скажи проще: "кнопочный запуск в данных не вижу" или "точно не подтверждаю".',
            'Опирайся только на ledger, catalog/tool results, checked research facts и текущий диалог.',
            'Если точного dB, наличия, доставки, скидки или срока нет в фактах, честно скажи, что это нужно уточнить, и при необходимости предложи форму.',
            'Если lead.capture вернул ok, подтверди получение контакта и не проси его повторно.',
            'Если lead.capture вернул not_found/error из-за отсутствия имени или телефона, НЕ подтверждай контакт и НЕ говори, что запрос уже передан; поставь leadAction="offer_form" и попроси оставить недостающий контакт в форме.',
            'Не задавай лишних вопросов. Если вопрос нужен, он должен быть реально нужен для следующего шага.',
            'If toolResults contains calculator.generatorLoad with status ok, treat payload.profile.requiredNominalKw and requiredStartingKw as the authoritative calculated minimum. Do not replace that number with a broader or higher default class. A higher class may be described only as comfort/reserve, not as the calculated minimum.',
            'If calculator.generatorLoad is not_found, do not invent kW values. Ask for the missing load/nameplate data or clearly say the estimate is not reliable yet.',
            'If calculator.generatorLoad warnings include generator_load_estimate_only, generator_load_unbounded_guess, generator_load_bounded_basis_incomplete, or generator_load_invalid_load_kind, do not name catalog products or prices. Set selectionReadiness.canShowProductCards=false and ask the minimum useful question to bound the unknown load source.',
            'If calculator.generatorLoad warnings include generator_load_bounded_assumption, you may show only preliminary product cards when the buyer asked for an approximate selection; keep exact missing facts in selectionReadiness.missingFacts and state the assumptions in answerText.',
            'You must set selectionReadiness for the current answer. It is your semantic decision about whether buyer-visible product cards are useful and honest now.',
            'When selectionReadiness.canShowProductCards is false, answerText must itself explain what is missing or what the next useful question is. The code will not append a canned clarification.',
            'When productClass is generator and cards are blocked, answerText must remain self-contained: explicitly mention the generator selection and the missing load/power/model fact that blocks the next step. Do not return only a bare question.',
            'Use selectionReadiness.status="needs_more_info" when product cards would be premature. Use "ready_for_preliminary_cards" only when the buyer asked for a preliminary selection and the executed tools give a usable estimated basis. Use "ready_for_exact_cards" when the facts are strong enough for exact cards.',
            'For a named model that is absent from the BAKAUT catalog but has checked external facts in web.researchProductFacts: answerText must include all three parts in this order: first answer the buyer direct technical question in simple words, then state that the exact model is not in our catalog, then mention genuinely nearby catalog models from payload.nearbyCatalogProducts when that list is non-empty. Do not omit catalog absence or nearby catalog orientation just because the direct technical fact was answered. Do not say "not found" when catalogPresence.status is "absent"; say the model is not in the catalog.',
            'Nearby means same brand plus same product class/model family first. If none are present, mention comparable same-class catalog products only as an orientation. Do not present nearby products as proof about the absent target model.',
            'Do not add availability, delivery, discount, lead form, callback, or price discussion for a pure technical fact question unless the buyer asked for those commercial terms.',
            'For plate compactors, preserve the buyer transport constraint from tool results and product cards: if the buyer will load it alone, do not recommend heavy 90+ kg plates as the first choice unless no lighter catalog candidates are present.',
            'For a small driveway/paving plate compactor that the buyer will load alone, recommend roughly 50-80 kg, usually 60-75 kg. Mention 90+ kg only as heavier than the preferred self-loading range, not as part of the first target range.',
            'When the buyer gives a budget, never present products above that budget as satisfying it. If in-budget catalog candidates exist but are weaker or compromise options, say that plainly and treat higher-priced models only as above-budget reference points.',
            'factsUsed[].sourceEventIds must contain only exact strings from availableEvidenceSources.allowedSourceIds. Do not invent source ids from fact names.',
            'If a fact comes from a tool result, cite the tool request id. If it comes from ledger, cite the ledger event id. toolResultIds must contain only current tool request ids.',
            'For a pure availability/delivery/discount handoff where no exact live status is known, keep factsUsed empty unless you explicitly use catalog or checked research facts.',
            'If requiredResponseClauses is non-empty, answerText must satisfy every clause by meaning. Treat these clauses as required semantic content, not optional style advice.',
            'If web.researchProductFacts payload.answerGuidance.directAnswer is present, use that practical direct answer before broader catalog context. Do not convert answerGuidance.coverage status "not_confirmed" into "no" or "does not have".',
            'If web.researchProductFacts has status error, timeout, denied, or not_found, do not write that facts were checked, verified, or confirmed by that research step. Give the best general answer only at the current truthful level and state that exact verification is unavailable in this turn when the buyer asked for verification.',
            styleExamples,
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
            requiredResponseClauses: input.requiredResponseClauses ?? [],
            availableEvidenceSources: answerEvidenceSourceHints(input),
            products: input.products.map(answerProductContext)
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
            'For calculator.generatorLoad, block or rewrite any answer that states a calculated minimum inconsistent with payload.profile.requiredNominalKw/requiredStartingKw.',
            'For generator answers, require rewrite if the answer names catalog products, prices, or product cards when tool results include generator_load_estimate_only, generator_load_unbounded_guess, generator_load_bounded_basis_incomplete, generator_load_invalid_load_kind, or catalog_search_skipped:generator_load_unconfirmed_basis.',
            'For generator_load_bounded_assumption, allow preliminary product cards only when the answer labels them as approximate, preserves missing exact facts, and does not present assumptions as confirmed nameplate data.',
            'For a generator clarification answer with selectionReadiness.canShowProductCards=false, require rewrite if the answer is only a short question or does not explicitly mention generator selection plus the missing load/power/model fact.',
            'For catalog.search plate results, block or rewrite any first-choice recommendation that ignores an explicit self-loading/light transport constraint when lighter product cards are available.',
            'For self-loading small-site plate compactor advice, require rewrite if the answer recommends 90 kg as part of the primary target range instead of treating it as a heavier fallback.',
            'For a pure technical fact question about an exact model absent from catalog, require rewrite if the answer skips a checked web fact, omits catalogPresence.status="absent", omits non-empty nearbyCatalogProducts, fails to separate external facts from BAKAUT catalog facts, says only that it cannot answer, or adds unsolicited availability, delivery, discount, lead, callback, or price discussion.',
            'For every item in requiredResponseClauses, check whether answer.answerText contains the clause by meaning. If any required clause is missing, return rewrite_required and revise the answer by adding the missing content while preserving correct existing facts.',
            'For web.researchProductFacts answerGuidance.coverage, require rewrite if the answer turns not_confirmed/ambiguous/not_found into a categorical negative claim. It may say the control was not confirmed, not that it is absent.',
            'Require rewrite if the answer is formally correct but sounds like an internal report: third-person catalog wording, "В каталоге БАКАУТ...", "По деталям запуска...", or similar robotic source labels. Rewrite it as simple conversational Russian from our shop voice.',
            'Не оценивай стиль субъективно. Верни только JSON PreSendReview.'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            ledger: compactLedger(input.ledgerState),
            intent: input.intent,
            toolResults: input.toolResults,
            requiredResponseClauses: input.requiredResponseClauses ?? [],
            products: input.products.map(answerProductContext),
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
    const plannedIntent = await this.model.planTurn({ session: input.session, history, userMessage, ledgerEvents: [...ledgerEvents, ...newEvents], ledgerState, signal: input.signal });
    const intent = repairIntentForExactModelEvidence(plannedIntent, userMessage);
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

    const requiredResponseClauses = requiredResponseClausesForToolResults(toolResults);
    const rawAnswer = await this.model.composeAnswer({
      session: input.session,
      history,
      userMessage,
      ledgerEvents: [...ledgerEvents, ...newEvents],
      ledgerState,
      intent,
      toolResults,
      products,
      requiredResponseClauses,
      signal: input.signal
    });
    const answer = normalizeAnswerEvidenceSources({
      answer: rawAnswer,
      ledgerState,
      toolResults
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
      requiredResponseClauses,
      answer,
      signal: input.signal
    });
    let finalText = review.verdict === 'rewrite_required' && review.revisedAnswerText?.trim()
      ? review.revisedAnswerText.trim()
      : answer.answerText.trim();
    const finalLeadAction = review.issues.some((issue) =>
      issue.code === 'lead_capture_missing_contact_offer_form' || issue.code === 'lead_capture_missing_name'
    )
      ? 'offer_form'
      : answer.leadAction;
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
    const initialAnswerContract: AnswerContract = {
      ...answer,
      answerText: finalText,
      leadAction: finalLeadAction
    };
    const initialCardSelection = selectProductsForVisibleCards({
      products,
      userMessage,
      history,
      intent,
      answerText: finalText,
      needState: needStateSnapshot
    });
    const selectionReadiness = assessVisibleCardReadiness({
      cardSelection: initialCardSelection,
      answer: initialAnswerContract,
      toolResults
    });
    const cardSelection = suppressVisibleCardsForReadiness({
      cardSelection: initialCardSelection,
      readiness: selectionReadiness
    });
    const finalAnswerContract: AnswerContract = {
      ...answer,
      answerText: finalText,
      leadAction: finalLeadAction,
      riskFlags: selectionReadiness.status !== 'ready_for_cards'
        ? uniqueStrings([...answer.riskFlags, 'selection_readiness_blocked_cards'])
        : answer.riskFlags
    };
    await this.conversations.saveAnswerContract({
      sessionId: input.sessionId,
      turnId: input.turnId,
      answerText: finalText,
      contract: finalAnswerContract,
      review,
      status: 'final'
    });
    const cards = productCards(cardSelection.products, ['Найдено в каталоге под текущий запрос.']);
    const runtimeDecision = getAgentManagerRuntimeDecision(input.session);
    const metadata = {
      agentManager: true,
      runtimeMode: runtimeDecision.runtimeMode,
      runtimeModeReason: runtimeDecision.reason,
      agentManagerRuntime: runtimeDecision,
      recovered: input.recovered,
      turnId: input.turnId,
      ledgerState,
      ledgerEventIds: newEvents.map((event) => event.eventId),
      intentContract: intent,
      answerContract: finalAnswerContract,
      preSendReview: review,
      toolResults,
      cardSelection,
      selectionReadiness,
      productCards: cards,
      needStateSnapshot,
      warnings: [
        ...ledgerState.warnings,
        ...toolResults.flatMap((result) => result.warnings),
        ...cardSelection.warnings,
        ...selectionReadiness.warnings
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
      usedWebSearch: toolResults.some((result) =>
        result.tool === 'web.researchProductFacts' &&
        result.status === 'ok' &&
        (result.payload as { usedWebSearch?: unknown }).usedWebSearch === true
      ),
      leadRequested: finalLeadAction === 'offer_form',
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
          const { query, semanticQuery } = toolRequestScopedQuery(request, input.userMessage);
          const limit = Math.max(1, Math.min(12, Number(request.args.limit ?? 8)));
          const productIntent = toolRequestProductIntent(request, [input.userMessage, semanticQuery, request.rationale].join('\n'));
          if (isGeneratorProductClass(productIntent) && hasUnconfirmedGeneratorLoadBasisResult(toolResults)) {
            result = ToolResultSchema.parse({
              requestId: request.id,
              tool: request.tool,
              status: 'denied',
              payload: {
                query,
                productIntent,
                reason: 'generator_load_unconfirmed_basis'
              },
              warnings: ['catalog_search_skipped:generator_load_unconfirmed_basis']
            });
          } else {
            const search = await this.searchCatalogProducts({
              query,
              limit,
              signal: input.signal,
              userMessage: input.userMessage,
              semanticContext: [semanticQuery, input.userMessage, request.rationale].join('\n'),
              productIntent,
              embeddingQuery: semanticQuery
            });
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
                  intent: search.productIntent,
                  query: search.query,
                  embeddingQuery: search.embeddingQuery,
                  textCount: search.textCount,
                  vectorCount: search.vectorCount,
                  usedEmbeddings: search.vectorCount > 0
                }
              },
              warnings: products.length ? search.warnings : [...search.warnings, 'catalog_search_no_matches']
            });
          }
        } else if (request.tool === 'catalog.getProductDetails') {
          const names = Array.isArray(request.args.productNames)
            ? request.args.productNames.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            : [];
          const queries = names.length
            ? names
            : [typeof request.args.query === 'string' && request.args.query.trim() ? request.args.query : input.userMessage];
          const productIntent = toolRequestProductIntent(request, input.userMessage);
          const semanticQuery = toolRequestScopedQuery(request, input.userMessage).semanticQuery;
          if (isGeneratorProductClass(productIntent) && hasUnconfirmedGeneratorLoadBasisResult(toolResults)) {
            result = ToolResultSchema.parse({
              requestId: request.id,
              tool: request.tool,
              status: 'denied',
              payload: {
                productIntent,
                reason: 'generator_load_unconfirmed_basis'
              },
              warnings: ['product_details_skipped:generator_load_unconfirmed_basis']
            });
          } else {
            for (const query of queries.slice(0, 4)) {
              const found = await this.searchCatalogProducts({
                query,
                limit: 4,
                signal: input.signal,
                userMessage: input.userMessage,
                semanticContext: [semanticQuery, query, input.userMessage, request.rationale].join('\n'),
                productIntent,
                embeddingQuery: semanticQuery
              });
              found.products.forEach((product) => productsById.set(product.id, product));
            }
            result = ToolResultSchema.parse({
              requestId: request.id,
              tool: request.tool,
              status: productsById.size ? 'ok' : 'not_found',
              payload: { productIds: [...productsById.keys()], products: [...productsById.values()] },
              warnings: productsById.size ? [] : ['product_details_no_matches']
            });
          }
        } else if (request.tool === 'calculator.generatorLoad') {
          const { loads, profile, estimateBasis, warnings } = buildGeneratorLoadToolPayload({
            request,
            userMessage: input.userMessage
          });
          result = ToolResultSchema.parse({
            requestId: request.id,
            tool: request.tool,
            status: profile ? 'ok' : 'not_found',
            payload: { loads, profile, estimateBasis },
            warnings: profile ? warnings : [...warnings, 'no_usable_loads_for_generator_calculation']
          });
        } else if (request.tool === 'web.researchProductFacts') {
          const targetProductNames = targetProductNamesForRequest(request);
          const comparisonAttributes = comparisonAttributesForRequest(request);
          if (productsById.size < 2 || targetProductNames.length) {
            const scopedQuery = toolRequestScopedQuery(request, input.userMessage);
            const lookupQuery = targetProductNames.length
              ? targetProductNames.join(' ')
              : input.userMessage;
            const found = await this.searchCatalogProducts({
              query: lookupQuery,
              limit: 4,
              signal: input.signal,
              userMessage: input.userMessage,
              semanticContext: [scopedQuery.semanticQuery, lookupQuery, input.userMessage, request.rationale].join('\n'),
              productIntent: toolRequestProductIntent(request, input.userMessage),
              embeddingQuery: scopedQuery.semanticQuery
            });
            found.products.forEach((product) => productsById.set(product.id, product));
          }
          const selectedProducts = [...productsById.values()].slice(0, 4);
          const research = await researchProductComparisonFacts({
            userMessage: input.userMessage,
            products: selectedProducts,
            targetProductNames,
            comparisonAttributes,
            signal: input.signal
          });
          const catalogPresence = catalogPresenceForTargets(targetProductNames, selectedProducts);
          const nearbyCatalogProducts = nearbyCatalogProductsForTargets(targetProductNames, selectedProducts);
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
            status: research.warnings.includes('not_enough_products_for_comparison') && !targetProductNames.length ? 'not_found' : 'ok',
            payload: {
              ...research,
              targetProductNames,
              comparisonAttributes,
              catalogPresence,
              nearbyCatalogProducts
            },
            warnings: [
              ...research.warnings,
              ...catalogPresence
                .filter((item) => item.status === 'absent')
                .map((item) => `exact_catalog_product_absent:${item.productName}`)
            ]
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

  private async searchCatalogProducts(input: {
    query: string;
    limit: number;
    signal?: AbortSignal;
    userMessage?: string;
    semanticContext?: string;
    productIntent?: ProductSelectionClass;
    embeddingQuery?: string;
  }) {
    const query = input.query;
    const limit = input.limit;
    const semanticContext = input.semanticContext ?? query;
    const productIntent = input.productIntent && input.productIntent !== 'unknown'
      ? input.productIntent
      : inferProductIntent(semanticContext);
    const embeddingQuery = input.embeddingQuery?.trim() || query;
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
      const embedding = await this.createCachedQueryEmbedding(embeddingQuery, input.signal);
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
    const matchingProducts = productIntent === 'unknown'
      ? mergedProducts
      : mergedProducts.filter((product) => productMatchesIntent(product, productIntent));
    if (productIntent !== 'unknown' && matchingProducts.length !== mergedProducts.length) {
      warnings.push(`catalog_products_filtered_by_intent:${productIntent}:${mergedProducts.length - matchingProducts.length}`);
    }
    const rankedProducts = rankCatalogProductsByNumericFit({
      products: matchingProducts,
      intent: productIntent,
      query,
      semanticContext,
      userMessage: input.userMessage ?? query
    });
    const products = rankedProducts.slice(0, limit);
    if (!products.length && firstError) throw firstError;
    return {
      query,
      embeddingQuery,
      productIntent,
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
      const contactMissing = leadCaptureMissingContact(input.toolResults);
      if (contactMissing && !hasLeadContact(contactInTurn)) {
        mechanicalIssues.push({
          code: 'lead_capture_missing_contact_offer_form',
          severity: 'medium',
          message: 'The answer tried to confirm a lead before the buyer provided contact data; rewrite to offer the contact form.',
          evidence: JSON.stringify(input.toolResults.filter((result) => result.tool === 'lead.capture'))
        });
      } else if (contactMissing && hasLeadContact(contactInTurn) && leadCaptureMissingName(input.toolResults)) {
        mechanicalIssues.push({
          code: 'lead_capture_missing_name',
          severity: 'medium',
          message: 'The answer tried to confirm a lead before the buyer provided a name; rewrite to acknowledge the phone and ask for the missing name.',
          evidence: JSON.stringify(input.toolResults.filter((result) => result.tool === 'lead.capture'))
        });
      } else {
        mechanicalIssues.push({
          code: 'lead_confirmation_without_local_capture',
          severity: 'high',
          message: 'The bot may confirm a contact only after local lead and outbox capture succeeded.',
          evidence: JSON.stringify(input.toolResults.filter((result) => result.tool === 'lead.capture'))
        });
      }
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
    const safeResearchRewrite = researchGuidanceSafeRewrite(input.toolResults);
    if (safeResearchRewrite && safeResearchRewrite !== input.answer.answerText.trim()) {
      mechanicalIssues.push({
        code: 'research_guidance_uncertainty_safe_rewrite',
        severity: 'high',
        message: 'Exact-model research has unconfirmed or ambiguous coverage; use checked answerGuidance instead of a broader generated claim.',
        evidence: safeResearchRewrite
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
    const leadCaptureRepairIssue = mechanicalIssues.find((issue) =>
      issue.code === 'lead_capture_missing_contact_offer_form' || issue.code === 'lead_capture_missing_name'
    );
    if (leadCaptureRepairIssue) {
      return {
        verdict: 'rewrite_required',
        issues: mechanicalIssues,
        revisedAnswerText: leadCaptureRepairText({ contact: contactInTurn, toolResults: input.toolResults })
      };
    }
    const researchGuidanceRepairIssue = mechanicalIssues.find((issue) => issue.code === 'research_guidance_uncertainty_safe_rewrite');
    if (researchGuidanceRepairIssue && safeResearchRewrite) {
      return {
        verdict: 'rewrite_required',
        issues: mechanicalIssues,
        revisedAnswerText: safeResearchRewrite
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
    const runtimeDecision = getAgentManagerRuntimeDecision(session);
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
        runtimeMode: runtimeDecision.runtimeMode,
        runtimeModeReason: runtimeDecision.reason,
        agentManagerRuntime: runtimeDecision,
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
    const runtimeDecision = getAgentManagerRuntimeDecision(session);
    const metadata = {
      agentManager: true,
      runtimeMode: runtimeDecision.runtimeMode,
      runtimeModeReason: runtimeDecision.reason,
      agentManagerRuntime: runtimeDecision,
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
