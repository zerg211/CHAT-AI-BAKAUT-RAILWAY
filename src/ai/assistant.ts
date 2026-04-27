import { config } from '../config.js';
import { ConversationRepository, ProductRepository } from '../db/repositories.js';
import yaml from 'js-yaml';
import type { ChatResponsePayload, CustomerNeedState, DataConflict, Message, Product, ProductCard } from '../shared/types.js';
import { buildAssistantContext, buildNeedExtractorPrompt, buildSystemPrompt, buildTurnPlannerPrompt } from './prompts.js';
import { createEmbedding, createOpenAIClient } from './openaiClient.js';
import { emptyNeedState, mergeNeedState, summarizeNeedState } from './needState.js';

function cleanEmpty(obj: any): any {
  if (obj === null || obj === undefined || obj === '') return undefined;
  if (Array.isArray(obj)) {
    const cleaned = obj.map(cleanEmpty).filter((v) => v !== undefined);
    return cleaned.length > 0 ? cleaned : undefined;
  }
  if (typeof obj === 'object') {
    const cleaned: Record<string, any> = {};
    for (const [key, val] of Object.entries(obj)) {
      const v = cleanEmpty(val);
      if (v !== undefined) cleaned[key] = v;
    }
    return Object.keys(cleaned).length > 0 ? cleaned : undefined;
  }
  return obj;
}

interface GenerateAnswerInput {
  sessionId: string;
  userMessage: string;
  onDelta?: (text: string) => void | Promise<void>;
  signal?: AbortSignal;
}

type WebCitation = {
  url: string;
  title?: string;
  snippet?: string;
};

type AssistantTurnAction =
  | 'answer_question'
  | 'recommend_products'
  | 'ask_clarifying_question'
  | 'verify_with_web'
  | 'collect_lead'
  | 'handoff_specialist';

type AnswerMode =
  | 'short'
  | 'productRecommendation'
  | 'detailedFact'
  | 'serviceCostComparison'
  | 'currentLineup'
  | 'leadCollection'
  | 'unknown';

type CardPolicy =
  | 'auto'
  | 'showProducts'
  | 'showAccessories'
  | 'textOnly';

type FollowUpPolicy =
  | 'auto'
  | 'answerNowNoDeferredOffer'
  | 'askClarifyingQuestion'
  | 'offerNextStepAllowed'
  | 'collectLead';

type ContextScope =
  | 'latestMessageOnly'
  | 'activeNeed'
  | 'previousSelection'
  | 'fullSession';

type SearchScope =
  | 'focusedNeed'
  | 'broadenAlternatives'
  | 'sameBrandOnly'
  | 'previousSelectionOnly';

type AssistantTurnPlan = {
  action: AssistantTurnAction;
  answerMode: AnswerMode;
  cardPolicy: CardPolicy;
  followUpPolicy: FollowUpPolicy;
  contextScope: ContextScope;
  searchScope: SearchScope;
  catalogSearchQuery: string;
  selectedProductIds: string[];
  requiredProductTraits: RequiredProductTraits;
  needsWebSearch: boolean;
  missingInformation: string[];
  answerGuidance: string;
};

type ProductIntent =
  | 'generator'
  | 'weldingGenerator'
  | 'generatorOil'
  | 'engineOil'
  | 'generatorAccessory'
  | 'plateAccessory'
  | 'plate'
  | 'rammer'
  | 'roller'
  | 'cutter'
  | 'diamondBlade'
  | 'diamondCore'
  | 'trowel'
  | 'unknown';
type ProductFuel = 'gasoline' | 'diesel' | 'any' | 'unknown';
type ProductStartType = 'electric' | 'manual' | 'any' | 'unknown';
type ProductRole = 'coreProduct' | 'accessory' | 'consumable' | 'unknown';
type ProductEnclosure = 'enclosed' | 'open' | 'any' | 'unknown';

type RequiredProductTraits = {
  productIntent: ProductIntent;
  productRole: ProductRole;
  fuel: ProductFuel;
  startType: ProductStartType;
  enclosure: ProductEnclosure;
  conventionalGenerator: boolean | null;
  singlePhase220: boolean | null;
  nominalPowerKwMin: number | null;
  nominalPowerKwMax: number | null;
  maxPowerKwMin: number | null;
  maxPowerKwMax: number | null;
  powerReasoning: string;
};

type GeneratorPowerProfile = {
  nominalMin?: number;
  nominalMax?: number;
  maxMin?: number;
  maxMax?: number;
  source: 'planner' | 'explicit_text' | 'estimated_load';
};

type ProductFitProfile = {
  intent: ProductIntent;
  activeNeedText: string;
  requestedBrands: string[];
  accessoryRequested: boolean;
  weldingRequested: boolean;
  wantsGasoline: boolean;
  wantsDiesel: boolean;
  wantsElectricStart: boolean;
  wantsInverterGenerator: boolean;
  wantsEnclosedGenerator: boolean;
  wantsConventionalGenerator: boolean;
  wantsSinglePhase220: boolean;
  desiredPowerRange?: { min: number; max: number };
  generatorPower?: GeneratorPowerProfile;
  budgetMax?: number;
  exactModelTokens: string[];
};

type CardSelectionDiagnostics = {
  profile: {
    intent: ProductIntent;
    requestedBrands: string[];
    wantsGasoline: boolean;
    wantsDiesel: boolean;
    wantsElectricStart: boolean;
    wantsInverterGenerator: boolean;
    wantsEnclosedGenerator: boolean;
    wantsConventionalGenerator: boolean;
    desiredPowerRange?: { min: number; max: number };
    generatorPower?: GeneratorPowerProfile;
    budgetMax?: number;
  };
  selectedCount: number;
  selectedRejectedCount: number;
  rankedCount: number;
  fallbackSuppressed: boolean;
  fallbackReason?: string;
};

const MAX_PRODUCT_CARDS = 10;
const PLANNER_CANDIDATE_LIMIT = 16;
const MIN_JSON_OUTPUT_TOKENS = 2400;
const PLANNER_HISTORY_LIMIT = 8;
const PLANNER_HISTORY_CONTENT_LIMIT = 700;
const PLANNER_PRODUCT_DESCRIPTION_LIMIT = 900;
const PLANNER_PAGE_SUMMARY_LIMIT = 600;
const PLANNER_PAGE_CONTENT_LIMIT = 1200;

function jsonOutputTokenLimit(value: number) {
  return Math.max(value, MIN_JSON_OUTPUT_TOKENS);
}

function truncateForAI(value: unknown, contentLimit: number) {
  const content = String(value ?? '').trim();
  return content.length > contentLimit
    ? `${content.slice(0, contentLimit).trim()}...`
    : content;
}

function compactHistoryForAI(history: Message[], limit: number, contentLimit: number) {
  return history.slice(-limit).map((message) => ({
    role: message.role,
    content: truncateForAI(message.content, contentLimit)
  }));
}

function parseJsonObject(outputText: string | undefined, stage: string) {
  const cleaned = String(outputText ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  if (!cleaned) throw new Error(`${stage} returned empty JSON`);
  return JSON.parse(cleaned);
}

function toNeedItems(items: unknown) {
  if (!Array.isArray(items)) return [];
  const now = new Date().toISOString();
  return items
    .filter((item) => item && typeof item === 'object')
    .map((item: any) => ({
      value: String(item.value ?? '').trim(),
      evidence: String(item.evidence ?? '').trim(),
      confidence: Math.max(0, Math.min(1, Number(item.confidence ?? 0.4))),
      updatedAt: now
    }))
    .filter((item) => item.value.length > 0);
}

function coerceNeedUpdate(value: any): Partial<CustomerNeedState> {
  return {
    explicitNeeds: toNeedItems(value?.explicitNeeds),
    implicitNeeds: toNeedItems(value?.implicitNeeds),
    constraints: toNeedItems(value?.constraints),
    importantCriteria: toNeedItems(value?.importantCriteria),
    confirmedFacts: toNeedItems(value?.confirmedFacts),
    uncertainInferences: toNeedItems(value?.uncertainInferences),
    contradictions: toNeedItems(value?.contradictions),
    featureSignals: {
      portable: Number(value?.featureSignals?.portable ?? 0),
      homeUse: Number(value?.featureSignals?.homeUse ?? 0),
      compact: Number(value?.featureSignals?.compact ?? 0),
      lowNoise: Number(value?.featureSignals?.lowNoise ?? 0),
      coldStart: Number(value?.featureSignals?.coldStart ?? 0),
      professionalDuty: Number(value?.featureSignals?.professionalDuty ?? 0),
      budgetSensitive: Number(value?.featureSignals?.budgetSensitive ?? 0)
    },
    lastSummary: typeof value?.lastSummary === 'string' ? value.lastSummary : ''
  };
}

function coerceProductIntent(value: unknown): ProductIntent {
  const allowed: ProductIntent[] = [
    'generator',
    'weldingGenerator',
    'generatorOil',
    'engineOil',
    'generatorAccessory',
    'plateAccessory',
    'plate',
    'rammer',
    'roller',
    'cutter',
    'diamondBlade',
    'diamondCore',
    'trowel',
    'unknown'
  ];
  return allowed.includes(value as ProductIntent) ? value as ProductIntent : 'unknown';
}

function coerceFuel(value: unknown): ProductFuel {
  const allowed: ProductFuel[] = ['gasoline', 'diesel', 'any', 'unknown'];
  return allowed.includes(value as ProductFuel) ? value as ProductFuel : 'unknown';
}

function coerceStartType(value: unknown): ProductStartType {
  const allowed: ProductStartType[] = ['electric', 'manual', 'any', 'unknown'];
  return allowed.includes(value as ProductStartType) ? value as ProductStartType : 'unknown';
}

function coerceProductRole(value: unknown): ProductRole {
  const allowed: ProductRole[] = ['coreProduct', 'accessory', 'consumable', 'unknown'];
  return allowed.includes(value as ProductRole) ? value as ProductRole : 'unknown';
}

function coerceProductEnclosure(value: unknown): ProductEnclosure {
  const allowed: ProductEnclosure[] = ['enclosed', 'open', 'any', 'unknown'];
  return allowed.includes(value as ProductEnclosure) ? value as ProductEnclosure : 'unknown';
}

function coerceAnswerMode(value: unknown): AnswerMode {
  const allowed: AnswerMode[] = [
    'short',
    'productRecommendation',
    'detailedFact',
    'serviceCostComparison',
    'currentLineup',
    'leadCollection',
    'unknown'
  ];
  return allowed.includes(value as AnswerMode) ? value as AnswerMode : 'unknown';
}

function coerceCardPolicy(value: unknown): CardPolicy {
  const allowed: CardPolicy[] = ['auto', 'showProducts', 'showAccessories', 'textOnly'];
  return allowed.includes(value as CardPolicy) ? value as CardPolicy : 'auto';
}

function coerceFollowUpPolicy(value: unknown): FollowUpPolicy {
  const allowed: FollowUpPolicy[] = [
    'auto',
    'answerNowNoDeferredOffer',
    'askClarifyingQuestion',
    'offerNextStepAllowed',
    'collectLead'
  ];
  return allowed.includes(value as FollowUpPolicy) ? value as FollowUpPolicy : 'auto';
}

function coerceContextScope(value: unknown): ContextScope {
  const allowed: ContextScope[] = ['latestMessageOnly', 'activeNeed', 'previousSelection', 'fullSession'];
  return allowed.includes(value as ContextScope) ? value as ContextScope : 'activeNeed';
}

function coerceSearchScope(value: unknown): SearchScope {
  const allowed: SearchScope[] = ['focusedNeed', 'broadenAlternatives', 'sameBrandOnly', 'previousSelectionOnly'];
  return allowed.includes(value as SearchScope) ? value as SearchScope : 'focusedNeed';
}

function coerceNullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function coerceNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function emptyRequiredProductTraits(): RequiredProductTraits {
  return {
    productIntent: 'unknown',
    productRole: 'unknown',
    fuel: 'unknown',
    startType: 'unknown',
    enclosure: 'unknown',
    conventionalGenerator: null,
    singlePhase220: null,
    nominalPowerKwMin: null,
    nominalPowerKwMax: null,
    maxPowerKwMin: null,
    maxPowerKwMax: null,
    powerReasoning: ''
  };
}

function coerceRequiredProductTraits(value: any): RequiredProductTraits {
  const fallback = emptyRequiredProductTraits();
  if (!value || typeof value !== 'object') return fallback;
  return {
    productIntent: coerceProductIntent(value.productIntent),
    productRole: coerceProductRole(value.productRole),
    fuel: coerceFuel(value.fuel),
    startType: coerceStartType(value.startType),
    enclosure: coerceProductEnclosure(value.enclosure),
    conventionalGenerator: coerceNullableBoolean(value.conventionalGenerator),
    singlePhase220: coerceNullableBoolean(value.singlePhase220),
    nominalPowerKwMin: coerceNullableNumber(value.nominalPowerKwMin),
    nominalPowerKwMax: coerceNullableNumber(value.nominalPowerKwMax),
    maxPowerKwMin: coerceNullableNumber(value.maxPowerKwMin),
    maxPowerKwMax: coerceNullableNumber(value.maxPowerKwMax),
    powerReasoning: String(value.powerReasoning ?? '').trim().slice(0, 800)
  };
}

function coerceTurnPlan(value: any, baseQuery: string, latestUserMessage = baseQuery): AssistantTurnPlan {
  const allowedActions: AssistantTurnAction[] = [
    'answer_question',
    'recommend_products',
    'ask_clarifying_question',
    'verify_with_web',
    'collect_lead',
    'handoff_specialist'
  ];
  const action = allowedActions.includes(value?.action) ? value.action as AssistantTurnAction : 'answer_question';
  const selectedProductIds = Array.isArray(value?.selectedProductIds)
    ? value.selectedProductIds.map((id: unknown) => String(id)).filter(Boolean).slice(0, MAX_PRODUCT_CARDS)
    : [];
  const missingInformation = Array.isArray(value?.missingInformation)
    ? value.missingInformation.map((item: unknown) => String(item).trim()).filter(Boolean).slice(0, 6)
    : [];
  const contextScope = coerceContextScope(value?.contextScope);
  const scopedFallbackQuery = contextScope === 'latestMessageOnly' ? latestUserMessage : baseQuery;
  const rawCatalogSearchQuery = contextScope === 'latestMessageOnly'
    ? latestUserMessage
    : value?.catalogSearchQuery ?? scopedFallbackQuery;
  const catalogSearchQuery = String(rawCatalogSearchQuery).trim() || scopedFallbackQuery;

  return {
    action,
    answerMode: coerceAnswerMode(value?.answerMode),
    cardPolicy: coerceCardPolicy(value?.cardPolicy),
    followUpPolicy: coerceFollowUpPolicy(value?.followUpPolicy),
    contextScope,
    searchScope: coerceSearchScope(value?.searchScope),
    catalogSearchQuery: catalogSearchQuery.slice(0, 1200),
    selectedProductIds,
    requiredProductTraits: coerceRequiredProductTraits(value?.requiredProductTraits),
    needsWebSearch: Boolean(value?.needsWebSearch),
    missingInformation,
    answerGuidance: String(value?.answerGuidance ?? '').trim().slice(0, 2000)
  };
}

function compactTurnPlanForAnswer(plan: AssistantTurnPlan): AssistantTurnPlan {
  return {
    ...plan,
    missingInformation: plan.missingInformation.slice(0, 4),
    answerGuidance: truncateForAI(plan.answerGuidance, 700)
  };
}

function fallbackTurnPlan(input: { userMessage: string; needState: CustomerNeedState; baseQuery: string }): AssistantTurnPlan {
  const profile = buildProductFitProfile(input.needState, input.userMessage, input.baseQuery);
  const traits = emptyRequiredProductTraits();
  const currentLineupQuestion = shouldUseCurrentLineupStyle(input.userMessage);
  const ownershipCostQuestion = fallbackDetectOwnershipCostQuestion(input.userMessage);
  const leadAction = fallbackDetectPurchaseIntent(input.userMessage);
  const answerMode: AnswerMode = leadAction
    ? 'leadCollection'
    : currentLineupQuestion
      ? 'currentLineup'
      : ownershipCostQuestion
        ? 'serviceCostComparison'
        : profile.intent === 'unknown'
          ? 'short'
          : 'productRecommendation';
  traits.productIntent = profile.intent;
  traits.productRole = profile.accessoryRequested ? 'accessory' : profile.intent === 'unknown' ? 'unknown' : 'coreProduct';
  traits.fuel = profile.wantsGasoline ? 'gasoline' : profile.wantsDiesel ? 'diesel' : 'unknown';
  traits.startType = profile.wantsElectricStart ? 'electric' : 'unknown';
  traits.enclosure = profile.wantsEnclosedGenerator ? 'enclosed' : 'unknown';
  traits.conventionalGenerator = profile.wantsConventionalGenerator || null;
  traits.singlePhase220 = profile.wantsSinglePhase220 || null;
  traits.nominalPowerKwMin = profile.generatorPower?.nominalMin ?? null;
  traits.nominalPowerKwMax = profile.generatorPower?.nominalMax ?? null;
  traits.maxPowerKwMin = profile.generatorPower?.maxMin ?? null;
  traits.maxPowerKwMax = profile.generatorPower?.maxMax ?? null;
  traits.powerReasoning = profile.generatorPower
    ? `Fallback estimate from current need, source: ${profile.generatorPower.source}`
    : '';

  return {
    action: leadAction
      ? 'collect_lead'
      : ownershipCostQuestion || currentLineupQuestion
        ? 'verify_with_web'
        : profile.intent === 'unknown'
          ? 'answer_question'
          : 'recommend_products',
    answerMode,
    cardPolicy: answerMode === 'serviceCostComparison' || answerMode === 'currentLineup'
      ? 'textOnly'
      : answerMode === 'productRecommendation'
        ? 'showProducts'
        : 'auto',
    followUpPolicy: answerMode === 'serviceCostComparison' || answerMode === 'currentLineup'
      ? 'answerNowNoDeferredOffer'
      : answerMode === 'leadCollection'
        ? 'collectLead'
        : 'auto',
    contextScope: currentLineupQuestion ? 'latestMessageOnly' : 'activeNeed',
    searchScope: 'focusedNeed',
    catalogSearchQuery: input.baseQuery,
    selectedProductIds: [],
    requiredProductTraits: traits,
    needsWebSearch: false,
    missingInformation: [],
    answerGuidance: 'Служебный планировщик не вернул валидный JSON. Ответь по текущей реплике и сохраненной потребности, без выдумывания фактов.'
  };
}

function productSearchText(message: string, state: CustomerNeedState) {
  const activeValues = (items: CustomerNeedState['explicitNeeds']) =>
    items.filter((item) => item.confidence >= 0.32).map((item) => item.value).join(' ');
  const parts = [
    message,
    activeValues(state.explicitNeeds),
    activeValues(state.implicitNeeds),
    activeValues(state.constraints),
    activeValues(state.importantCriteria)
  ];
  return parts.filter(Boolean).join(' ').slice(0, 1200);
}

function deriveConversationTopic(userMessage: string, state: CustomerNeedState) {
  const values = [
    state.explicitNeeds.find((item) => item.confidence >= 0.45)?.value,
    state.importantCriteria.find((item) => item.confidence >= 0.5)?.value,
    state.lastSummary,
    userMessage
  ];
  const raw = values.find((value) => value && value.trim().length >= 8) ?? userMessage;
  const cleaned = raw
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/^(здравствуйте|добрый день|привет|подскажите|посоветуйте|помогите|нужен|нужна|нужно|хочу)\b[,.!\s-]*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'Новая консультация';
  return cleaned.length > 70 ? `${cleaned.slice(0, 67).trim()}...` : cleaned;
}

const fromEscaped = (value: string) => JSON.parse(`"${value}"`) as string;
const weightRegex = new RegExp(String.raw`(\d{2,4})\s*(?:\u043a\u0433|kg)`, 'i');
const powerRegex = new RegExp(String.raw`(\d+(?:[,.]\d+)?)\s*(?:\u043a\u0432\u0442|kw|kva|\u043a\u0432\u0430)`, 'i');
const powerRangeRegex = new RegExp(String.raw`(\d+(?:[,.]\d+)?)\s*(?:-|–|—|\u0434\u043e)\s*(\d+(?:[,.]\d+)?)\s*(?:\u043a\u0432\u0442|kw|kva|\u043a\u0432\u0430)`, 'i');
const budgetMaxRegex = new RegExp(String.raw`(?:\u0434\u043e|budget\s*(?:up\s*to)?|max|maximum|<=?)\s*(\d+(?:[,.]\d+)?)\s*(?:\u0442\u044b\u0441(?:\u044f\u0447)?|\u0442\.?\s*\u0440\.?|\u0440\u0443\u0431|rub|₽)?`, 'i');
const plateTerms = ['vibroplity', 'vibroplita', 'виброплит', fromEscaped('\\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442')];
const generatorTerms = ['generator', 'generatory', 'генерат', 'электростанц', fromEscaped('\\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442'), fromEscaped('\\u044d\\u043b\\u0435\\u043a\\u0442\\u0440\\u043e\\u0441\\u0442\\u0430\\u043d\\u0446')];
const rammerTerms = ['rammer', 'трамбовк', 'виброног', fromEscaped('\\u0442\\u0440\\u0430\\u043c\\u0431\\u043e\\u0432\\u043a'), fromEscaped('\\u0432\\u0438\\u0431\\u0440\\u043e\\u043d\\u043e\\u0433')];
const cutterTerms = ['cutter', 'резчик', 'швонарез', fromEscaped('\\u0440\\u0435\\u0437\\u0447\\u0438\\u043a'), fromEscaped('\\u0448\\u0432\\u043e\\u043d\\u0430\\u0440\\u0435\\u0437')];
const diamondBladeTerms = [
  'diamond blade',
  'almaz',
  fromEscaped('\\u0430\\u043b\\u043c\\u0430\\u0437'),
  fromEscaped('\\u0434\\u0438\\u0441\\u043a'),
  fromEscaped('\\u043a\\u0440\\u0443\\u0433'),
  fromEscaped('\\u043a\\u0435\\u0440\\u0430\\u043c\\u043e\\u0433\\u0440\\u0430\\u043d\\u0438\\u0442'),
  fromEscaped('\\u043a\\u0435\\u0440\\u0430\\u043c\\u0438\\u043a'),
  fromEscaped('\\u043f\\u043b\\u0438\\u0442\\u043a\\u043e\\u0440\\u0435\\u0437')
];
const weightTerms = [
  fromEscaped('\\u0432\\u0435\\u0441'),
  fromEscaped('\\u043f\\u0435\\u0440\\u0435\\u043d\\u043e\\u0441'),
  fromEscaped('\\u0433\\u0430\\u0431\\u0430\\u0440\\u0438\\u0442'),
  fromEscaped('\\u0436\\u0435\\u043d\\u0430'),
  fromEscaped('\\u0436\\u0435\\u043d\\u044b'),
  fromEscaped('\\u043b\\u0435\\u0433\\u043a'),
  fromEscaped('\\u0442\\u044f\\u0436\\u0435\\u043b'),
  fromEscaped('\\u0442\\u0430\\u0441\\u043a'),
  fromEscaped('\\u0440\\u0443\\u043a\\u0430\\u043c'),
  fromEscaped('\\u043e\\u0434\\u043d\\u043e\\u043c\\u0443'),
  fromEscaped('\\u043e\\u0434\\u043d\\u0430'),
  fromEscaped('\\u043a\\u043e\\u043c\\u043f\\u0430\\u043a\\u0442')
];
const homeTerms = [
  fromEscaped('\\u0434\\u0430\\u0447'),
  fromEscaped('\\u0431\\u044b\\u0442\\u043e\\u0432'),
  fromEscaped('\\u0443\\u0447\\u0430\\u0441\\u0442')
];
const inverterTerms = ['invertor', 'inverter', fromEscaped('\\u0438\\u043d\\u0432\\u0435\\u0440\\u0442\\u043e\\u0440')];
const dieselTerms = ['diesel', 'dizel', 'дизел', fromEscaped('\\u0434\\u0438\\u0437\\u0435\\u043b')];
const gasolineTerms = ['benzin', 'бензин', fromEscaped('\\u0431\\u0435\\u043d\\u0437\\u0438\\u043d')];
const professionalTerms = [
  fromEscaped('\\u043f\\u0440\\u043e\\u0444'),
  fromEscaped('\\u043f\\u0440\\u043e\\u043c\\u044b\\u0448\\u043b'),
  fromEscaped('\\u0440\\u0435\\u0432\\u0435\\u0440\\u0441'),
  'wacker',
  'husqvarna',
  'bomag',
  'ammann'
];
const coldStartTerms = [
  'электростарт',
  'стартер',
  fromEscaped('\\u044d\\u043b\\u0435\\u043a\\u0442\\u0440\\u043e\\u0441\\u0442\\u0430\\u0440\\u0442'),
  fromEscaped('\\u0441\\u0442\\u0430\\u0440\\u0442\\u0435\\u0440'),
  fromEscaped('\\u043f\\u043e\\u0434\\u043e\\u0433\\u0440\\u0435\\u0432'),
  fromEscaped('\\u0437\\u0438\\u043c'),
  fromEscaped('\\u043c\\u043e\\u0440\\u043e\\u0437')
];
const quietTerms = [
  fromEscaped('\\u0442\\u0438\\u0445'),
  fromEscaped('\\u0448\\u0443\\u043c\\u043e\\u0438\\u0437\\u043e\\u043b'),
  fromEscaped('\\u043a\\u043e\\u0436\\u0443\\u0445'),
  fromEscaped('\\u0437\\u0430\\u043a\\u0440\\u044b\\u0442')
];
const accessoryTerms = [
  'кожухи для генератора',
  'расходник',
  'масло для генератора',
  'система эл.подогрева',
  'фильтр',
  'ремень',
  'блоки авр',
  'блок авр',
  fromEscaped('\\u043a\\u043e\\u0436\\u0443\\u0445\\u0438 \\u0434\\u043b\\u044f \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u0430'),
  fromEscaped('\\u0440\\u0430\\u0441\\u0445\\u043e\\u0434\\u043d\\u0438\\u043a'),
  fromEscaped('\\u0441\\u0438\\u0441\\u0442\\u0435\\u043c\\u0430 \\u044d\\u043b.\\u043f\\u043e\\u0434\\u043e\\u0433\\u0440\\u0435\\u0432\\u0430'),
  fromEscaped('\\u0444\\u0438\\u043b\\u044c\\u0442\\u0440'),
  fromEscaped('\\u0440\\u0435\\u043c\\u0435\\u043d\\u044c'),
  fromEscaped('\\u0431\\u043b\\u043e\\u043a\\u0438 \\u0430\\u0432\\u0440'),
  fromEscaped('\\u0431\\u043b\\u043e\\u043a \\u0430\\u0432\\u0440')
];
const accessoryNeedTerms = [
  'кожух',
  'расходник',
  'масло',
  'фильтр',
  'ремень',
  'авр',
  'подогрев',
  fromEscaped('\\u043a\\u043e\\u0436\\u0443\\u0445'),
  fromEscaped('\\u0440\\u0430\\u0441\\u0445\\u043e\\u0434\\u043d\\u0438\\u043a'),
  fromEscaped('\\u0444\\u0438\\u043b\\u044c\\u0442\\u0440'),
  fromEscaped('\\u0440\\u0435\\u043c\\u0435\\u043d\\u044c'),
  fromEscaped('\\u0430\\u0432\\u0440'),
  fromEscaped('\\u043f\\u043e\\u0434\\u043e\\u0433\\u0440\\u0435\\u0432')
];
const trowelTerms = ['затироч', fromEscaped('\\u0437\\u0430\\u0442\\u0438\\u0440\\u043e\\u0447')];
const weldingTerms = ['свароч', fromEscaped('\\u0441\\u0432\\u0430\\u0440\\u043e\\u0447'), 'welding'];
const oilTerms = ['масло', 'oil', 'sae', '10w', '5w', fromEscaped('\\u043c\\u0430\\u0441\\u043b')];
const diamondCoreTerms = ['коронк', 'almaznye_koronki', 'core drill', 'подрозет', 'бурен', 'сверлен', fromEscaped('\\u043a\\u043e\\u0440\\u043e\\u043d\\u043a')];
const rollerTerms = ['виброкат', 'каток', 'roller', fromEscaped('\\u0432\\u0438\\u0431\\u0440\\u043e\\u043a\\u0430\\u0442'), fromEscaped('\\u043a\\u0430\\u0442\\u043e\\u043a')];
const singlePhaseTerms = ['220', '230', 'однофаз', 'одной фаз', fromEscaped('\\u043e\\u0434\\u043d\\u043e\\u0444\\u0430\\u0437'), fromEscaped('\\u043e\\u0434\\u043d\\u043e\\u0439 \\u0444\\u0430\\u0437')];

const fourStrokeOilTerms = [
  '4t',
  '4-t',
  '4 takt',
  'sae',
  '10w',
  '15w',
  fromEscaped('\\u0447\\u0435\\u0442\\u044b\\u0440\\u0435\\u0445\\u0442\\u0430\\u043a\\u0442'),
  fromEscaped('\\u043c\\u043e\\u0442\\u043e\\u0440\\u043d')
];
const incompatibleOilTerms = [
  '2t',
  '2-t',
  fromEscaped('\\u0434\\u0432\\u0443\\u0445\\u0442\\u0430\\u043a\\u0442'),
  fromEscaped('\\u0432\\u043e\\u0437\\u0434\\u0443\\u0448\\u043d\\u044b\\u0439 \\u0444\\u0438\\u043b\\u044c\\u0442\\u0440'),
  fromEscaped('\\u043c\\u0430\\u0441\\u043b\\u043e \\u0434\\u043b\\u044f \\u0444\\u0438\\u043b\\u044c\\u0442\\u0440')
];
const plateAccessoryTerms = [
  fromEscaped('\\u043a\\u043e\\u0432\\u0440\\u0438\\u043a'),
  fromEscaped('\\u043a\\u043e\\u0432\\u0435\\u0440'),
  fromEscaped('\\u043d\\u0430\\u043a\\u043b\\u0430\\u0434\\u043a'),
  fromEscaped('\\u043f\\u043e\\u043b\\u0438\\u0443\\u0440\\u0435\\u0442\\u0430\\u043d'),
  fromEscaped('\\u0432\\u0443\\u043b\\u043a\\u0430\\u043b\\u0430\\u043d')
];

function containsAny(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function oilViscosities(text: string) {
  return [...text.toLowerCase().matchAll(/\b\d{1,2}w-?\d{2}\b/g)]
    .map((match) => match[0].replace('-', ''));
}

function hasOilProductSignal(text: string) {
  return containsAny(text, ['РјР°СЃР»Рѕ', 'oil', 'sae', fromEscaped('\\u043c\\u0430\\u0441\\u043b')]) || oilViscosities(text).length > 0;
}

function requestedLiters(text: string) {
  const match = text.toLowerCase().match(/(\d+(?:[,.]\d+)?)\s*(?:л|l|литр)/i);
  if (!match) return undefined;
  const liters = Number(match[1].replace(',', '.'));
  return Number.isFinite(liters) && liters > 0 ? liters : undefined;
}

function productLiters(product: Product) {
  return requestedLiters([product.name, product.category, product.description, JSON.stringify(product.specs ?? {})].join(' '));
}

function stateText(state: CustomerNeedState, userMessage: string) {
  return [
    userMessage,
    state.explicitNeeds.map((x) => x.value).join(' '),
    state.implicitNeeds.map((x) => x.value).join(' '),
    state.constraints.map((x) => x.value).join(' '),
    state.importantCriteria.map((x) => x.value).join(' ')
  ].join(' ');
}

function extractWeightKg(product: Product) {
  const text = [
    product.name,
    product.description,
    JSON.stringify(product.specs ?? {})
  ].join(' ');
  const match = text.match(weightRegex);
  return match ? Number(match[1]) : undefined;
}

function extractPowerKw(product: Product) {
  const text = [
    product.name,
    product.description,
    JSON.stringify(product.specs ?? {})
  ].join(' ');
  const match = text.match(powerRegex);
  return match ? Number(match[1].replace(',', '.')) : undefined;
}

function normalizePowerValue(value: string) {
  const number = Number(value.replace(',', '.'));
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function extractPowerNearKeywords(text: string, keywords: string[]) {
  const lower = text.toLowerCase();
  for (const keyword of keywords) {
    const index = lower.indexOf(keyword.toLowerCase());
    if (index < 0) continue;
    const excerpt = lower.slice(index, index + 160);
    const match = excerpt.match(powerRegex);
    if (match) return normalizePowerValue(match[1]);
  }
  return undefined;
}

function extractGeneratorPower(product: Product) {
  const text = [
    product.name,
    product.description,
    JSON.stringify(product.specs ?? {})
  ].filter(Boolean).join(' ');
  const nominalKw = extractPowerNearKeywords(text, [
    'nominal',
    'rated',
    fromEscaped('\\u043d\\u043e\\u043c\\u0438\\u043d\\u0430\\u043b'),
    fromEscaped('\\u043d\\u043e\\u043c.')
  ]) ?? extractPowerKw(product);
  const maxKw = extractPowerNearKeywords(text, [
    'max',
    'maximum',
    fromEscaped('\\u043c\\u0430\\u043a\\u0441\\u0438\\u043c'),
    fromEscaped('\\u043f\\u0438\\u043a\\u043e\\u0432')
  ]);
  return {
    nominalKw,
    maxKw: maxKw ?? (nominalKw ? Math.round(nominalKw * 1.1 * 10) / 10 : undefined)
  };
}

function numberNearNeed(text: string, need: RegExp) {
  const match = text.match(need);
  if (!match || match.index === undefined) return undefined;
  const excerpt = text.slice(Math.max(0, match.index - 40), match.index + 90);
  const watt = excerpt.match(/(\d+(?:[,.]\d+)?)\s*(?:\u0432\u0442|w)\b/i);
  if (watt) {
    const value = normalizePowerValue(watt[1]);
    return value ? value / 1000 : undefined;
  }
  const kw = excerpt.match(powerRegex);
  if (kw) return normalizePowerValue(kw[1]);
  return undefined;
}

function estimatedGeneratorPowerFromLoads(text: string): GeneratorPowerProfile | undefined {
  const lower = text.toLowerCase();
  const loads: Array<{ running: number; starting: number }> = [];
  if (/(?:\u043d\u0430\u0441\u043e\u0441|pump)/i.test(lower)) {
    const running = numberNearNeed(lower, /(?:\u043d\u0430\u0441\u043e\u0441|pump)/i) ?? 0.8;
    loads.push({ running, starting: Math.max(running * 2.8, running + 1.2) });
  }
  if (/(?:\u0445\u043e\u043b\u043e\u0434\u0438\u043b|fridge|refrigerator)/i.test(lower)) {
    const running = numberNearNeed(lower, /(?:\u0445\u043e\u043b\u043e\u0434\u0438\u043b|fridge|refrigerator)/i) ?? 0.25;
    loads.push({ running, starting: Math.max(running * 4, 1.1) });
  }
  if (/(?:\u0441\u0432\u0435\u0442|\u043b\u0430\u043c\u043f|light)/i.test(lower)) {
    const running = numberNearNeed(lower, /(?:\u0441\u0432\u0435\u0442|\u043b\u0430\u043c\u043f|light)/i) ?? 0.25;
    loads.push({ running, starting: running });
  }
  if (!loads.length) return undefined;

  const runningSum = loads.reduce((sum, load) => sum + load.running, 0);
  const stagedStart = /(?:\u043d\u0435\s+\u043e\u0434\u043d\u043e\u0432\u0440\u0435\u043c|\u043f\u043e\s+\u043e\u0447\u0435\u0440\u0435\u0434|\u0440\u0430\u0437\u0434\u0435\u043b|not\s+simultaneously|one\s+by\s+one)/i.test(lower);
  const peak = stagedStart
    ? Math.max(...loads.map((load) => load.starting)) + Math.max(0.2, runningSum * 0.25)
    : Math.max(...loads.map((load, index) => load.starting + loads.reduce((sum, other, otherIndex) => sum + (otherIndex === index ? 0 : other.running), 0)));
  const nominalTarget = Math.max(1.8, runningSum * 1.45);
  const maxTarget = Math.max(2.5, peak * 1.15);

  return {
    nominalMin: Math.max(1.6, Math.round((nominalTarget - 0.4) * 10) / 10),
    nominalMax: Math.round(Math.min(5.2, nominalTarget + 1.2) * 10) / 10,
    maxMin: Math.round(Math.max(2.4, maxTarget - 0.4) * 10) / 10,
    maxMax: Math.round(Math.min(6.0, maxTarget + 0.9) * 10) / 10,
    source: 'estimated_load'
  };
}

function compactModelText(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function normalizeBrandKey(value?: string | null) {
  return compactModelText(String(value ?? ''))
    .replace(/^ооо/, '')
    .replace(/^тм/, '');
}

function requestedBrandKeysFromProducts(products: Product[], text: string) {
  const compactText = compactModelText(text);
  const brands = new Set<string>();
  for (const product of products) {
    const key = normalizeBrandKey(product.brand);
    if (key.length >= 3 && compactText.includes(key)) brands.add(key);
  }
  return brands;
}

function productMatchesRequestedBrand(product: Product, requestedBrands: Set<string>) {
  if (!requestedBrands.size) return true;
  const productText = compactModelText([product.brand, product.name].filter(Boolean).join(' '));
  return [...requestedBrands].some((brand) => productText.includes(brand));
}

function extractModelTokens(value: string) {
  const dashed = value.match(/[\p{L}\p{N}]+(?:[-/][\p{L}\p{N}]+)+/gu) ?? [];
  const compact = value.match(/\b(?=[\p{L}\p{N}]*\d)(?=[\p{L}\p{N}]*\p{L})[\p{L}\p{N}]{6,}\b/gu) ?? [];
  const shortModel = value.match(/\b(?=[\p{L}\p{N}\s\/-]{4,12}\b)(?=[\p{L}\p{N}\s\/-]*\d{2,})(?=[\p{L}\p{N}\s\/-]*\p{L})\p{L}{1,4}\s*[-/]?\s*\d{2,4}[\p{L}\p{N}]{0,3}\b/gu) ?? [];
  const spaced = value.match(/\b[\p{L}]{2,}\s+\d{3,}[\p{L}\p{N}]*\b/gu) ?? [];
  return [...new Set([...dashed, ...compact, ...shortModel, ...spaced].filter((token) => /\d/.test(token) && /\p{L}/u.test(token) && compactModelText(token).length >= 4))];
}

function parseDesiredPowerRange(text: string) {
  const match = text.match(powerRangeRegex);
  if (!match) return undefined;
  const a = Number(match[1].replace(',', '.'));
  const b = Number(match[2].replace(',', '.'));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

function parseBudgetMax(text: string) {
  const match = text.match(budgetMaxRegex);
  if (!match) return undefined;
  const value = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const matchedText = match[0].toLowerCase();
  if (value < 1000 || /тыс|т\.?\s*р/.test(matchedText)) return Math.round(value * 1000);
  return Math.round(value);
}

// Text classifiers below are retrieval/fallback helpers. They must not override
// an explicit AssistantTurnPlan field returned by the AI turn planner.
function inferProductIntent(text: string): ProductIntent {
  if (!text.trim()) return 'unknown';
  const lower = text.toLowerCase();
  const hasGeneratorContext = containsAny(lower, generatorTerms);
  const hasPlateContext = containsAny(lower, plateTerms);
  const hasEquipmentContext = hasGeneratorContext || hasPlateContext || containsAny(lower, rammerTerms) || containsAny(lower, cutterTerms);
  const generatorInEnclosureRequest = hasGeneratorContext && fallbackDetectGeneratorEnclosureSignal(lower);
  if (containsAny(lower, oilTerms) && hasEquipmentContext) return hasGeneratorContext && !hasPlateContext ? 'generatorOil' : 'engineOil';
  if (containsAny(lower, plateAccessoryTerms) && hasPlateContext) return 'plateAccessory';
  if (containsAny(lower, oilTerms) && hasGeneratorContext) return 'generatorOil';
  if (containsAny(lower, accessoryNeedTerms) && hasGeneratorContext && !generatorInEnclosureRequest) return 'generatorAccessory';
  if (containsAny(lower, weldingTerms) && hasGeneratorContext) return 'weldingGenerator';
  if (containsAny(lower, trowelTerms)) return 'trowel';
  if (containsAny(lower, rollerTerms)) return 'roller';
  if (containsAny(lower, diamondCoreTerms) && /(?:алмаз|diamond|бетон|монолит|железобетон|подрозет|бурен|сверлен|core)/i.test(lower)) return 'diamondCore';
  const hasDiamond = containsAny(lower, diamondBladeTerms);
  const hasBladeContext = /(?:\bdisc\b|\bblade\b|диск|круг)/i.test(lower);
  const hasTileContext = /(?:керамогранит|керамик|плиткорез|плитк|мокр(?:ая|ой|ую)|сух(?:ая|ой|ую)\s+резк)/i.test(lower);
  if (containsAny(lower, cutterTerms) && !/(?:алмаз|diamond|керамогранит|керамик|плиткорез|blade)/i.test(lower)) return 'cutter';
  if (hasDiamond && (hasBladeContext || hasTileContext)) return 'diamondBlade';
  if (containsAny(lower, plateTerms)) return 'plate';
  if (containsAny(lower, rammerTerms)) return 'rammer';
  if (containsAny(lower, cutterTerms)) return 'cutter';
  if (containsAny(lower, generatorTerms)) return 'generator';
  return 'unknown';
}

function fallbackDetectGeneratorEnclosureSignal(text: string) {
  return /(?:генератор|электростанц)[^.!?\n]{0,80}(?:в|со|с)\s+(?:закрыт\w*\s+)?(?:кожух|корпус|шумозащит|шумоизоляц|тих\w*)/iu.test(text) ||
    /(?:закрыт\w*|тих\w*|шумозащит\w*|шумоизоляц\w*|в\s+кожухе|в\s+корпусе)[^.!?\n]{0,80}(?:генератор|электростанц)/iu.test(text);
}

function fallbackDetectStandaloneGeneratorAccessoryRequest(text: string) {
  return /(?:кожух|блок\s+авр|авр|подогрев|фильтр|ремень|масло|расходник)[^.!?\n]{0,50}(?:для|на|к)\s+(?:генератор|электростанц)/iu.test(text);
}

function hasElectricStartSignal(text: string) {
  return /(?:электр(?:о)?\s*стартер|электростарт|эл\.?\s*старт|ключ|ручн(?:ой|ая|ой\/)?\s*\/\s*электр|\p{L}{0,8}\s*\d{3,}\s*[eе]\b)/iu.test(text);
}

function generatorPowerFromTraits(traits?: RequiredProductTraits): GeneratorPowerProfile | undefined {
  if (!traits) return undefined;
  const range: GeneratorPowerProfile = { source: 'planner' };
  if (traits.nominalPowerKwMin) range.nominalMin = traits.nominalPowerKwMin;
  if (traits.nominalPowerKwMax) range.nominalMax = traits.nominalPowerKwMax;
  if (traits.maxPowerKwMin) range.maxMin = traits.maxPowerKwMin;
  if (traits.maxPowerKwMax) range.maxMax = traits.maxPowerKwMax;
  return range.nominalMin || range.nominalMax || range.maxMin || range.maxMax ? range : undefined;
}

function normalizePowerRange(range?: GeneratorPowerProfile) {
  if (!range) return undefined;
  const normalized = { ...range };
  if (normalized.nominalMin && normalized.nominalMax && normalized.nominalMin > normalized.nominalMax) {
    [normalized.nominalMin, normalized.nominalMax] = [normalized.nominalMax, normalized.nominalMin];
  }
  if (normalized.maxMin && normalized.maxMax && normalized.maxMin > normalized.maxMax) {
    [normalized.maxMin, normalized.maxMax] = [normalized.maxMax, normalized.maxMin];
  }
  return normalized;
}

function buildProductFitProfile(state: CustomerNeedState, userMessage: string, retrievalQuery = '', traits?: RequiredProductTraits): ProductFitProfile {
  const latestText = userMessage.trim();
  const queryText = retrievalQuery.trim();
  const stateMemoryText = stateText(state, '');
  const activeNeedText = [latestText, queryText].filter(Boolean).join(' ') || stateMemoryText;
  const latestIntent = inferProductIntent(latestText);
  const queryIntent = inferProductIntent(queryText);
  const memoryIntent = inferProductIntent([state.lastSummary, stateMemoryText].filter(Boolean).join(' '));
  const traitIntent = traits?.productIntent ?? 'unknown';
  const activeNeedLower = activeNeedText.toLowerCase();
  const plannerKnowsProductRole = Boolean(traits && traits.productRole !== 'unknown');
  const plannerKnowsEnclosure = Boolean(traits && traits.enclosure !== 'unknown');
  const generatorInEnclosureRequest = !plannerKnowsEnclosure
    ? fallbackDetectGeneratorEnclosureSignal(activeNeedLower)
    : false;
  const coreProductTrait = traits?.productRole === 'coreProduct' ||
    (traits?.productIntent === 'generator' && traits?.enclosure === 'enclosed');
  const accessoryTrait = traits?.productRole === 'accessory' || traits?.productRole === 'consumable';
  const textIntentShouldOverrideGeneratorTrait = traitIntent === 'generator' &&
    latestIntent !== 'unknown' &&
    latestIntent !== 'generator' &&
    !(coreProductTrait && latestIntent === 'generatorAccessory') &&
    !(generatorInEnclosureRequest && latestIntent === 'generatorAccessory');
  const intent = textIntentShouldOverrideGeneratorTrait
    ? latestIntent
    : traitIntent !== 'unknown'
    ? traitIntent
    : latestIntent !== 'unknown'
      ? latestIntent
      : queryIntent !== 'unknown'
        ? queryIntent
        : memoryIntent;
  const exactModelTokens = extractModelTokens([userMessage, retrievalQuery].filter(Boolean).join(' '));
  const desiredPowerRange = parseDesiredPowerRange(activeNeedText);
  const generatorPower = normalizePowerRange(
    generatorPowerFromTraits(traits) ??
    (desiredPowerRange ? { nominalMin: desiredPowerRange.min, nominalMax: desiredPowerRange.max, source: 'explicit_text' } : undefined) ??
    estimatedGeneratorPowerFromLoads(activeNeedText)
  );

  return {
    intent,
    activeNeedText,
    requestedBrands: [],
    accessoryRequested: accessoryTrait ||
      (!coreProductTrait && !plannerKnowsProductRole && (
        (containsAny(activeNeedText, accessoryNeedTerms) && !generatorInEnclosureRequest && traits?.enclosure !== 'enclosed') ||
        fallbackDetectStandaloneGeneratorAccessoryRequest(activeNeedLower)
      )),
    weldingRequested: containsAny(activeNeedText, weldingTerms),
    wantsGasoline: traits?.fuel === 'gasoline' || ((!traits || traits.fuel === 'unknown') && containsAny(activeNeedText, gasolineTerms)),
    wantsDiesel: traits?.fuel === 'diesel' || ((!traits || traits.fuel === 'unknown') && containsAny(activeNeedText, dieselTerms)),
    wantsElectricStart: traits?.startType === 'electric' || ((!traits || traits.startType === 'unknown') && (hasElectricStartSignal(activeNeedText) || /(?:\bkey\b|кнопк|ключ)/i.test(activeNeedText))),
    wantsInverterGenerator: traits?.conventionalGenerator === false || ((!traits || traits.conventionalGenerator === null) && containsAny(activeNeedText, inverterTerms)),
    wantsEnclosedGenerator: traits?.enclosure === 'enclosed' || (!traits || traits.enclosure === 'unknown' ? generatorInEnclosureRequest : false),
    wantsConventionalGenerator: traits?.conventionalGenerator === true || ((!traits || traits.conventionalGenerator === null) && /(?:обычн|не\s+инвертор|без\s+инвертор)/i.test(activeNeedText)),
    wantsSinglePhase220: traits?.singlePhase220 === true || ((!traits || traits.singlePhase220 === null) && containsAny(activeNeedText, singlePhaseTerms)),
    desiredPowerRange,
    generatorPower,
    budgetMax: parseBudgetMax(activeNeedText),
    exactModelTokens
  };
}
function productFullText(product: Product) {
  return [product.name, product.brand, product.category, product.sourceUrl, product.description, JSON.stringify(product.specs ?? {})]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function productHasExactModel(product: Product, profile: ProductFitProfile) {
  const compact = compactModelText(productFullText(product));
  return profile.exactModelTokens.some((token) => compact.includes(compactModelText(token)));
}

function classifyProduct(product: Product) {
  const text = productFullText(product);
  const reliableStartText = [product.name, product.category, JSON.stringify(product.specs ?? {})]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const descriptionText = String(product.description ?? '').toLowerCase();
  const specsText = JSON.stringify(product.specs ?? {}).toLowerCase();
  const classText = [product.name, product.category]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const category = String(product.category ?? '').toLowerCase();
  const isOilProduct = hasOilProductSignal(classText);
  const isIncompatibleOil = isOilProduct && containsAny(text, incompatibleOilTerms);
  const isEngineOil = isOilProduct && !isIncompatibleOil && (containsAny(text, fourStrokeOilTerms) || containsAny(category, oilTerms));
  const isPlateAccessory = containsAny(classText, plateAccessoryTerms) && containsAny(text, plateTerms);
  const isGeneratorOil = (isOilProduct && containsAny(text, generatorTerms)) ||
    /масло\s+для\s+генератор|generator.?oil|10w-?40|5w-?30|sae\s*\d/i.test(text);
  const catalogGeneratorOil = (isOilProduct && containsAny(text, generatorTerms)) ||
    /generator.?oil|10w-?40|5w-?30|sae\s*\d/i.test(classText);
  const classHasGenerator = containsAny(classText, generatorTerms);
  const standaloneGeneratorAccessory = /(?:кожухи\s+для\s+генератора|^кожух\b|блок(?:и)?\s+авр|подогрев|фильтр|ремень|расходник|масло\s+для\s+генератор)/i.test(classText);
  const isAccessory = isPlateAccessory || catalogGeneratorOil || containsAny(classText, accessoryTerms) ||
    (standaloneGeneratorAccessory && !/(?:^|\s)(?:генератор|электростанц)/i.test(classText));
  const isWeldingGenerator = containsAny(classText, weldingTerms) || category.includes('сварочные генераторы');
  const isDiamondCore = /(?:алмаз.*коронк|коронк.*алмаз|almaznye_koronki|core.?drill|подрозет|бурен|сверлен)/i.test(classText);
  const isRoller = containsAny(classText, rollerTerms) || /виброкат|каток/i.test(category);
  const enclosureSpec = String((product.specs as Record<string, unknown> | null | undefined)?.[fromEscaped('\\u0442\\u0438\\u043f \\u043a\\u043e\\u0436\\u0443\\u0445\\u0430')] ?? '').toLowerCase();
  const hasOpenFrameSignal = classHasGenerator && (enclosureSpec.includes(fromEscaped('\\u043e\\u0442\\u043a\\u0440\\u044b\\u0442')) || /(?:тип\s+кожуха["'\s:,-]*открыт|открыт\w*\s+(?:рама|конструкц|исполн))/iu.test(text));
  const hasClosedEnclosureSpec = classHasGenerator && enclosureSpec.includes(fromEscaped('\\u0437\\u0430\\u043a\\u0440\\u044b\\u0442'));
  const enclosureLeadText = [product.name, product.category, descriptionText.slice(0, 600)].filter(Boolean).join(' ');
  const strongGeneratorEnclosurePattern = /(?:шумопогл\w*[^.!?\n]{0,40}кожух|кожух[^.!?\n]{0,40}шумопогл|шумозащит\w*[^.!?\n]{0,40}кожух|кожух[^.!?\n]{0,40}шумозащит|шумоизоляц\w*[^.!?\n]{0,40}кожух|закрыт\w*\s+корпус|в\s+кожухе|кожухом)/iu;
  const weakGeneratorEnclosurePattern = /(?:корпус[^.!?\n]{0,80}шум|шум[^.!?\n]{0,80}корпус|низк\w*\s+уров\w*\s+шума|понизить\s+уровень\s+шума)/iu;
  const leadGeneratorEnclosureSignal = classHasGenerator && strongGeneratorEnclosurePattern.test(enclosureLeadText);
  const strongGeneratorEnclosureSignal = classHasGenerator && strongGeneratorEnclosurePattern.test(text);
  const weakGeneratorEnclosureSignal = classHasGenerator && weakGeneratorEnclosurePattern.test(text);
  const generatorEnclosureConfidence = (hasClosedEnclosureSpec ? 3 : leadGeneratorEnclosureSignal ? 3 : strongGeneratorEnclosureSignal ? 2 : weakGeneratorEnclosureSignal ? 1 : 0) -
    (hasOpenFrameSignal && specsText.includes('тип кожуха') ? 2 : 0);
  const hasGeneratorEnclosureSignal = generatorEnclosureConfidence > 0;

  const isDiamondBlade = /(?:алмаз|керамогранит|керамик|diamond|blade|almaz|almaznye_diski|алмазные[_\s-]?диски)/i.test(classText) &&
    /(?:диск|круг|diamond|blade|almaz)/i.test(classText) &&
    !isDiamondCore;

  return {
    text,
    category,
    isGenerator: containsAny(text, generatorTerms) && !isAccessory && !isWeldingGenerator,
    isGeneratorAccessory: isAccessory && !isGeneratorOil && !isPlateAccessory,
    isGeneratorOil: catalogGeneratorOil && !isIncompatibleOil,
    isEngineOil,
    isPlateAccessory,
    isWeldingGenerator,
    isPlate: containsAny(classText, plateTerms),
    isRammer: containsAny(classText, rammerTerms),
    isRoller,
    isCutter: containsAny(classText, cutterTerms),
    isDiamondBlade,
    isDiamondCore,
    isTrowel: containsAny(classText, trowelTerms),
    isGasoline: containsAny(classText, gasolineTerms),
    isDiesel: containsAny(classText, dieselTerms),
    isInverter: containsAny(classText, inverterTerms),
    hasGeneratorEnclosureSignal,
    generatorEnclosureConfidence,
    hasOpenFrameSignal,
    hasElectricStart: hasElectricStartSignal(reliableStartText),
    isSinglePhase220: containsAny(text, singlePhaseTerms)
  };
}

function generatorPowerPenalty(product: Product, profile: ProductFitProfile) {
  if (!profile.generatorPower) return 0;
  const power = extractGeneratorPower(product);
  const nominal = power.nominalKw;
  const max = power.maxKw;
  const range = profile.generatorPower;
  if (range.nominalMin && nominal !== undefined && nominal < range.nominalMin - 0.4) return -150;
  if (range.nominalMax && nominal !== undefined && nominal > range.nominalMax + (range.source === 'estimated_load' ? 0.7 : 0.8)) return -150;
  if (range.maxMin && max !== undefined && max < range.maxMin - 0.5) return -150;
  if (range.maxMax && max !== undefined && max > range.maxMax + (range.source === 'estimated_load' ? 0.8 : 1.0)) return -90;
  return 0;
}

function productFitPenalty(product: Product, profile: ProductFitProfile) {
  const flags = classifyProduct(product);
  const powerKw = extractPowerKw(product);
  const exactModel = productHasExactModel(product, profile);
  const requestedOilViscosities = oilViscosities(profile.activeNeedText);
  const productOilViscosities = oilViscosities(flags.text);

  if (profile.budgetMax && product.price && product.price > profile.budgetMax * 1.02) return -130;

  if (profile.intent === 'weldingGenerator') {
    if (!flags.isWeldingGenerator) return -190;
    if (profile.wantsGasoline && flags.isDiesel) return -120;
    if (profile.wantsDiesel && flags.isGasoline) return -120;
  }

  if (profile.intent === 'generatorOil') {
    if (!flags.isGeneratorOil) return -190;
    if (requestedOilViscosities.length && !productOilViscosities.some((item) => requestedOilViscosities.includes(item))) return -150;
  }

  if (profile.intent === 'engineOil') {
    if (!flags.isEngineOil) return -190;
    if (requestedOilViscosities.length && !productOilViscosities.some((item) => requestedOilViscosities.includes(item))) return -150;
    if (!requestedOilViscosities.length && productOilViscosities.some((item) => item.startsWith('15w'))) return -120;
  }

  if (profile.intent === 'generatorAccessory') {
    if (!flags.isGeneratorAccessory && !flags.isGeneratorOil) return -180;
  }

  if (profile.intent === 'plateAccessory') {
    if (!flags.isPlateAccessory) return -190;
  }

  if (profile.intent === 'generator') {
    if (flags.isGeneratorAccessory && !profile.accessoryRequested) return -220;
    if (flags.isGeneratorOil && !profile.accessoryRequested) return -220;
    if (flags.isEngineOil || flags.isPlateAccessory) return -220;
    if (flags.isWeldingGenerator && !profile.weldingRequested) return -180;
    if (flags.isPlate || flags.isRammer || flags.isRoller || flags.isCutter || flags.isDiamondBlade || flags.isDiamondCore || flags.isTrowel) return -220;
    if (!flags.isGenerator) return -160;
    if (profile.wantsGasoline && flags.isDiesel) return -180;
    if (profile.wantsDiesel && flags.isGasoline) return -140;
    if (profile.wantsGasoline && !flags.isGasoline) return -90;
    if (profile.wantsDiesel && !flags.isDiesel) return -90;
    if (profile.wantsInverterGenerator && !flags.isInverter) return -170;
    if (profile.wantsConventionalGenerator && flags.isInverter) return -160;
    if (profile.wantsEnclosedGenerator && !flags.hasGeneratorEnclosureSignal) return -150;
    if (profile.desiredPowerRange && powerKw !== undefined) {
      const { min, max } = profile.desiredPowerRange;
      if (powerKw < min - 0.4 || powerKw > max + 0.8) return -170;
    }
    const powerPenalty = generatorPowerPenalty(product, profile);
    if (powerPenalty <= -140) return powerPenalty;
    if (profile.wantsElectricStart && !flags.hasElectricStart) return -220;
  }

  if (profile.intent === 'plate') {
    if (flags.isGeneratorAccessory || flags.isGeneratorOil || flags.isEngineOil || flags.isPlateAccessory || flags.isDiamondBlade || flags.isDiamondCore || flags.isCutter || flags.isRammer || flags.isRoller) return -180;
    if (!flags.isPlate) return -160;
  }
  if (profile.intent === 'rammer') {
    if (flags.isGeneratorAccessory || flags.isGeneratorOil || flags.isEngineOil || flags.isPlateAccessory || flags.isDiamondBlade || flags.isDiamondCore || flags.isCutter || flags.isPlate || flags.isRoller) return -180;
    if (!flags.isRammer) return -160;
  }
  if (profile.intent === 'roller') {
    if (flags.isGeneratorAccessory || flags.isGeneratorOil || flags.isEngineOil || flags.isPlateAccessory || flags.isDiamondBlade || flags.isDiamondCore || flags.isCutter || flags.isPlate || flags.isRammer) return -180;
    if (!flags.isRoller) return -160;
  }
  if (profile.intent === 'cutter') {
    if (flags.isGeneratorAccessory || flags.isGeneratorOil || flags.isEngineOil || flags.isPlateAccessory || flags.isDiamondBlade || flags.isDiamondCore || flags.isPlate || flags.isRammer || flags.isRoller) return -180;
    if (!flags.isCutter) return -160;
  }
  if (profile.intent === 'diamondBlade' && !flags.isDiamondBlade) return -180;
  if (profile.intent === 'diamondCore' && !flags.isDiamondCore) return -180;
  if (profile.intent === 'trowel' && !flags.isTrowel) return -180;

  if (exactModel) return 0;

  return 0;
}

function exactModelCanBypassFit(profile: ProductFitProfile) {
  return !['engineOil', 'generatorOil', 'generatorAccessory', 'plateAccessory'].includes(profile.intent);
}

function violatesHardRequiredTraits(product: Product, profile: ProductFitProfile) {
  const flags = classifyProduct(product);
  if (profile.intent !== 'generator') return false;
  if (flags.isGeneratorAccessory || flags.isGeneratorOil || flags.isEngineOil || flags.isPlateAccessory) return true;
  if (flags.isWeldingGenerator && !profile.weldingRequested) return true;
  if (flags.isPlate || flags.isRammer || flags.isRoller || flags.isCutter || flags.isDiamondBlade || flags.isDiamondCore || flags.isTrowel) return true;
  if (!flags.isGenerator) return true;
  if (profile.wantsGasoline && flags.isDiesel) return true;
  if (profile.wantsDiesel && flags.isGasoline) return true;
  if (profile.wantsInverterGenerator && !flags.isInverter) return true;
  if (profile.wantsConventionalGenerator && flags.isInverter) return true;
  if (profile.wantsEnclosedGenerator && !flags.hasGeneratorEnclosureSignal) return true;
  if (profile.wantsElectricStart && !flags.hasElectricStart) return true;
  const powerKw = extractPowerKw(product);
  if (profile.desiredPowerRange && powerKw !== undefined) {
    const { min, max } = profile.desiredPowerRange;
    if (powerKw < min - 0.4 || powerKw > max + 0.8) return true;
  }
  return generatorPowerPenalty(product, profile) <= -140;
}

function isCardWorthy(product: Product, profile: ProductFitProfile, score: number) {
  if (productHasExactModel(product, profile)) {
    if (violatesHardRequiredTraits(product, profile)) return false;
    return exactModelCanBypassFit(profile)
      ? productFitPenalty(product, profile) > -160
      : productFitPenalty(product, profile) >= 0;
  }
  if (profile.intent === 'unknown') return score >= 80;
  return productFitPenalty(product, profile) >= 0 && score >= 55;
}

function generatorPowerScore(product: Product, profile: ProductFitProfile) {
  if (!profile.generatorPower) return 0;
  const power = extractGeneratorPower(product);
  const nominal = power.nominalKw;
  const max = power.maxKw;
  const range = profile.generatorPower;
  let score = 0;

  if (range.nominalMin || range.nominalMax) {
    const min = range.nominalMin ?? 0;
    const maxRange = range.nominalMax ?? Number.POSITIVE_INFINITY;
    if (nominal === undefined) score -= 8;
    else if (nominal >= min && nominal <= maxRange) score += 48;
    else {
      const center = Number.isFinite(maxRange) ? (min + maxRange) / 2 : min;
      score -= Math.min(70, Math.abs(nominal - center) * 16);
    }
  }

  if (range.maxMin || range.maxMax) {
    const min = range.maxMin ?? 0;
    const maxRange = range.maxMax ?? Number.POSITIVE_INFINITY;
    if (max === undefined) score -= 8;
    else if (max >= min && max <= maxRange) score += range.source === 'estimated_load' ? 58 : 42;
    else {
      const center = Number.isFinite(maxRange) ? (min + maxRange) / 2 : min;
      score -= Math.min(60, Math.abs(max - center) * 12);
    }
  }

  if (range.source === 'estimated_load' && nominal !== undefined) {
    if (range.nominalMax && nominal > range.nominalMax + 0.5) score -= Math.min(80, (nominal - range.nominalMax) * 22);
    if (nominal >= 2.5 && nominal <= 4.8) score += 18;
  }

  return score;
}

function supplementalCatalogQueries(profile: ProductFitProfile) {
  if (profile.intent === 'weldingGenerator') return [fromEscaped('\\u0421\\u0432\\u0430\\u0440\\u043e\\u0447\\u043d\\u044b\\u0435 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u044b')];
  if (profile.intent === 'generatorOil') return [
    fromEscaped('\\u041c\\u0430\\u0441\\u043b\\u043e \\u0434\\u043b\\u044f \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u0430'),
    fromEscaped('\\u041c\\u0430\\u0441\\u043b\\u043e \\u0434\\u043b\\u044f \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u043e\\u0432')
  ];
  if (profile.intent === 'engineOil') return [
    fromEscaped('\\u041c\\u0430\\u0441\\u043b\\u043e \\u0434\\u043b\\u044f \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u0430'),
    fromEscaped('\\u041c\\u043e\\u0442\\u043e\\u0440\\u043d\\u043e\\u0435 \\u043c\\u0430\\u0441\\u043b\\u043e SAE 10W-40'),
    fromEscaped('\\u041c\\u0430\\u0441\\u043b\\u043e 4T SAE')
  ];
  if (profile.intent === 'generatorAccessory') return [
    fromEscaped('\\u0420\\u0430\\u0441\\u0445\\u043e\\u0434\\u043d\\u0438\\u043a\\u0438 \\u0434\\u043b\\u044f \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u043e\\u0432'),
    fromEscaped('\\u041a\\u043e\\u0436\\u0443\\u0445\\u0438 \\u0434\\u043b\\u044f \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u0430')
  ];
  if (profile.intent === 'plateAccessory') return [
    fromEscaped('\\u041a\\u043e\\u0432\\u0440\\u0438\\u043a \\u0434\\u043b\\u044f \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u044b'),
    fromEscaped('\\u041d\\u0430\\u043a\\u043b\\u0430\\u0434\\u043a\\u0430 \\u0434\\u043b\\u044f \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u044b')
  ];
  if (profile.intent === 'generator') {
    const gasoline = fromEscaped('\\u0411\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0435 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u044b');
    const inverter = fromEscaped('\\u0418\\u043d\\u0432\\u0435\\u0440\\u0442\\u043e\\u0440\\u043d\\u044b\\u0435 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u044b');
    const diesel = fromEscaped('\\u0414\\u0438\\u0437\\u0435\\u043b\\u044c\\u043d\\u044b\\u0435 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u044b');
    if (profile.wantsGasoline) return [gasoline, inverter];
    if (profile.wantsDiesel) return [diesel];
    return [gasoline, diesel, inverter];
  }
  if (profile.intent === 'plate') return [fromEscaped('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u044b')];
  if (profile.intent === 'rammer') return [fromEscaped('\\u0412\\u0438\\u0431\\u0440\\u043e\\u0442\\u0440\\u0430\\u043c\\u0431\\u043e\\u0432\\u043a\\u0438')];
  if (profile.intent === 'roller') return [fromEscaped('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043a\\u0430\\u0442\\u043a\\u0438')];
  if (profile.intent === 'trowel') return [fromEscaped('\\u0417\\u0430\\u0442\\u0438\\u0440\\u043e\\u0447\\u043d\\u044b\\u0435 \\u043c\\u0430\\u0448\\u0438\\u043d\\u044b')];
  if (profile.intent === 'cutter') return [fromEscaped('\\u0428\\u0432\\u043e\\u043d\\u0430\\u0440\\u0435\\u0437\\u0447\\u0438\\u043a\\u0438 \\u0420\\u0435\\u0437\\u0447\\u0438\\u043a\\u0438')];
  if (profile.intent === 'diamondBlade') return [
    fromEscaped('\\u0410\\u043b\\u043c\\u0430\\u0437\\u043d\\u044b\\u0435 \\u0434\\u0438\\u0441\\u043a\\u0438'),
    fromEscaped('\\u0410\\u043b\\u043c\\u0430\\u0437\\u043d\\u0430\\u044f \\u043e\\u0441\\u043d\\u0430\\u0441\\u0442\\u043a\\u0430')
  ];
  if (profile.intent === 'diamondCore') return [
    fromEscaped('\\u0410\\u043b\\u043c\\u0430\\u0437\\u043d\\u044b\\u0435 \\u043a\\u043e\\u0440\\u043e\\u043d\\u043a\\u0438'),
    fromEscaped('\\u041a\\u043e\\u0440\\u043e\\u043d\\u043a\\u0438 \\u0430\\u043b\\u043c\\u0430\\u0437\\u043d\\u044b\\u0435')
  ];
  return [];
}

function recommendationScore(product: Product, state: CustomerNeedState, userMessage: string, profile = buildProductFitProfile(state, userMessage)) {
  const needText = profile.activeNeedText || stateText(state, userMessage);
  const productText = [product.name, product.category, product.sourceUrl, product.description].join(' ').toLowerCase();
  const wantsPlate = profile.intent === 'plate';
  const wantsGenerator = profile.intent === 'generator';
  const wantsWeldingGenerator = profile.intent === 'weldingGenerator';
  const wantsGeneratorOil = profile.intent === 'generatorOil';
  const wantsEngineOil = profile.intent === 'engineOil';
  const wantsGeneratorAccessory = profile.intent === 'generatorAccessory';
  const wantsPlateAccessory = profile.intent === 'plateAccessory';
  const wantsCutter = profile.intent === 'cutter';
  const wantsDiamondBlade = profile.intent === 'diamondBlade';
  const wantsDiamondCore = profile.intent === 'diamondCore';
  const wantsTrowel = profile.intent === 'trowel';
  const wantsRoller = profile.intent === 'roller';
  const wantsPortable = state.featureSignals.portable >= 0.45 || state.featureSignals.compact >= 0.6 || containsAny(needText, weightTerms);
  const wantsHomeUse = state.featureSignals.homeUse >= 0.45 || containsAny(needText, homeTerms);
  const wantsLowNoise = state.featureSignals.lowNoise >= 0.45;
  const wantsColdStart = state.featureSignals.coldStart >= 0.45;
  const wantsProfessionalDuty = state.featureSignals.professionalDuty >= 0.45;
  const wantsBudget = state.featureSignals.budgetSensitive >= 0.45;
  const weight = extractWeightKg(product);
  const powerKw = extractPowerKw(product);
  const productCompact = compactModelText(productText);
  const modelTokens = profile.exactModelTokens.length ? profile.exactModelTokens : extractModelTokens(needText);
  const flags = classifyProduct(product);
  let score = productFitPenalty(product, profile);

  if (wantsPlate && containsAny(productText, plateTerms)) score += 60;
  if (wantsGenerator && containsAny(productText, generatorTerms)) score += 60;
  if (wantsWeldingGenerator && containsAny(productText, weldingTerms)) score += 80;
  if (wantsGeneratorOil && containsAny(productText, oilTerms)) score += 80;
  if (wantsEngineOil && flags.isEngineOil) score += 95;
  if (wantsGeneratorAccessory && containsAny(productText, accessoryTerms)) score += 65;
  if (wantsPlateAccessory && flags.isPlateAccessory) score += 90;
  if (wantsCutter && containsAny(productText, cutterTerms)) score += 60;
  if (wantsDiamondBlade && containsAny(productText, diamondBladeTerms)) score += 60;
  if (wantsDiamondCore && containsAny(productText, diamondCoreTerms)) score += 80;
  if (wantsTrowel && containsAny(productText, trowelTerms)) score += 70;
  if (wantsRoller && containsAny(productText, rollerTerms)) score += 70;
  for (const token of modelTokens) {
    const compact = compactModelText(token);
    if (compact && productCompact.includes(compact) && exactModelCanBypassFit(profile)) score += 240;
  }
  if (product.price) score += Math.max(0, 12 - product.price / 100_000);

  if (wantsGenerator && !containsAny(needText, accessoryNeedTerms) && containsAny(productText, accessoryTerms)) {
    score -= 85;
  }

  if (wantsGenerator && profile.wantsGasoline && containsAny(productText, gasolineTerms)) score += 36;
  if (wantsGenerator && profile.wantsDiesel && containsAny(productText, dieselTerms)) score += 28;
  if (wantsGenerator && profile.wantsInverterGenerator && flags.isInverter) score += 45;
  if (wantsGenerator && profile.wantsEnclosedGenerator && flags.hasGeneratorEnclosureSignal) score += 55;
  if (wantsGenerator && profile.wantsSinglePhase220 && containsAny(productText, singlePhaseTerms)) score += 18;
  if (wantsGenerator && profile.wantsElectricStart && hasElectricStartSignal(productText)) score += 24;
  if (wantsGenerator && profile.desiredPowerRange && powerKw !== undefined) {
    const { min, max } = profile.desiredPowerRange;
    const center = (min + max) / 2;
    if (powerKw >= min - 0.2 && powerKw <= max + 0.2) score += 48;
    else score -= Math.min(80, Math.abs(powerKw - center) * 14);
  }
  if (wantsGenerator) score += generatorPowerScore(product, profile);

  if (wantsPortable && weight !== undefined) {
    if (weight <= 60) score += 55;
    else if (weight <= 80) score += 45;
    else if (weight <= 100) score += 28;
    else if (weight <= 130) score += 12;
    else if (weight <= 160) score -= 15;
    else if (weight <= 250) score -= 35;
    else score -= 80;
  }

  if (wantsHomeUse && weight !== undefined) {
    if (weight <= 100) score += 18;
    if (weight > 180) score -= 25;
  }

  if (wantsHomeUse && productText.includes(fromEscaped('\\u0434\\u0438\\u0437\\u0435\\u043b'))) score -= 8;
  if (productText.includes(fromEscaped('\\u043f\\u0440\\u044f\\u043c\\u043e\\u0445\\u043e\\u0434'))) score += 6;

  if (wantsLowNoise) {
    if (containsAny(productText, inverterTerms)) score += 42;
    if (containsAny(productText, quietTerms)) score += 28;
    if (containsAny(productText, dieselTerms)) score -= 18;
    if (powerKw !== undefined && powerKw > 12) score -= 10;
  }

  if (wantsColdStart) {
    if (containsAny(productText, coldStartTerms)) score += 36;
    if (containsAny(productText, gasolineTerms)) score += 8;
    if (containsAny(productText, dieselTerms) && !containsAny(productText, coldStartTerms)) score -= 10;
  }

  if (wantsProfessionalDuty) {
    if (containsAny(productText, professionalTerms)) score += 30;
    if (containsAny(productText, dieselTerms)) score += 18;
    if (weight !== undefined && weight >= 120 && containsAny(productText, plateTerms)) score += 16;
    if (powerKw !== undefined && powerKw >= 8 && containsAny(productText, generatorTerms)) score += 18;
    if (product.price && product.price < 60_000) score -= 8;
  }

  if (wantsBudget && product.price) {
    if (product.price <= 70_000) score += 70;
    else if (product.price <= 100_000) score += 42;
    else if (product.price <= 140_000) score += 22;
    else if (product.price <= 180_000) score += 10;
    else if (product.price >= 500_000) score -= 20;
    score += Math.max(0, 36 - product.price / 4000);
  }

  if (profile.budgetMax && product.price) {
    const ratio = product.price / profile.budgetMax;
    if (ratio <= 0.75) score += 10;
    else if (ratio <= 1) score += 6;
    else if (ratio > 1.02) score -= 90;
  }

  return score;
}

function productCards(products: Product[], state: CustomerNeedState, userMessage = '', profile = buildProductFitProfile(state, userMessage)): ProductCard[] {
  const criteria: string[] = [];

  return products.slice(0, MAX_PRODUCT_CARDS).map((product) => ({
    id: product.id,
    name: product.name,
    brand: displayProductBrand(product),
    category: product.category,
    price: product.price,
    currency: product.currency,
    imageUrl: product.imageUrl,
    sourceUrl: product.sourceUrl,
    specs: product.specs,
    reasons: productReasons(product, state, criteria, userMessage, profile),
    caveats: product.price ? [] : ['Цена требует проверки перед оформлением']
  }));
}

function displayProductBrand(product: Product) {
  const brand = product.brand?.trim();
  const name = product.name.toLowerCase();
  if ((!brand || brand.toLowerCase() === 'sae') && name.includes(fromEscaped('\\u0442\\u0441\\u0441').toLowerCase())) {
    return fromEscaped('\\u0422\\u0421\\u0421');
  }
  if ((!brand || brand.toLowerCase() === 'sae') && name.includes('teboil')) {
    return 'Teboil';
  }
  return product.brand;
}

function productBrandKey(product: Product) {
  const nameBrand = product.name
    .replace(/^(?:генератор|generator)\s+(?:бензиновый|дизельный|gasoline|diesel)?\s*/i, '')
    .split(/\s+/)[0];
  return String(product.brand || nameBrand || product.id).trim().toLowerCase();
}

function diversifyRankedProducts(items: Array<{ product: Product; score: number }>) {
  const remaining = [...items];
  const result: Product[] = [];
  const usedBrands = new Set<string>();

  while (remaining.length && result.length < MAX_PRODUCT_CARDS) {
    let pickIndex = 0;
    if (result.length < 4) {
      const bestScore = remaining[0].score;
      const diverseIndex = remaining.findIndex((item) =>
        !usedBrands.has(productBrandKey(item.product)) &&
        item.score >= bestScore - 28
      );
      if (diverseIndex >= 0) pickIndex = diverseIndex;
    }
    const [picked] = remaining.splice(pickIndex, 1);
    result.push(picked.product);
    usedBrands.add(productBrandKey(picked.product));
  }

  return result;
}

function productReasons(product: Product, state: CustomerNeedState, criteria: string[], userMessage = '', profile = buildProductFitProfile(state, userMessage)) {
  const text = [product.name, product.category, product.sourceUrl, product.description, JSON.stringify(product.specs ?? {})].join(' ').toLowerCase();
  const reasons: string[] = [];
  const weight = extractWeightKg(product);
  const powerKw = extractPowerKw(product);
  const productCompact = compactModelText(text);
  const exactToken = profile.exactModelTokens.find((token) => productCompact.includes(compactModelText(token)));
  const flags = classifyProduct(product);

  if (exactToken) {
    reasons.push(`Совпадает с указанной моделью: ${exactToken}`);
  }

  if (profile.intent === 'generator' && flags.isGenerator) {
    if (flags.isGasoline) reasons.push('Подходит по классу: бензиновый генератор для резервного питания');
    else reasons.push('Подходит по классу: генератор, а не аксессуар или другая техника');
    if (powerKw !== undefined) reasons.push(`Мощность около ${powerKw} кВт соответствует заданному диапазону`);
    if (profile.wantsEnclosedGenerator && flags.hasGeneratorEnclosureSignal) reasons.push('Есть признаки закрытого или шумозащитного исполнения');
    if (profile.wantsElectricStart && flags.hasElectricStart) reasons.push('Есть признаки запуска ключом/кнопкой');
  }

  if (profile.intent === 'weldingGenerator' && flags.isWeldingGenerator) {
    reasons.push('Подходит по классу: сварочный генератор, а не обычная электростанция');
  }

  if (profile.intent === 'generatorOil' && flags.isGeneratorOil) {
    reasons.push('Подходит по классу: масло для генератора');
  }

  if (profile.intent === 'engineOil' && flags.isEngineOil) {
    reasons.push(fromEscaped('\\u041f\\u043e\\u0434\\u0445\\u043e\\u0434\\u0438\\u0442 \\u043f\\u043e \\u043a\\u043b\\u0430\\u0441\\u0441\\u0443: 4-\\u0442\\u0430\\u043a\\u0442\\u043d\\u043e\\u0435 \\u043c\\u043e\\u0442\\u043e\\u0440\\u043d\\u043e\\u0435 \\u043c\\u0430\\u0441\\u043b\\u043e'));
  }

  if (profile.intent === 'generatorAccessory' && (flags.isGeneratorAccessory || flags.isGeneratorOil)) {
    reasons.push('Подходит по классу: расходник или аксессуар для генератора');
  }

  if (profile.intent === 'plateAccessory' && flags.isPlateAccessory) {
    reasons.push(fromEscaped('\\u041f\\u043e\\u0434\\u0445\\u043e\\u0434\\u0438\\u0442 \\u043f\\u043e \\u043a\\u043b\\u0430\\u0441\\u0441\\u0443: \\u043a\\u043e\\u0432\\u0440\\u0438\\u043a/\\u043d\\u0430\\u043a\\u043b\\u0430\\u0434\\u043a\\u0430 \\u043a \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0435'));
  }

  if (profile.intent === 'plate' && flags.isPlate) {
    reasons.push('Подходит по классу: прямоходная виброплита для основания и плиточных работ');
  }

  if (profile.intent === 'cutter' && flags.isCutter) {
    reasons.push('Подходит по классу: швонарезчик/резчик для дорожных и бетонных работ');
  }

  if (profile.intent === 'diamondBlade' && flags.isDiamondBlade) {
    reasons.push('Подходит по классу: алмазный диск/оснастка под текущую задачу резки');
  }

  if (profile.intent === 'diamondCore' && flags.isDiamondCore) {
    reasons.push('Подходит по классу: алмазная коронка под бурение');
  }

  if (profile.intent === 'trowel' && flags.isTrowel) {
    reasons.push('Подходит по классу: затирочная машина для бетонного пола');
  }

  if (profile.intent === 'roller' && flags.isRoller) {
    reasons.push('Подходит по классу: виброкаток для уплотнения');
  }
  if ((state.featureSignals.portable >= 0.45 || state.featureSignals.compact >= 0.45) && weight !== undefined) {
    if (weight <= 80) reasons.push(`Легкая модель для своего класса: около ${weight} кг, ее проще перевозить и переносить`);
    else if (weight <= 110) reasons.push(`Вес около ${weight} кг: переносимость уже надо оценить по условиям, но это не тяжелый промышленный класс`);
    else reasons.push(`Вес около ${weight} кг: подойдет только если есть способ погрузки и перемещения`);
  }

  if (state.featureSignals.lowNoise >= 0.45) {
    if (containsAny(text, inverterTerms)) reasons.push('Инверторный тип лучше подходит для бытовых задач, где важны шум и стабильность питания');
    else if (containsAny(text, quietTerms)) reasons.push('В описании есть признаки тихого исполнения или закрытого кожуха');
  }

  if (state.featureSignals.professionalDuty >= 0.45) {
    if (containsAny(text, professionalTerms) || containsAny(text, dieselTerms)) reasons.push('Больше подходит под регулярную профессиональную нагрузку, чем бытовые облегченные варианты');
    if (powerKw !== undefined && powerKw >= 8) reasons.push(`Мощность около ${powerKw} кВт дает запас для рабочих нагрузок`);
  }

  if (state.featureSignals.coldStart >= 0.45 && containsAny(text, coldStartTerms)) {
    reasons.push('Есть признаки исполнения, которое полезно для запуска и работы в холодных условиях');
  }

  if (state.featureSignals.budgetSensitive >= 0.45 && product.price && reasons.length < 3) {
    reasons.push(`Цена в карточке: ${product.price.toLocaleString('ru-RU')} ${product.currency ?? 'RUB'}, актуальность нужно проверить перед оформлением`);
  }

  const usefulCriteria = criteria.filter((criterion) => !/^подбор\s+/i.test(criterion.trim()));
  for (const criterion of usefulCriteria.slice(0, 3)) {
    if (reasons.length >= 3) break;
    reasons.push(`Учитывает вашу задачу: ${criterion}`);
  }

  return reasons.length ? reasons.slice(0, 3) : ['Найден в каталоге БАКАУТ по вашему запросу'];
}

function cardDiagnostics(
  profile: ProductFitProfile,
  selectedCount: number,
  selectedRejectedCount: number,
  rankedCount: number,
  fallbackSuppressed: boolean,
  fallbackReason?: string
): CardSelectionDiagnostics {
  return {
    profile: {
      intent: profile.intent,
      requestedBrands: profile.requestedBrands,
      wantsGasoline: profile.wantsGasoline,
      wantsDiesel: profile.wantsDiesel,
      wantsElectricStart: profile.wantsElectricStart,
      wantsInverterGenerator: profile.wantsInverterGenerator,
      wantsEnclosedGenerator: profile.wantsEnclosedGenerator,
      wantsConventionalGenerator: profile.wantsConventionalGenerator,
      desiredPowerRange: profile.desiredPowerRange,
      generatorPower: profile.generatorPower,
      budgetMax: profile.budgetMax
    },
    selectedCount,
    selectedRejectedCount,
    rankedCount,
    fallbackSuppressed,
    fallbackReason
  };
}

function isLeadAction(action: AssistantTurnAction) {
  return action === 'collect_lead' || action === 'handoff_specialist';
}

function isLeadPlan(plan: AssistantTurnPlan) {
  return isLeadAction(plan.action) || plan.answerMode === 'leadCollection' || plan.followUpPolicy === 'collectLead';
}

function fallbackDetectPurchaseIntent(text: string) {
  return /(?:\bbuy\b|\border\b|\btake\b|куплю|беру|возьму|давайте|оформ|заказ|в\s+заявк|оставлю\s+контакт|передайте\s+менеджеру)/iu.test(text);
}

function fallbackDetectOwnershipCostQuestion(text: string) {
  const normalized = text.toLowerCase();
  const hasServiceOrCostTerm = /(?:сервис|обслуживан|регламент|то\b|ремонт|запчаст|детал|расходник|фильтр|свеч|ремен|стоимост|цен[ауы]|ценник|владени|эксплуатацион|service|maintenance|repair|spare|parts|consumable|ownership)/iu.test(normalized);
  const asksForFacts = /(?:сколько|стоит|цены?|стоимост|что\s+по|как\s+с|сравн|ориентир|актуальн|в\s+сети|какие|меняют|дорог|дешев|выгодн|затрат)/iu.test(normalized);
  return hasServiceOrCostTerm && asksForFacts;
}

function fallbackDetectCurrentLineupQuestion(text: string) {
  const normalized = text.toLowerCase();
  return /(?:выпуска(?:ет|ется|ют|ютcя)?|производ(?:ит|ится|ят|ятcя)?|снят[аоы]?\s+с\s+производства|снима(?:ют|ется)\s+с\s+производства|актуальн(?:ая|ой|ую)?\s+линейк|текущ(?:ая|ей|ую)?\s+линейк|еще\s+в\s+линейк|ещ[её]\??|сейчас\s+(?:есть|выпуска|производ)|current\s+lineup|discontinued|still\s+made|still\s+produced)/iu.test(normalized);
}

function shouldUseCurrentLineupStyle(userMessage: string, plan?: AssistantTurnPlan) {
  if (plan?.answerMode === 'currentLineup') return true;
  if (plan?.answerMode && plan.answerMode !== 'unknown') return false;
  return fallbackDetectCurrentLineupQuestion(userMessage) && !fallbackDetectOwnershipCostQuestion(userMessage);
}

function shouldUseWebSearch(userMessage: string, plan: AssistantTurnPlan) {
  const planText = [
    plan.action,
    plan.catalogSearchQuery,
    plan.answerGuidance,
    plan.missingInformation.join(' ')
  ].join(' ');
  const fallbackAllowed = plan.answerMode === 'unknown';
  return plan.needsWebSearch ||
    plan.action === 'verify_with_web' ||
    plan.answerMode === 'serviceCostComparison' ||
    plan.answerMode === 'currentLineup' ||
    (fallbackAllowed && fallbackDetectOwnershipCostQuestion(`${userMessage} ${planText}`));
}

function shouldUseDetailedFactStyle(userMessage: string, plan: AssistantTurnPlan, cardCount: number) {
  if (plan.answerMode === 'serviceCostComparison' || plan.answerMode === 'detailedFact') return true;
  if (plan.answerMode === 'currentLineup') return false;
  if (plan.answerMode && plan.answerMode !== 'unknown') return false;
  if (cardCount > 0 && plan.action === 'recommend_products') return false;
  if (shouldUseCurrentLineupStyle(userMessage, plan)) return false;
  const text = [
    userMessage,
    plan.catalogSearchQuery,
    plan.answerGuidance,
    plan.missingInformation.join(' ')
  ].join(' ');
  return fallbackDetectOwnershipCostQuestion(text) || /(?:подроб|развернут|таблиц|сравнени|ориентир)/iu.test(text);
}

function shouldUseDeepReasoningForPlanning(userMessage: string, conflicts: DataConflict[]) {
  return fallbackDetectCurrentLineupQuestion(userMessage) ||
    fallbackDetectOwnershipCostQuestion(userMessage) ||
    conflicts.length > 0;
}

function resolveReasoningProfile(
  baseModel: string,
  baseEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
  deepReasoning: boolean,
  complexityScore = 0
): { model: string; effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' } {
  if (!deepReasoning) return { model: baseModel, effort: baseEffort };
  return {
    model: config.OPENAI_DEEP_REASONING_MODEL,
    effort: complexityScore >= 2 ? 'xhigh' : 'high'
  };
}

function shouldUseDeepReasoningForAnswer(plan: AssistantTurnPlan, currentLineupStyle: boolean, detailedFactStyle: boolean, mustUseWebSearch: boolean, conflictCount: number) {
  return plan.answerMode === 'currentLineup' ||
    plan.answerMode === 'serviceCostComparison' ||
    plan.answerMode === 'detailedFact' ||
    plan.action === 'verify_with_web' ||
    plan.needsWebSearch ||
    currentLineupStyle ||
    detailedFactStyle ||
    mustUseWebSearch ||
    conflictCount > 0;
}

function roundNumber(value: number | undefined, digits = 2) {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function productComparisonSnapshot(product: Product) {
  const power = extractGeneratorPower(product);
  return {
    id: product.id,
    name: product.name,
    price: product.price,
    currency: product.currency ?? 'RUB',
    nominalPowerKw: roundNumber(power.nominalKw),
    maxPowerKw: roundNumber(power.maxKw)
  };
}

function buildCatalogComparisonDiagnostics(userMessage: string, products: Product[]) {
  const modelTokens = extractModelTokens(userMessage).map((token) => compactModelText(token));
  if (!modelTokens.length) return null;

  const baseline = products.find((product) => {
    const productText = compactModelText(productFullText(product));
    return modelTokens.some((token) => productText.includes(token));
  });
  if (!baseline) return null;

  const baselineSnapshot = productComparisonSnapshot(baseline);
  const baselinePower = baselineSnapshot.nominalPowerKw ?? baselineSnapshot.maxPowerKw;
  const alternatives = products
    .filter((product) => product.id !== baseline.id)
    .slice(0, PLANNER_CANDIDATE_LIMIT)
    .map((product) => {
      const snapshot = productComparisonSnapshot(product);
      const candidatePower = snapshot.nominalPowerKw ?? snapshot.maxPowerKw;
      const priceDeltaRub = typeof snapshot.price === 'number' && typeof baselineSnapshot.price === 'number'
        ? roundNumber(snapshot.price - baselineSnapshot.price, 2)
        : undefined;
      const powerDeltaKw = candidatePower !== undefined && baselinePower !== undefined
        ? roundNumber(candidatePower - baselinePower, 2)
        : undefined;
      return {
        ...snapshot,
        priceDeltaRub,
        powerDeltaKw,
        isCheaper: priceDeltaRub === undefined ? null : priceDeltaRub < 0,
        isMorePowerful: powerDeltaKw === undefined ? null : powerDeltaKw > 0,
        isCheaperAndMorePowerful: priceDeltaRub !== undefined && powerDeltaKw !== undefined
          ? priceDeltaRub < 0 && powerDeltaKw > 0
          : null
      };
    });

  return {
    baseline: baselineSnapshot,
    alternatives,
    hasCheaperAndMorePowerfulAlternative: alternatives.some((item) => item.isCheaperAndMorePowerful === true)
  };
}

function buildFactualVerificationPolicy(input: {
  userMessage: string;
  plan: AssistantTurnPlan;
  currentLineupStyle: boolean;
  detailedFactStyle: boolean;
}) {
  if (!input.currentLineupStyle && !input.detailedFactStyle && input.plan.action !== 'verify_with_web') return null;

  if (input.currentLineupStyle) {
    return {
      mode: 'current_lineup_status',
      question: input.userMessage,
      sourceCoverage: [
        'manufacturer current product/catalog pages',
        'manufacturer support, manuals and spare-parts pages',
        'official distributors and current dealer catalogs',
        'archived, used-equipment and parts-only evidence',
        'explicit discontinued, successor or replacement notices when available'
      ],
      inferenceRules: [
        'A current-production or current-lineup claim needs positive current evidence, preferably from manufacturer or official current catalog.',
        'Absence from the current manufacturer catalog is evidence for "not visible in the current public lineup"; it is not by itself proof that production stopped.',
        'A discontinued/replaced claim needs explicit discontinued/replacement evidence, or a consistent pattern where current official sources omit the model while only used, archived or parts/support pages remain.',
        'Catalog stock, spare parts, manuals or used listings prove support/market presence only; they do not prove current factory production.',
        'Do not call an alternative model a successor or replacement unless a source explicitly supports that relationship; otherwise call it a current model in the same class or a practical alternative.',
        'If neither side is proven, preserve the known facts and state the confidence level instead of forcing yes/no.'
      ],
      answerRules: [
        'Give the buyer the practical answer first.',
        'Separate confirmed facts from inference.',
        'Do not expose URLs, domains or markdown links.',
        'Name a successor/current replacement only when the search result clearly supports it.',
        'When listing current alternatives, do not make the list sound exhaustive unless the evidence covers the whole current line; distinguish single-direction plates from reversible plates.',
        'After finding source-mentioned alternatives or current same-class lineups, check catalogLineupAlternatives/catalogCandidates and say which concrete alternatives are present in our catalog with prices; if none are present, say that explicitly.',
        'A same-family catalog item near the questioned model is catalog presence only; do not call it a current manufacturer alternative, successor or replacement unless web evidence also supports that relation.',
        'If mandatoryCatalogLineupAlternativeFacts is non-empty, use its concrete model names and RUB prices in the buyer-facing answer.',
        'When several catalog alternatives are present, name the best 1-3 by buyer relevance and price, then briefly group other relevant source-mentioned families from catalogLineupAlternativeGroups with RUB price floors; do not imply that the catalog contains only the models you named.'
      ],
      searchHints: [
        input.userMessage,
        input.plan.catalogSearchQuery,
        `${input.plan.catalogSearchQuery} official current product catalog`,
        `${input.plan.catalogSearchQuery} discontinued replacement successor`,
        `${input.plan.catalogSearchQuery} manual spare parts support used`
      ].filter(Boolean)
    };
  }

  return {
    mode: 'technical_factual_verification',
    question: input.userMessage,
    sourceCoverage: [
      'catalog data provided in context',
      'manufacturer documentation',
      'official service or parts documentation',
      'reputable dealer/marketplace price evidence when commercial facts are requested'
    ],
    inferenceRules: [
      'State a fact as confirmed only when the catalog or web evidence supports it.',
      'If evidence conflicts, say what is confirmed and what remains uncertain.',
      'If proof is missing, keep the known fact and mark the uncertain part as not confirmed.'
    ],
    answerRules: [
      'Do not show URLs, domains or markdown links.',
      'Answer the current buyer question directly; avoid generic handoff unless the fact cannot be responsibly answered.'
    ],
    searchHints: [
      input.userMessage,
      input.plan.catalogSearchQuery
    ].filter(Boolean)
  };
}

function webSearchContextSize(currentLineupStyle: boolean, detailedFactStyle: boolean, answerComplexityScore: number) {
  return currentLineupStyle || detailedFactStyle || answerComplexityScore >= 2 ? 'high' : 'medium';
}

function productLineupRole(product: Product) {
  const flags = classifyProduct(product);
  if (flags.isGenerator || flags.isWeldingGenerator) return 'generator';
  if (flags.isPlate) return 'plate';
  if (flags.isRammer) return 'rammer';
  if (flags.isRoller) return 'roller';
  if (flags.isCutter) return 'cutter';
  if (flags.isDiamondBlade) return 'diamondBlade';
  if (flags.isDiamondCore) return 'diamondCore';
  if (flags.isTrowel) return 'trowel';
  return 'unknown';
}

function isCoreLineupProduct(product: Product) {
  const flags = classifyProduct(product);
  if (flags.isGeneratorAccessory || flags.isGeneratorOil || flags.isEngineOil || flags.isPlateAccessory) return false;
  return productLineupRole(product) !== 'unknown';
}

function isSameLineupClass(anchor: Product, product: Product) {
  const anchorRole = productLineupRole(anchor);
  if (anchorRole === 'unknown') return false;
  return productLineupRole(product) === anchorRole;
}

function findLineupAnchorProduct(userMessage: string, state: CustomerNeedState, products: Product[]) {
  const profile = buildProductFitProfile(state, userMessage);
  return products.find((product) => isCoreLineupProduct(product) && productHasExactModel(product, profile)) ??
    products.find((product) => isCoreLineupProduct(product));
}

function catalogLineupAlternativesContext(products: Product[]) {
  return products.map((product) => ({
    id: product.id,
    name: product.name,
    family: productLineupFamily(product),
    applicationClass: productLineupApplicationClass(product),
    brand: product.brand,
    category: product.category,
    price: product.price,
    currency: product.currency ?? 'RUB',
    sourceUrl: product.sourceUrl
  }));
}

function productLineupFamily(product: Product) {
  const text = `${product.name} ${product.category}`;
  const match = text.match(/\b(APS|BPS|VP|WP|WPU|MP|DPU|DPS)\s*[-]?\s*\d*/i);
  return match ? match[1].toUpperCase() : 'unknown';
}

function productLineupApplicationClass(product: Product) {
  const text = `${product.name} ${product.category} ${product.description ?? ''}`.toLowerCase();
  const family = productLineupFamily(product);
  if (['WPU', 'DPU', 'DPS'].includes(family) || containsAny(text, ['реверсив', 'reversible'])) return 'reversible_or_heavier_class';
  if (family === 'APS' || containsAny(text, ['аккумулятор', 'battery', 'electric', 'электр'])) return 'battery_or_electric_class';
  if (containsAny(text, ['прямоход', 'single direction', 'single-direction'])) return 'single_direction_class';
  return 'same_broad_class';
}

type CatalogLineupAlternativeGroup = {
  family: string;
  applicationClass: string;
  count: number;
  minPrice: number | null;
  sampleNames: string[];
};

function catalogLineupAlternativeGroupsContext(products: Product[]) {
  const groups = new Map<string, CatalogLineupAlternativeGroup>();

  for (const product of products) {
    const family = productLineupFamily(product);
    const applicationClass = productLineupApplicationClass(product);
    const key = `${family}:${applicationClass}`;
    const existing: CatalogLineupAlternativeGroup = groups.get(key) ?? {
      family,
      applicationClass,
      count: 0,
      minPrice: null,
      sampleNames: []
    };
    existing.count += 1;
    if (typeof product.price === 'number') {
      existing.minPrice = existing.minPrice === null ? product.price : Math.min(existing.minPrice, product.price);
    }
    if (existing.sampleNames.length < 3) existing.sampleNames.push(product.name);
    groups.set(key, existing);
  }

  return [...groups.values()]
    .sort((a, b) => (a.minPrice ?? Number.MAX_SAFE_INTEGER) - (b.minPrice ?? Number.MAX_SAFE_INTEGER))
    .slice(0, 8);
}

function rubPrice(value?: number | null) {
  return typeof value === 'number'
    ? `${new Intl.NumberFormat('ru-RU').format(value)} ₽`
    : 'цена не указана';
}

function lineupFamilyFromText(value: string) {
  const match = value.match(/\b(APS|BPS|VP|WP|WPU|MP|DPU|DPS)\s*[-]?\s*\d*/i);
  return match ? match[1].toUpperCase() : 'unknown';
}

function productShortName(product: Product) {
  const brand = product.brand ? normalizeBrandKey(product.brand) : '';
  let name = product.name;
  if (brand && normalizeBrandKey(name).startsWith(brand)) {
    name = name.slice(product.brand?.length ?? 0).trim();
  }
  return name.replace(/\s+/g, ' ').trim();
}

function compactProductWithPrice(product: Product) {
  return `${productShortName(product)} - ${rubPrice(product.price)}`;
}

function mandatoryCatalogLineupAlternativeFacts(userMessage: string, products: Product[]) {
  if (!products.length) return '';

  const anchorFamily = lineupFamilyFromText(userMessage);
  const directDifferentFamily = products.filter((product) => {
    const family = productLineupFamily(product);
    const applicationClass = productLineupApplicationClass(product);
    return family !== anchorFamily && ['single_direction_class', 'same_broad_class'].includes(applicationClass);
  });
  const sameFamily = products.filter((product) => {
    const family = productLineupFamily(product);
    return anchorFamily !== 'unknown' && family === anchorFamily;
  });
  const familyGroups = catalogLineupAlternativeGroupsContext(products)
    .map((group) => {
      const classNote = group.applicationClass === 'reversible_or_heavier_class'
        ? 'реверсивная/другой класс'
        : group.applicationClass === 'battery_or_electric_class'
          ? 'аккумуляторная/электрическая'
          : 'прямоходная/близкий класс';
      return `${group.family}: от ${rubPrice(group.minPrice)} (${classNote})`;
    });

  const facts = [
    directDifferentFamily.length
      ? `Лучшие прямые альтернативы из каталога по другим текущим семействам: ${directDifferentFamily.slice(0, 3).map(compactProductWithPrice).join('; ')}.`
      : '',
    sameFamily.length
      ? `Позиции того же семейства, что и старая модель, есть в каталоге, но сами по себе не доказывают текущее заводское производство: ${sameFamily.slice(0, 2).map(compactProductWithPrice).join('; ')}.`
      : '',
    familyGroups.length
      ? `Семейства, которые тоже нашлись в каталоге: ${familyGroups.join('; ')}.`
      : ''
  ].filter(Boolean);

  return facts.join(' ');
}

function productFromCard(card: ProductCard): Product {
  return {
    id: card.id,
    name: card.name,
    brand: card.brand,
    category: card.category,
    price: card.price,
    currency: card.currency,
    imageUrl: card.imageUrl,
    sourceUrl: card.sourceUrl,
    specs: card.specs ?? {},
    description: null
  };
}

function lastShownProductCards(history: Message[]) {
  for (const message of [...history].reverse()) {
    if (message.role !== 'assistant') continue;
    const cards = (message.metadata as { productCards?: unknown })?.productCards;
    if (!Array.isArray(cards) || cards.length === 0) continue;
    return cards
      .filter((card): card is ProductCard => Boolean(card && typeof card === 'object' && typeof (card as ProductCard).id === 'string' && typeof (card as ProductCard).name === 'string'))
      .map((card) => productFromCard(card));
  }
  return [];
}

function recentConversationText(history: Message[], maxMessages = 10) {
  return history.slice(-maxMessages).map((message) => message.content).filter(Boolean).join(' ');
}

function mergeProductsById(products: Product[], extraProducts: Product[]) {
  const byId = new Map<string, Product>();
  for (const product of [...products, ...extraProducts]) byId.set(product.id, product);
  return [...byId.values()];
}

function isCoreEquipment(product: Product) {
  const flags = classifyProduct(product);
  return flags.isGenerator || flags.isWeldingGenerator || flags.isPlate || flags.isRammer || flags.isRoller || flags.isCutter || flags.isTrowel;
}

function isOilCard(product: Product) {
  const flags = classifyProduct(product);
  return flags.isEngineOil || flags.isGeneratorOil;
}

function productMentionedInText(product: Product, text: string) {
  const compactText = compactModelText(text);
  if (!compactText) return false;
  const modelTokens = extractModelTokens(product.name).filter((token) => compactModelText(token).length >= 6);
  if (modelTokens.some((token) => compactText.includes(compactModelText(token)))) return true;
  const brand = displayProductBrand(product) || product.brand;
  const compactBrand = compactModelText(brand ?? '');
  return compactBrand.length >= 3 && compactText.includes(compactBrand);
}

function selectedPurchaseProductIds(products: Product[], history: Message[], state: CustomerNeedState, userMessage: string, plan: AssistantTurnPlan) {
  const allProducts = mergeProductsById(products, lastShownProductCards(history));
  const byId = new Map(allProducts.map((product) => [product.id, product]));
  const selected = plan.selectedProductIds.map((id) => byId.get(id)).filter((product): product is Product => Boolean(product));
  const previousCards = lastShownProductCards(history);
  const activeText = [userMessage, plan.catalogSearchQuery, state.lastSummary, recentConversationText(history)].filter(Boolean).join(' ');
  const wantsOil = containsAny(activeText, oilTerms);
  const liters = requestedLiters(activeText);
  const exactModelTokens = extractModelTokens(activeText);
  const exactCoreProduct = allProducts.find((product) => {
    if (!isCoreEquipment(product)) return false;
    const productCompact = compactModelText(productFullText(product));
    return exactModelTokens.some((token) => productCompact.includes(compactModelText(token)));
  });
  const output: Product[] = [];
  const push = (product?: Product) => {
    if (product && !output.some((item) => item.id === product.id)) output.push(product);
  };

  push(selected.find((product) => isCoreEquipment(product) && productMentionedInText(product, activeText)) ?? previousCards.find(isCoreEquipment) ?? exactCoreProduct ?? selected.find(isCoreEquipment));

  if (wantsOil) {
    const profile = buildProductFitProfile(state, userMessage, plan.catalogSearchQuery, { ...plan.requiredProductTraits, productIntent: 'engineOil' });
    const matchingPreviousOil = previousCards.find((product) => isOilCard(product) && (!liters || productLiters(product) === liters));
    const explicitlyMentionedOil = selected.find((product) => isOilCard(product) && (!liters || productLiters(product) === liters) && productMentionedInText(product, userMessage));
    const oilOptions = allProducts
      .filter(isOilCard)
      .filter((product) => !liters || productLiters(product) === liters)
      .map((product) => ({ product, score: recommendationScore(product, state, userMessage, profile) }))
      .filter((item) => productFitPenalty(item.product, profile) >= 0)
      .sort((a, b) => b.score - a.score);
    push(explicitlyMentionedOil ?? matchingPreviousOil ?? selected.find((product) => isOilCard(product) && (!liters || productLiters(product) === liters)) ?? oilOptions[0]?.product);
  }

  if (output.length < 2) {
    for (const product of selected) {
      if (output.length >= 4) break;
      push(product);
    }
  }

  return output.map((product) => product.id);
}

function purchasePlanIfNeeded(plan: AssistantTurnPlan, products: Product[], history: Message[], state: CustomerNeedState, userMessage: string) {
  const leadRequested = isLeadPlan(plan);
  if (!leadRequested) return { plan, leadRequested };

  const selectedProductIds = selectedPurchaseProductIds(products, history, state, userMessage, plan);
  return {
    leadRequested,
    plan: {
      ...plan,
      action: 'collect_lead' as AssistantTurnAction,
      answerMode: 'leadCollection' as AnswerMode,
      followUpPolicy: 'collectLead' as FollowUpPolicy,
      contextScope: 'previousSelection' as ContextScope,
      searchScope: 'previousSelectionOnly' as SearchScope,
      selectedProductIds: selectedProductIds.length ? selectedProductIds : plan.selectedProductIds,
      answerGuidance: [
        plan.answerGuidance,
        'Покупатель перешел к оформлению. Не говори, что заявка уже создана или что ты уже взял товар в заявку. Коротко подтверди комплект по карточкам, попроси оставить имя и телефон в форме. Не продолжай подбор альтернатив, если покупатель их не просил.'
      ].filter(Boolean).join('\n')
    }
  };
}

function selectCardsFromPlan(products: Product[], state: CustomerNeedState, userMessage: string, plan: AssistantTurnPlan) {
  const baseProfile = buildProductFitProfile(state, userMessage, plan.catalogSearchQuery, plan.requiredProductTraits);
  const requestedBrandSet = ['generatorOil', 'engineOil', 'generatorAccessory', 'plateAccessory'].includes(baseProfile.intent)
    ? new Set<string>()
    : plan.searchScope === 'broadenAlternatives'
      ? new Set<string>()
    : requestedBrandKeysFromProducts(products, baseProfile.activeNeedText);
  const profile: ProductFitProfile = { ...baseProfile, requestedBrands: [...requestedBrandSet] };
  const policyTextOnly = plan.cardPolicy === 'textOnly';
  const policyServiceComparison = policyTextOnly &&
    (plan.answerMode === 'serviceCostComparison' || plan.answerMode === 'detailedFact');
  const policyCurrentLineup = policyTextOnly && plan.answerMode === 'currentLineup';
  const leadRequested = isLeadPlan(plan);
  const suppressCardsForFactualComparison = (policyServiceComparison || shouldUseDetailedFactStyle(userMessage, plan, 0)) &&
    !leadRequested &&
    plan.action !== 'recommend_products';
  const suppressCardsForCurrentLineupQuestion = (policyCurrentLineup || shouldUseCurrentLineupStyle(userMessage, plan)) &&
    !leadRequested &&
    plan.action !== 'recommend_products';
  const byId = new Map(products.map((product) => [product.id, product]));
  const selected = plan.selectedProductIds
    .map((id) => byId.get(id))
    .filter((product): product is Product => Boolean(product));
  const matchesRequestedBrand = (product: Product) => productMatchesRequestedBrand(product, requestedBrandSet);
  const currentNeedAllowsProduct = (product: Product) =>
    productFitPenalty(product, profile) >= 0 ||
    (exactModelCanBypassFit(profile) && !violatesHardRequiredTraits(product, profile) && productHasExactModel(product, profile));

  const isBroadenComparisonAnchor = (product: Product) =>
    plan.searchScope === 'broadenAlternatives' && productHasExactModel(product, profile);
  const score = (product: Product) => recommendationScore(product, state, userMessage, profile);
  const rankingScore = (product: Product) => score(product) - (isBroadenComparisonAnchor(product) ? 260 : 0);
  const rankedItems = products
    .map((product) => ({ product, score: rankingScore(product) }))
    .filter((item) => matchesRequestedBrand(item.product))
    .filter((item) => isCardWorthy(item.product, profile, item.score))
    .sort((a, b) => b.score - a.score);
  const ranked = diversifyRankedProducts(rankedItems);
  const selectedCards = selected
    .filter((product) => matchesRequestedBrand(product))
    .filter((product) => leadRequested || currentNeedAllowsProduct(product));
  if (!leadRequested) selectedCards.sort((a, b) => rankingScore(b) - rankingScore(a));
  const selectedRejectedCount = selected.length - selectedCards.length;

  if (suppressCardsForFactualComparison) {
    return {
      cards: [],
      diagnostics: cardDiagnostics(profile, selected.length, selectedRejectedCount, ranked.length, false, 'suppressed_for_factual_comparison')
    };
  }

  if (suppressCardsForCurrentLineupQuestion) {
    return {
      cards: [],
      diagnostics: cardDiagnostics(profile, selected.length, selectedRejectedCount, ranked.length, false, 'suppressed_for_current_lineup_question')
    };
  }

  if (policyTextOnly && !leadRequested) {
    return {
      cards: [],
      diagnostics: cardDiagnostics(profile, selected.length, selectedRejectedCount, ranked.length, false, 'suppressed_by_card_policy')
    };
  }

  if (selected.length) {
    const selectedIds = new Set(selectedCards.map((product) => product.id));
    const shouldAppendRanked = !leadRequested && plan.action !== 'ask_clarifying_question';
    const rankedIds = new Set(ranked.map((product) => product.id));
    const combinedRaw = plan.searchScope === 'broadenAlternatives' && shouldAppendRanked
      ? [
          ...ranked,
          ...selectedCards.filter((product) => !rankedIds.has(product.id))
        ]
      : [
          ...selectedCards,
          ...(shouldAppendRanked ? ranked.filter((product) => !selectedIds.has(product.id)) : [])
        ];
    const combined = !leadRequested && shouldAppendRanked
      ? diversifyRankedProducts(combinedRaw.map((product) => ({ product, score: rankingScore(product) })).sort((a, b) => b.score - a.score))
      : combinedRaw;
    const cards = productCards(combined, state, userMessage, profile);
    return {
      cards,
      diagnostics: cardDiagnostics(
        profile,
        selected.length,
        selectedRejectedCount,
        ranked.length,
        cards.length === 0,
        cards.length === 0 ? 'planner_selected_products_but_all_were_rejected_by_current_need' : undefined
      )
    };
  }

  const exactMatches = products
    .map((product) => ({ product, score: score(product) }))
    .filter((item) => matchesRequestedBrand(item.product))
    .filter((item) => productHasExactModel(item.product, profile) && isCardWorthy(item.product, profile, item.score))
    .map((item) => item.product);
  if (exactMatches.length && plan.action !== 'ask_clarifying_question' && plan.searchScope !== 'broadenAlternatives') {
    const cards = productCards(exactMatches, state, userMessage, profile);
    return {
      cards,
      diagnostics: cardDiagnostics(profile, selected.length, selectedRejectedCount, ranked.length, false)
    };
  }

  if (plan.action !== 'recommend_products') {
    return {
      cards: [],
      diagnostics: cardDiagnostics(profile, selected.length, selectedRejectedCount, ranked.length, false)
    };
  }

  const cards = productCards(ranked, state, userMessage, profile);
  return {
    cards,
    diagnostics: cardDiagnostics(
      profile,
      selected.length,
      selectedRejectedCount,
      ranked.length,
      cards.length === 0,
      cards.length === 0 ? 'no_relevant_cards_after_current_need_filters' : undefined
    )
  };
}

function cardsFromPlan(products: Product[], state: CustomerNeedState, userMessage: string, plan: AssistantTurnPlan) {
  return selectCardsFromPlan(products, state, userMessage, plan).cards;
}
function responseUsedWebSearch(value: unknown) {
  if (!value) return false;
  if (extractUrlCitations(value).length > 0) return true;
  return hasResponseNode(value, (object) => {
    const type = typeof object.type === 'string' ? object.type : '';
    return /web_search|search_result|url_citation/i.test(type);
  });
}

function extractResponseText(value: unknown, depth = 0): string {
  if (!value || depth > 8) return '';
  if (typeof value === 'string') return '';
  if (Array.isArray(value)) {
    return value.map((item) => extractResponseText(item, depth + 1)).filter(Boolean).join('\n').trim();
  }
  if (typeof value !== 'object') return '';

  const object = value as Record<string, unknown>;
  const objectType = typeof object.type === 'string' ? object.type : '';
  if (typeof object.output_text === 'string' && object.output_text.trim()) return object.output_text.trim();
  if (
    typeof object.text === 'string'
    && object.text.trim()
    && (!objectType || /output_text|message|text/i.test(objectType))
  ) {
    return object.text.trim();
  }

  const contentText = extractResponseText(object.content, depth + 1);
  if (contentText) return contentText;
  const outputText = extractResponseText(object.output, depth + 1);
  if (outputText) return outputText;
  const messageText = extractResponseText(object.message, depth + 1);
  if (messageText) return messageText;
  return '';
}

function normalizeEvidenceUrl(value?: string | null) {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.hash = '';
    url.searchParams.delete('utm_source');
    url.searchParams.delete('utm_medium');
    url.searchParams.delete('utm_campaign');
    return url.toString().replace(/\/$/, '');
  } catch {
    return value.replace(/\/$/, '');
  }
}

function visibleLinkLabel(label: string) {
  const trimmed = label.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return '';
  if (/(?:^|\s)[\w-]+(?:\.[\w-]+)+(?:\/|\s|$)/i.test(trimmed)) return '';
  return trimmed;
}

function stripDeferredOfferTail(answer: string) {
  return answer
    .replace(/\n{1,2}Если\s+(?:хотите|хочешь),?\s+(?:(?:я\s+)?(?:дальше\s+)?(?:могу\s+)?(?:сразу\s+)?(?:уже\s+)?)?(?:разложить|разложу|сравнить|сравню|подобрать|подберу|посмотреть|посмотрю|проверить|проверю)[\s\S]{0,500}$/iu, '')
    .replace(/\n{1,2}(?:Я\s+)?(?:могу|могу\s+дальше|дальше\s+могу)\s+(?:разложить|сравнить|подобрать|посмотреть|проверить)[\s\S]{0,500}$/iu, '')
    .replace(/(?:^|(?<=[.!?])\s+)(?:Если\s+[^.!?\n]{0,180},?\s+)?(?:я\s+)?(?:дальше\s+)?могу\s+(?:быстро\s+)?(?:собрать|разложить|сравнить|подобрать|посмотреть|проверить|дать)[\s\S]{0,500}$/iu, '')
    .replace(/(?:^|(?<=[.!?])\s+)Если\s+(?:хотите|хочешь),?\s+(?:следующим\s+сообщением\s+)?(?:я\s+)?могу\s+(?:сразу\s+)?(?:собрать|разложить|сравнить|подобрать|посмотреть|проверить|дать)[\s\S]{0,500}$/iu, '')
    .replace(/(?:^|(?<=[.!?])\s+)Если\s+(?:хотите|хочешь),?\s+дальше\s+(?:лучше\s+)?(?:смотреть|подбирать|сравнивать|проверять|искать)[\s\S]{0,500}$/iu, '');
}

function sanitizeVisibleAnswer(answer: string, plan?: AssistantTurnPlan) {
  let cleaned = answer
    .replace(/[^]*/g, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi, (_match, label: string) => visibleLinkLabel(label))
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\b(?:[\w-]+\.)+(?:ru|com|net|org|рф|su|io|dev|shop|site)\b(?:\/\S*)?/gi, '')
    .replace(/из\s+наличия/giu, 'из каталога')
    .replace(/(?:^|\n)\s*отлично,\s*беру\s+комплект:?/giu, '\nОк, комплект понятен:')
    .replace(/(?:^|\n)\s*беру\s+комплект:?/giu, '\nКомплект понятен:')
    .replace(/\s*\(\s*\)/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (plan?.followUpPolicy === 'answerNowNoDeferredOffer') {
    cleaned = stripDeferredOfferTail(cleaned);
  }
  return cleaned.trim();
}

export class AssistantService {
  constructor(
    private readonly conversations = new ConversationRepository(),
    private readonly products = new ProductRepository()
  ) {}

  async updateNeedState(current: CustomerNeedState, historySummary: string | null | undefined, userMessage: string, history: Message[], signal?: AbortSignal) {
    const client = createOpenAIClient();
    if (!client) throw new Error('AI service is unavailable');

    try {
      const response = await client.responses.create({
        model: config.OPENAI_PLANNER_MODEL,
        reasoning: { effort: config.OPENAI_PLANNER_REASONING_EFFORT },
        input: [
          { role: 'system', content: buildNeedExtractorPrompt() },
          {
            role: 'user',
            content: yaml.dump(cleanEmpty({
              currentNeedState: current,
              historySummary: historySummary || undefined,
              recentHistory: compactHistoryForAI(history, 4, 700),
              latestUserMessage: userMessage
            }))
          }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'need_state_update',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                explicitNeeds: { type: 'array', items: needItemSchema() },
                implicitNeeds: { type: 'array', items: needItemSchema() },
                constraints: { type: 'array', items: needItemSchema() },
                importantCriteria: { type: 'array', items: needItemSchema() },
                confirmedFacts: { type: 'array', items: needItemSchema() },
                uncertainInferences: { type: 'array', items: needItemSchema() },
                contradictions: { type: 'array', items: needItemSchema() },
                featureSignals: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    portable: { type: 'number', minimum: 0, maximum: 1 },
                    homeUse: { type: 'number', minimum: 0, maximum: 1 },
                    compact: { type: 'number', minimum: 0, maximum: 1 },
                    lowNoise: { type: 'number', minimum: 0, maximum: 1 },
                    coldStart: { type: 'number', minimum: 0, maximum: 1 },
                    professionalDuty: { type: 'number', minimum: 0, maximum: 1 },
                    budgetSensitive: { type: 'number', minimum: 0, maximum: 1 }
                  },
                  required: [
                    'portable',
                    'homeUse',
                    'compact',
                    'lowNoise',
                    'coldStart',
                    'professionalDuty',
                    'budgetSensitive'
                  ]
                },
                lastSummary: { type: 'string' }
              },
              required: [
                'explicitNeeds',
                'implicitNeeds',
                'constraints',
                'importantCriteria',
                'confirmedFacts',
                'uncertainInferences',
                'contradictions',
                'featureSignals',
                'lastSummary'
              ]
            }
          }
        },
        max_output_tokens: jsonOutputTokenLimit(config.OPENAI_NEED_MAX_OUTPUT_TOKENS)
      }, signal ? { signal } : undefined);
      logOpenAIUsage('need_extraction', config.OPENAI_PLANNER_MODEL, response);
      const outputText = response.output_text ?? response.output?.[0]?.content?.[0]?.text;
      const parsed = parseJsonObject(outputText, 'need_extraction');
      const aiUpdate = coerceNeedUpdate(parsed);
      const merged = mergeNeedState(current, mergeNeedState(emptyNeedState(), aiUpdate));
      merged.lastSummary = parsed.lastSummary || summarizeNeedState(merged);
      return merged;
    } catch (error) {
      if (signal?.aborted) throw new Error('AI need extraction aborted');
      console.warn('OpenAI need extraction failed', safeError(error));
      const fallback = mergeNeedState(current, emptyNeedState());
      fallback.lastSummary = current.lastSummary || summarizeNeedState(current);
      return fallback;
    }
  }

  async planAssistantTurn(input: {
    userMessage: string;
    needState: CustomerNeedState;
    products: Product[];
    knowledgePages: Awaited<ReturnType<ProductRepository['searchCatalogPages']>>;
    conflicts: Awaited<ReturnType<ProductRepository['getOpenConflictsForProducts']>>;
    history: Message[];
    historySummary?: string | null;
    baseQuery: string;
    signal?: AbortSignal;
  }) {
    const client = createOpenAIClient();
    if (!client) throw new Error('AI service is unavailable');

    const deepPlanningReasoning = shouldUseDeepReasoningForPlanning(input.userMessage, input.conflicts);
    const planningProfile = resolveReasoningProfile(
      config.OPENAI_PLANNER_MODEL,
      config.OPENAI_PLANNER_REASONING_EFFORT,
      deepPlanningReasoning,
      input.conflicts.filter((conflict) => conflict.status === 'open').length
    );
    const plannerInput = [
      { role: 'system', content: buildTurnPlannerPrompt() },
      {
        role: 'user',
        content: yaml.dump(cleanEmpty({
          latestUserMessage: input.userMessage,
          currentNeedState: input.needState,
          historySummary: input.historySummary || undefined,
          recentHistory: compactHistoryForAI(input.history, 4, PLANNER_HISTORY_CONTENT_LIMIT),
          preliminaryCatalogCandidates: input.products.slice(0, PLANNER_CANDIDATE_LIMIT).map((product) => ({
            id: product.id,
            name: product.name,
            brand: product.brand,
            category: product.category,
            price: product.price,
            currency: product.currency,
            sourceUrl: product.sourceUrl,
            description: truncateForAI(product.description, PLANNER_PRODUCT_DESCRIPTION_LIMIT),
            specs: product.specs
          })),
          knowledgePages: input.knowledgePages.slice(0, 6).map((page) => ({
            title: page.title,
            pageType: page.pageType,
            sourceUrl: page.sourceUrl,
            summary: truncateForAI(page.summary, PLANNER_PAGE_SUMMARY_LIMIT),
            contentExcerpt: truncateForAI(page.content, PLANNER_PAGE_CONTENT_LIMIT)
          })),
          openDataConflicts: input.conflicts
        })
      }
    ];
    const plannerRequest = {
      model: planningProfile.model,
      reasoning: { effort: planningProfile.effort },
      input: plannerInput,
      text: {
        format: {
          type: 'json_schema',
          name: 'assistant_turn_plan',
          strict: true,
          schema: turnPlanSchema()
        }
      },
      max_output_tokens: jsonOutputTokenLimit(config.OPENAI_PLANNER_MAX_OUTPUT_TOKENS)
    };

    try {
      const response = await client.responses.create(plannerRequest, input.signal ? { signal: input.signal } : undefined);
      logOpenAIUsage('turn_planner', planningProfile.model, response);
      const parsed = parseJsonObject(response.output_text || '{}', 'turn_planner');
      return coerceTurnPlan(parsed, input.baseQuery, input.userMessage);
    } catch (error) {
      if (planningProfile.model !== config.OPENAI_PLANNER_MODEL) {
        try {
          const fallbackResponse = await client.responses.create({
            ...plannerRequest,
            model: config.OPENAI_PLANNER_MODEL,
            reasoning: { effort: config.OPENAI_PLANNER_REASONING_EFFORT }
          }, input.signal ? { signal: input.signal } : undefined);
          logOpenAIUsage('turn_planner_fallback', config.OPENAI_PLANNER_MODEL, fallbackResponse);
          const parsed = parseJsonObject(fallbackResponse.output_text || '{}', 'turn_planner');
          return coerceTurnPlan(parsed, input.baseQuery, input.userMessage);
        } catch (fallbackError) {
          console.warn('Deep planner fallback failed', safeError(fallbackError));
        }
      }
      if (input.signal?.aborted) throw new Error('AI turn planning aborted');
      console.warn('OpenAI turn planning failed', safeError(error));
      return fallbackTurnPlan(input);
    }
  }

  async findProducts(userMessage: string, state: CustomerNeedState, retrievalQuery?: string, traits?: RequiredProductTraits, signal?: AbortSignal) {
    const query = retrievalQuery?.trim() || productSearchText(userMessage, state);
    const profile = buildProductFitProfile(state, userMessage, query, traits);
    const modelTokens = extractModelTokens(query);
    const exactResults = modelTokens.length ? await this.products.searchProductsByModelTokens(modelTokens, 30).catch(() => []) : [];
    const textResults = await this.products.searchProducts(query, 200);
    const supplementalLimit = profile.intent === 'generator' ? 360 : 120;
    const supplementalResults = (await Promise.all(
      supplementalCatalogQueries(profile).map((item) => this.products.searchProducts(item, supplementalLimit).catch(() => []))
    )).flat();
    const embedding = await createEmbedding(query, signal).catch(() => null);
    const vectorResults = embedding ? await this.products.vectorSearch(embedding, 50).catch(() => []) : [];
    const byId = new Map<string, Product>();
    for (const product of [...exactResults, ...textResults, ...supplementalResults, ...vectorResults]) byId.set(product.id, product);
    const scored = [...byId.values()]
      .map((product) => ({ product, score: recommendationScore(product, state, userMessage, profile) }))
      .sort((a, b) => b.score - a.score);
    const hasExactModelMatch = scored.some((item) => item.score >= 200);
    const filtered = scored
      .filter((item) => !hasExactModelMatch || item.score >= 120)
      .filter((item) => profile.intent === 'unknown' || productFitPenalty(item.product, profile) >= 0 || (exactModelCanBypassFit(profile) && productHasExactModel(item.product, profile)))
      .reduce<Array<{ product: Product; score: number }>>((items, item) => {
        if (items.length < PLANNER_CANDIDATE_LIMIT * 2) items.push(item);
        return items;
      }, [])
      .sort((a, b) => b.score - a.score);
    return diversifyRankedProducts(filtered).slice(0, PLANNER_CANDIDATE_LIMIT);
  }

  async findKnowledgePages(userMessage: string, state: CustomerNeedState, retrievalQuery?: string, signal?: AbortSignal) {
    const query = retrievalQuery?.trim() || productSearchText(userMessage, state);
    const textResults = await this.products.searchCatalogPages(query, 6).catch(() => []);
    const embedding = await createEmbedding(query, signal).catch(() => null);
    const vectorResults = embedding ? await this.products.vectorSearchCatalogPages(embedding, 4).catch(() => []) : [];
    const byUrl = new Map<string, (typeof textResults)[number]>();
    for (const page of [...textResults, ...vectorResults]) byUrl.set(page.sourceUrl, page);
    return [...byUrl.values()].slice(0, 6);
  }

  async findCatalogLineupAlternatives(userMessage: string, state: CustomerNeedState, candidates: Product[]) {
    const anchor = findLineupAnchorProduct(userMessage, state, candidates);
    if (!anchor?.brand || !anchor.category) return [];

    const brandKey = normalizeBrandKey(anchor.brand);
    if (brandKey.length < 3) return [];

    const query = `${anchor.brand} ${anchor.category}`;
    const results = await this.products.searchProducts(query, 160).catch(() => []);
    const profile = buildProductFitProfile(state, userMessage);
    const seen = new Set<string>();
    return results
      .filter((product) => {
        if (seen.has(product.id)) return false;
        seen.add(product.id);
        if (product.id === anchor.id) return false;
        if (!isCoreLineupProduct(product)) return false;
        if (!isSameLineupClass(anchor, product)) return false;
        if (!normalizeBrandKey(product.brand).includes(brandKey) && !brandKey.includes(normalizeBrandKey(product.brand))) return false;
        if (productHasExactModel(product, profile)) return false;
        return true;
      })
      .sort((a, b) => (Number(a.price ?? Number.MAX_SAFE_INTEGER) - Number(b.price ?? Number.MAX_SAFE_INTEGER)))
      .slice(0, 12);
  }

  async generateAnswer(input: GenerateAnswerInput): Promise<ChatResponsePayload> {
    const session = await this.conversations.getSession(input.sessionId);
    if (!session || session.status !== 'active') throw new Error('Conversation session is not active');

    await this.conversations.addMessage({ sessionId: input.sessionId, role: 'user', content: input.userMessage });
    const client = createOpenAIClient();
    if (!client) throw new Error('AI service is unavailable');

    const history = await this.conversations.listMessages(input.sessionId, 80);
    const needState = await this.updateNeedState(session.needState, session.historySummary, input.userMessage, history, input.signal);
    await this.conversations.updateNeedState(input.sessionId, needState);
    await this.conversations.updateSessionTopic(input.sessionId, deriveConversationTopic(input.userMessage, needState))
      .catch((error) => console.warn('Conversation topic update failed', safeError(error)));

    const baseQuery = productSearchText(input.userMessage, needState);
    const preliminaryCandidates = await this.findProducts(input.userMessage, needState, baseQuery, undefined, input.signal);
    const preliminaryKnowledgePages = await this.findKnowledgePages(input.userMessage, needState, baseQuery, input.signal);
    const preliminaryConflicts = await this.products.getOpenConflictsForProducts(preliminaryCandidates.map((product) => product.id));
    const plan = await this.planAssistantTurn({
      userMessage: input.userMessage,
      needState,
      products: preliminaryCandidates,
      knowledgePages: preliminaryKnowledgePages,
      conflicts: preliminaryConflicts,
      history,
      historySummary: session.historySummary,
      baseQuery,
      signal: input.signal
    });

    const refinedCandidates = plan.catalogSearchQuery !== baseQuery
      ? await this.findProducts(input.userMessage, needState, plan.catalogSearchQuery, plan.requiredProductTraits, input.signal)
      : [];
    const byId = new Map<string, Product>();
    for (const product of [...refinedCandidates, ...preliminaryCandidates]) byId.set(product.id, product);
    const leadRequestedBeforeCards = isLeadPlan(plan);
    if (leadRequestedBeforeCards) {
      for (const product of lastShownProductCards(history)) byId.set(product.id, product);
      const purchaseContextText = [
        input.userMessage,
        plan.catalogSearchQuery,
        needState.lastSummary,
        stateText(needState, ''),
        recentConversationText(history),
        lastShownProductCards(history).map((product) => product.name).join(' ')
      ].filter(Boolean).join(' ');
      const modelProducts = await this.products.searchProductsByModelTokens(extractModelTokens(purchaseContextText), 40).catch(() => []);
      for (const product of modelProducts) byId.set(product.id, product);
      if (containsAny(purchaseContextText, oilTerms)) {
        const oilProducts = await this.findProducts(input.userMessage, needState, purchaseContextText, {
          ...plan.requiredProductTraits,
          productIntent: 'engineOil'
        }, input.signal).catch(() => []);
        for (const product of oilProducts) byId.set(product.id, product);
      }
    }
    let allCandidates = [...byId.values()];
    const purchasePlan = purchasePlanIfNeeded(plan, allCandidates, history, needState, input.userMessage);
    const effectivePlan = purchasePlan.plan;
    const currentLineupStyle = shouldUseCurrentLineupStyle(input.userMessage, effectivePlan);
    const catalogLineupAlternatives = currentLineupStyle
      ? await this.findCatalogLineupAlternatives(input.userMessage, needState, allCandidates)
      : [];
    for (const product of catalogLineupAlternatives) byId.set(product.id, product);
    allCandidates = [...byId.values()];
    const selectedCandidateIds = new Set(effectivePlan.selectedProductIds);
    const candidates = [
      ...allCandidates.filter((product) => selectedCandidateIds.has(product.id)),
      ...allCandidates.filter((product) => !selectedCandidateIds.has(product.id))
    ].slice(0, PLANNER_CANDIDATE_LIMIT);
    const knowledgePages = plan.catalogSearchQuery !== baseQuery
      ? await this.findKnowledgePages(input.userMessage, needState, plan.catalogSearchQuery, input.signal)
      : preliminaryKnowledgePages;
    const conflicts = await this.products.getOpenConflictsForProducts(candidates.map((product) => product.id));
    const cardSelection = selectCardsFromPlan(candidates, needState, input.userMessage, effectivePlan);
    const cards = cardSelection.cards;
    const bundleTotalPrice = cards.length && cards.every((card) => typeof card.price === 'number')
      ? cards.reduce((total, card) => total + (card.price ?? 0), 0)
      : null;
    const detailedFactStyle = shouldUseDetailedFactStyle(input.userMessage, effectivePlan, cards.length);
    const mustUseWebSearch = shouldUseWebSearch(input.userMessage, effectivePlan);
    const deepAnswerReasoning = shouldUseDeepReasoningForAnswer(
      effectivePlan,
      currentLineupStyle,
      detailedFactStyle,
      mustUseWebSearch,
      conflicts.length
    );
    const answerComplexityScore = [currentLineupStyle, detailedFactStyle, mustUseWebSearch, conflicts.length > 0].filter(Boolean).length;
    const answerProfile = {
      model: config.OPENAI_ANSWER_MODEL,
      effort: config.OPENAI_ANSWER_REASONING_EFFORT
    } as const;
    const comparativeAnswerGuidance = effectivePlan.searchScope === 'broadenAlternatives'
      ? 'When the buyer compares alternatives against a named model, use catalogComparisonDiagnostics as authoritative for comparative claims: say cheaper only when isCheaper is true, say more powerful only when isMorePowerful is true, and if no alternative is both cheaper and more powerful, say that directly before listing tradeoffs.'
      : '';
    const factualVerificationGuidance = currentLineupStyle
      ? 'For current-lineup/manufacturing-status questions, do a multi-source proof analysis. Check current manufacturer/catalog evidence, support/manuals/parts evidence, official distributor/current dealer evidence, and used/archive/discontinued/replacement evidence. Do not turn "not found in the current catalog" into a definitive discontinued claim by itself. If proof is incomplete, state the known facts and confidence level. Do not call an alternative a successor/replacement unless the source explicitly supports that; otherwise call it a current alternative in the same class and distinguish single-direction from reversible plates. Cross-check source-mentioned alternatives against catalogLineupAlternatives/catalogCandidates and mention concrete in-catalog alternatives with prices when available. Catalog-only alternatives prove sale/support presence, not current factory production. If a same-family catalog item near the questioned model is not supported by web evidence as current, call it "есть в нашем каталоге", not "актуальная замена". If mandatoryCatalogLineupAlternativeFacts is non-empty, use it as the compact catalog facts block and include its concrete RUB prices in the answer. If catalogLineupAlternatives has several items, name the best 1-3 by relevance and price and use catalogLineupAlternativeGroups for one compact sentence about other source-mentioned families and their RUB price floors, especially if they are higher-price, reversible, battery/electric, or only broadly same-class.'
      : detailedFactStyle || effectivePlan.action === 'verify_with_web'
        ? 'For factual technical questions, separate confirmed facts from inference. Use web evidence to verify missing or conflicting facts, and keep uncertain parts explicitly marked as not confirmed.'
        : '';
    const factualVerificationPolicy = buildFactualVerificationPolicy({
      userMessage: input.userMessage,
      plan: effectivePlan,
      currentLineupStyle,
      detailedFactStyle
    });
    const searchContextSize = webSearchContextSize(currentLineupStyle, detailedFactStyle, answerComplexityScore);
    const responseStyle = currentLineupStyle
      ? {
          defaultLength: 'short',
          maxParagraphs: 3,
          maxBullets: 4,
          guidance: [
            factualVerificationGuidance,
            'Покупатель спрашивает, выпускается ли конкретная модель сейчас или есть ли она в текущей линейке.',
            'Ответь прямо с практическим выводом для покупателя: новая актуальная модель или, вероятнее, уже не текущая/не основная линейка. Не уходи в длинное сервисное сравнение, если последняя реплика его не просит.',
            'Разделяй факты: публичная текущая линейка производителя отдельно, товары и запчасти из нашего каталога отдельно. Если в catalogCandidates есть точная модель или запчасти к ней, упомяни это как факт каталога, но не называй это подтверждением производства у завода.',
            'Не подтягивай старые модели из предыдущего сравнения, если покупатель в последней реплике спрашивает только про одну модель.',
            'Не отправляй покупателя смотреть к дилеру как основной ответ: если нет заводского 100% подтверждения, скажи уровень уверенности и практический вывод.',
            'Не показывай товарные карточки и не заканчивай предложением продолжить потом в любых формулировках вроде "дальше сравню", "дальше могу собрать", "могу проверить"; лучше дай следующий полезный шаг: если нужна новая техника - смотреть актуальную замену, если уже есть эта модель - можно оценить ремонт/запчасти.'
          ].join(' ')
        }
      : detailedFactStyle
      ? {
          defaultLength: 'detailed',
          maxParagraphs: 6,
          maxBullets: 8,
          guidance: [
            'Покупатель спрашивает не просто карточку товара, а практическое сравнение по сервису, расходникам, запчастям или стоимости владения.',
            'Обязан закрыть вопрос в текущем ответе: дай сравнительный анализ, а не общий текст и не предложение продолжить потом.',
            'Структура обязательна: короткий вывод; затем список или таблица с позициями расходников/запчастей по каждой модели; затем итог по стоимости владения.',
            'В списке сравни минимум: воздушный фильтр, топливный фильтр/сетка, свеча, ремень, сервис-набор, режущие диски/круги, стартер, карбюратор/топливный узел, водяной узел или другие релевантные позиции.',
            'По каждой позиции дай цену в рублях: точную из каталога/поиска или рыночный диапазон/ориентир в ₽. Если точную цену найти нельзя, не пиши общий отказ; напиши ориентир или честно "не нашел уверенной цены" только для этой позиции.',
            'Не показывай карточки товаров для технического сравнения: карточки нужны для подбора/покупки, а здесь нужен только текстовый сравнительный ответ.',
            'Если точные цены зависят от региона, дилера или артикула, не уходи в отказ. Дай проверенные ориентиры, диапазоны или относительное сравнение и отдельно скажи, что финальную смету менеджер проверит перед заказом.',
            'Не подменяй стоимость расходников ценой самой машины. Если покупатель спрашивает про расходники и запчасти, сравни именно фильтры, свечи, ремни, диски, сервис-наборы, стартеры, карбюраторные/водяные узлы или другие релевантные позиции.',
            'При поиске цен на запчасти и расходники учитывай российские маркетплейсы, российские магазины запчастей и dyadko.ru, а не только зарубежные или официальные страницы.',
            'Если цена найдена в валюте на зарубежном источнике, переведи ее в рубли по актуальному или явно указанному курсу и пометь как ориентировочную.',
            'Не заканчивай предложением "могу дальше сравнить", если покупатель уже попросил сравнение: сделай это сравнение сразу.',
            'Не показывай URL, домены и markdown-ссылки; источники остаются внутренними.'
          ].join(' ')
        }
      : {
          defaultLength: 'short',
          maxParagraphs: 2,
          maxBullets: 3,
          guidance: purchasePlan.leadRequested
            ? 'The buyer is ready to proceed. Confirm the selected bundle shown in productCardsShown, mention item prices and the total from selectedBundleForLead when available, then ask them to leave name and phone in the opened form so a manager can verify availability/delivery and contact them. Do not say the order/lead is already created. Do not continue selecting alternatives.'
            : [
                'Answer like a human sales consultant. If productCardsShown is not empty, the text must be only a short conclusion: max 3-4 short sentences, max 2 model names, no full list of all cards. The main/best recommendation in text must be productCardsVisibleFirst[0]. Mention other visible cards only as alternatives. Do not call a lower card or hidden show-more card the best option. Do not end with a generic deferred offer like "if you want, I can continue"; give a finished recommendation for the current request.',
                comparativeAnswerGuidance
              ].filter(Boolean).join(' ')
        };

    const cardIdsForAnswer = new Set(cards.map((card) => card.id));
    const answerNeedsFullCatalogContext = currentLineupStyle ||
      detailedFactStyle ||
      mustUseWebSearch ||
      effectivePlan.action === 'verify_with_web';
    const productsForAnswer = answerNeedsFullCatalogContext
      ? candidates
      : cards.length
        ? candidates.filter((product) => cardIdsForAnswer.has(product.id)).slice(0, MAX_PRODUCT_CARDS)
        : candidates.slice(0, 8);

    const context = {
      ...buildAssistantContext({
        needState,
        historySummary: session.historySummary,
        products: productsForAnswer,
        knowledgePages,
        conflicts,
        messages: history
      }, {
        mode: answerNeedsFullCatalogContext ? 'expanded' : 'compact'
      }),
      productCardsShown: cards.map((card) => ({
        id: card.id,
        name: card.name,
        category: card.category,
        price: card.price,
        reasons: card.reasons.slice(0, 2)
      })),
      productCardsVisibleFirst: cards.slice(0, 4).map((card) => ({
        id: card.id,
        name: card.name,
        category: card.category,
        price: card.price,
        reasons: card.reasons.slice(0, 2)
      })),
      productCardsBehindShowMore: cards.slice(4).map((card) => ({
        id: card.id,
        name: card.name,
        category: card.category,
        price: card.price
      })),
      cardSelectionDiagnostics: cardSelection.diagnostics,
      leadRequested: purchasePlan.leadRequested,
      selectedBundleForLead: purchasePlan.leadRequested
        ? {
            items: cards.map((card) => ({
              name: card.name,
              price: card.price,
              currency: card.currency ?? 'RUB'
            })),
            totalPrice: bundleTotalPrice,
            currency: cards.find((card) => card.currency)?.currency ?? 'RUB'
          }
        : null,
      catalogComparisonDiagnostics: effectivePlan.searchScope === 'broadenAlternatives'
        ? buildCatalogComparisonDiagnostics(input.userMessage, candidates)
        : null,
      catalogLineupAlternatives: catalogLineupAlternativesContext(catalogLineupAlternatives),
      catalogLineupAlternativeGroups: catalogLineupAlternativeGroupsContext(catalogLineupAlternatives),
      mandatoryCatalogLineupAlternativeFacts: mandatoryCatalogLineupAlternativeFacts(input.userMessage, catalogLineupAlternatives),
      factualVerificationPolicy,
      responseStyle
    };
    const answerInputPayload = {
      turnPlan: compactTurnPlanForAnswer(effectivePlan),
      answerContext: context,
      latestUserMessage: input.userMessage
    };

    let answer = '';
    let completedResponse: unknown;
    const baseAnswerStyleInstructions = currentLineupStyle
      ? 'Стиль ответа сейчас важен: покупатель спрашивает, выпускается ли конкретная модель сейчас. Ответь прямо и коротко: сначала вывод по текущей линейке/производству, затем отдельно что есть в нашем каталоге по самой модели или запчастям, если catalogCandidates это подтверждают. Если модель уже не текущая, но есть явный successor или актуальная замена, обязательно укажи это отдельной фразой. Не превращай ответ в сервисное сравнение и не подтягивай старые модели из предыдущей темы, если последняя реплика их не просит. Не отправляй покупателя смотреть к дилеру как основной ответ: если нет заводского 100% подтверждения, скажи уровень уверенности и практический вывод. Не показывай товарные карточки. Не заканчивай предложением продолжить потом в любых формулировках вроде "могу дальше сравнить", "дальше могу собрать", "могу проверить"; дай практический следующий шаг для покупателя: новая техника или обслуживание уже имеющейся модели. Не показывай внешние ссылки, URL, домены и markdown-ссылки: web search используется только внутренне.'
      : detailedFactStyle
        ? 'Стиль ответа сейчас важен: покупатель просит практическое сравнение по сервису, запчастям, расходникам или стоимости владения. Закрой вопрос в текущем ответе, без общего текста и без предложения продолжить потом. Дай только текстовый сравнительный ответ, без товарных карточек. Обязательная структура: короткий вывод; затем список или таблица расходников/запчастей по моделям; затем итог по стоимости владения. Сравни минимум воздушный фильтр, топливный фильтр/сетку, свечу, ремень, сервис-набор, режущие диски/круги, стартер, карбюратор/топливный узел, водяной узел или другие релевантные позиции. По каждой позиции дай цену в рублях: точную из каталога/поиска или рыночный диапазон/ориентир в ₽. Если точную цену найти нельзя, не пиши общий отказ; напиши ориентир или честно "не нашел уверенной цены" только для этой позиции. При поиске цен учитывай российские маркетплейсы, российские магазины запчастей и dyadko.ru. Если цена найдена в валюте на зарубежном источнике, переведи ее в рубли по актуальному или явно указанному курсу и пометь как ориентировочную. Не подменяй цены расходников ценой самой машины. Не показывай внешние ссылки, URL, домены и markdown-ссылки: web search используется только внутренне.'
        : 'Стиль ответа сейчас важен: пиши короче и проще. Если карточки товаров будут показаны под ответом, текст должен быть коротким выводом, а не вторым каталогом: 3-4 коротких предложения максимум, не больше двух моделей в тексте, без полного перечисления карточек. Главный/лучший вариант в тексте обязан быть первой видимой карточкой productCardsVisibleFirst[0]. Остальные видимые модели можно называть только как альтернативы; скрытые за кнопкой “Показать еще” можно упомянуть только как дополнительные варианты. Без длинных вступлений, без канцелярита, без роботизированных фраз. Говори как живой менеджер: спокойно, понятно, по делу. Не показывай внешние ссылки, URL, домены и markdown-ссылки: web search используется только внутренне.';
    const answerStyleInstructions = [
      baseAnswerStyleInstructions,
      factualVerificationGuidance,
      comparativeAnswerGuidance,
      effectivePlan.followUpPolicy === 'answerNowNoDeferredOffer' && !currentLineupStyle && !detailedFactStyle
        ? 'Планировщик запретил отложенный хвост ответа: не заканчивай предложением "могу дальше проверить/сравнить/подобрать"; дай законченный ответ на текущий вопрос.'
        : ''
    ].filter(Boolean).join('\n');
    const buildAnswerRequest = (model: string, effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh') => ({
      model,
      reasoning: { effort },
      instructions: `${buildSystemPrompt()}\n\n${answerStyleInstructions}`,
      input: [
        {
          role: 'user',
          content: yaml.dump(cleanEmpty(answerInputPayload))
        }
      ],
      stream: true,
      max_output_tokens: detailedFactStyle
        ? Math.max(config.OPENAI_MAX_OUTPUT_TOKENS, 5000)
        : mustUseWebSearch
          ? Math.max(config.OPENAI_MAX_OUTPUT_TOKENS, 2400)
          : config.OPENAI_MAX_OUTPUT_TOKENS
    });
    const executeAnswerRequest = async (request: Record<string, unknown>, logStage: string) => {
      let localAnswer = '';
      let localCompletedResponse: unknown;
      const stream = await client.responses.create(request, input.signal ? { signal: input.signal } : undefined);
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta' && event.delta) {
          localAnswer += event.delta;
        }
        if (event.type === 'response.completed' && event.response?.output_text && !localAnswer) {
          localAnswer = event.response.output_text;
        }
        if (event.type === 'response.output_text.done' && (event as { text?: string }).text && !localAnswer) {
          localAnswer = (event as { text: string }).text;
        }
        if (event.type === 'response.completed') {
          localCompletedResponse = event.response;
          if (!localAnswer) localAnswer = extractResponseText(event.response);
          logOpenAIUsage(logStage, String(request.model ?? config.OPENAI_ANSWER_MODEL), event.response);
        }
        if (event.type === 'response.incomplete') {
          localCompletedResponse = event.response;
          if (!localAnswer) localAnswer = extractResponseText(event.response);
          logOpenAIUsage(`${logStage}_incomplete`, String(request.model ?? config.OPENAI_ANSWER_MODEL), event.response);
        }
        if (event.type === 'response.failed') {
          localCompletedResponse = event.response;
          throw new Error('AI answer generation failed');
        }
      }
      if (!localAnswer && localCompletedResponse) localAnswer = extractResponseText(localCompletedResponse);
      return { answer: localAnswer, completedResponse: localCompletedResponse };
    };

    const answerRequest: Record<string, unknown> = buildAnswerRequest(answerProfile.model, answerProfile.effort);
    if (mustUseWebSearch) {
      answerRequest.tools = [{
        type: 'web_search_preview',
        search_context_size: searchContextSize
      }];
      answerRequest.tool_choice = { type: 'web_search_preview' };
    }

    try {
      const result = await executeAnswerRequest(answerRequest, 'answer');
      answer = result.answer;
      completedResponse = result.completedResponse;
    } catch (error) {
      if (answerProfile.model !== config.OPENAI_ANSWER_MODEL) {
        try {
          const fallbackAnswerRequest: Record<string, unknown> = buildAnswerRequest(config.OPENAI_ANSWER_MODEL, config.OPENAI_ANSWER_REASONING_EFFORT);
          if (mustUseWebSearch) {
            fallbackAnswerRequest.tools = [{
              type: 'web_search_preview',
              search_context_size: searchContextSize
            }];
            fallbackAnswerRequest.tool_choice = { type: 'web_search_preview' };
          }
          const result = await executeAnswerRequest(fallbackAnswerRequest, 'answer_fallback');
          answer = result.answer;
          completedResponse = result.completedResponse;
        } catch (fallbackError) {
          console.warn('Deep answer fallback failed', safeError(fallbackError));
          console.warn('OpenAI answer generation failed', safeError(error));
          throw new Error('AI answer generation failed');
        }
      } else {
        console.warn('OpenAI answer generation failed', safeError(error));
        throw new Error('AI answer generation failed');
      }
    }

    if (input.signal?.aborted) throw new Error('AI answer generation aborted');

    if (!answer.trim()) {
      console.warn('OpenAI answer generation completed without visible text', {
        answerMode: effectivePlan.answerMode,
        action: effectivePlan.action,
        mustUseWebSearch,
        currentLineupStyle,
        detailedFactStyle
      });
      try {
        const recoveryAnswerRequest: Record<string, unknown> = buildAnswerRequest(
          config.OPENAI_ANSWER_MODEL,
          config.OPENAI_ANSWER_REASONING_EFFORT
        );
        delete recoveryAnswerRequest.stream;
        delete recoveryAnswerRequest.tools;
        delete recoveryAnswerRequest.tool_choice;
        recoveryAnswerRequest.max_output_tokens = Math.min(
          Number(recoveryAnswerRequest.max_output_tokens ?? config.OPENAI_MAX_OUTPUT_TOKENS),
          1200
        );
        const recoveryResponse = await client.responses.create(
          recoveryAnswerRequest,
          input.signal ? { signal: input.signal } : undefined
        );
        logOpenAIUsage('answer_empty_recovery', config.OPENAI_ANSWER_MODEL, recoveryResponse);
        answer = extractResponseText(recoveryResponse);
        completedResponse = completedResponse ?? recoveryResponse;
      } catch (recoveryError) {
        if (input.signal?.aborted) throw new Error('AI answer generation aborted');
        console.warn('Empty answer recovery failed', safeError(recoveryError));
      }
    }

    if (!answer.trim()) {
      const catalogFacts = typeof context.mandatoryCatalogLineupAlternativeFacts === 'string'
        ? context.mandatoryCatalogLineupAlternativeFacts.trim()
        : '';
      answer = catalogFacts
        ? `Не утверждаю текущий заводской статус без завершенной внешней проверки. По нашему каталогу для ориентира: ${catalogFacts}`
        : 'Ответ не удалось надежно сформировать из проверенных данных. Повторите запрос короче, и я перепроверю по каталогу и внешним источникам.';
    }

    const usedWebSearch = responseUsedWebSearch(completedResponse);
    const rawAnswer = answer;
    answer = sanitizeVisibleAnswer(answer, effectivePlan);
    if (answer) await input.onDelta?.(answer);
    if (usedWebSearch && completedResponse) {
      await this.storeVerifiedWebFindings({
        userMessage: input.userMessage,
        answer: rawAnswer,
        products: candidates,
        response: completedResponse,
        signal: input.signal
      }).catch((error) => console.warn('Verified web fact storage failed', safeError(error)));
    }

    const assistantMessage = await this.conversations.addMessage({
      sessionId: input.sessionId,
      role: 'assistant',
      content: answer,
      metadata: {
        productCards: cards,
        usedWebSearch,
        webSearchRequired: mustUseWebSearch,
        responseStyle: currentLineupStyle ? 'current_lineup' : detailedFactStyle ? 'detailed_factual' : 'short',
        answerMode: effectivePlan.answerMode,
        cardPolicy: effectivePlan.cardPolicy,
        followUpPolicy: effectivePlan.followUpPolicy,
        contextScope: effectivePlan.contextScope,
        searchScope: effectivePlan.searchScope,
        internalSources: extractUrlCitations(completedResponse).slice(0, 12),
        turnPlan: effectivePlan,
        cardSelection: cardSelection.diagnostics
      }
    });

    this.maybeSummarizeHistory(input.sessionId, history.concat(assistantMessage), session.historySummary).catch(() => {});

    return { answer, needState, productCards: cards, usedWebSearch, leadRequested: purchasePlan.leadRequested, assistantMessageId: assistantMessage.id };
  }

  private async maybeSummarizeHistory(sessionId: string, history: Message[], existingSummary?: string | null) {
    if (history.length < 6) return;
    const client = createOpenAIClient();
    if (!client) return;
    try {
      const messagesToSummarize = history.slice(0, -4);
      if (!messagesToSummarize.length) return;
      const response = await client.responses.create({
        model: config.OPENAI_PLANNER_MODEL,
        input: [
          { role: 'system', content: 'Кратко опиши, что обсуждалось в этих сообщениях. Оставь только суть: что искали, что выбрали, какие условия важны. Если есть предыдущее резюме, объедини его с новыми сообщениями.' },
          { role: 'user', content: yaml.dump(cleanEmpty({
            previousSummary: existingSummary,
            newMessagesToSummarize: compactHistoryForAI(messagesToSummarize, 10, 700)
          })) }
        ]
      });
      const summary = (response.output_text ?? '').trim();
      if (summary) {
        await this.conversations.updateHistorySummary(sessionId, summary);
      }
    } catch (e) {
      console.warn('Background history summarization failed', safeError(e));
    }
  }

  private async storeVerifiedWebFindings(input: {
    userMessage: string;
    answer: string;
    products: Product[];
    response: unknown;
    signal?: AbortSignal;
  }) {
    const citations = extractUrlCitations(input.response);
    if (!citations.length) return;

    for (const citation of citations.slice(0, 12)) {
      const citationUrl = normalizeEvidenceUrl(citation.url);
      const product = input.products.find((item) => normalizeEvidenceUrl(item.sourceUrl) === citationUrl);
      await this.products.recordWebEvidence({
        productId: product?.id,
        query: input.userMessage,
        sourceUrl: citation.url,
        title: citation.title,
        snippet: citation.snippet,
        verdict: { answerExcerpt: input.answer.slice(0, 1200) }
      });
    }

    const client = createOpenAIClient();
    if (!client || !input.products.length) return;
    if (!config.OPENAI_ENABLE_WEB_FACT_EXTRACTION) return;

    const response = await client.responses.create({
      model: config.OPENAI_FACT_MODEL,
      reasoning: { effort: config.OPENAI_FACT_REASONING_EFFORT },
      input: [
        {
          role: 'system',
          content: 'Extract only confirmed product technical facts from the assistant answer and cited sources. Do not extract delivery, stock, discount, price, or special condition claims. Return an empty facts array unless the attribute, value, product, and source URL are explicit.'
        },
        {
          role: 'user',
          content: yaml.dump(cleanEmpty({
            products: input.products.map((product) => ({
              id: product.id,
              name: product.name,
              sourceUrl: product.sourceUrl
            })),
            citations,
            answer: input.answer
          }))
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'verified_web_facts',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              facts: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    productId: { type: 'string' },
                    attribute: { type: 'string' },
                    value: { type: 'string' },
                    unit: { type: ['string', 'null'] },
                    sourceUrl: { type: 'string' },
                    confidence: { type: 'number', minimum: 0, maximum: 1 }
                  },
                  required: ['productId', 'attribute', 'value', 'unit', 'sourceUrl', 'confidence']
                }
              }
            },
            required: ['facts']
          }
        }
      },
      max_output_tokens: config.OPENAI_FACT_MAX_OUTPUT_TOKENS
    }, input.signal ? { signal: input.signal } : undefined);
    logOpenAIUsage('web_fact_extraction', config.OPENAI_FACT_MODEL, response);

    const parsed = JSON.parse(response.output_text || '{"facts":[]}') as {
      facts?: Array<{ productId: string; attribute: string; value: string; unit?: string | null; sourceUrl?: string; confidence?: number }>;
    };

    const productIds = new Set(input.products.map((product) => product.id));
    const citationUrls = new Set(citations.map((citation) => normalizeEvidenceUrl(citation.url)));
    for (const fact of parsed.facts ?? []) {
      if (!productIds.has(fact.productId) || !fact.sourceUrl || !citationUrls.has(normalizeEvidenceUrl(fact.sourceUrl))) continue;
      if (!fact.attribute.trim() || !fact.value.trim()) continue;
      await this.products.upsertVerifiedWebFact({
        productId: fact.productId,
        attribute: fact.attribute.trim().toLowerCase(),
        value: fact.value.trim(),
        unit: fact.unit ?? null,
        sourceUrl: fact.sourceUrl,
        confidence: Math.max(0.6, Math.min(0.95, fact.confidence ?? 0.85))
      });
    }
  }
}

function needItemSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      value: { type: 'string' },
      evidence: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 }
    },
    required: ['value', 'evidence', 'confidence']
  };
}

function turnPlanSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: [
          'answer_question',
          'recommend_products',
          'ask_clarifying_question',
          'verify_with_web',
          'collect_lead',
          'handoff_specialist'
        ]
      },
      answerMode: {
        type: 'string',
        enum: [
          'short',
          'productRecommendation',
          'detailedFact',
          'serviceCostComparison',
          'currentLineup',
          'leadCollection',
          'unknown'
        ]
      },
      cardPolicy: {
        type: 'string',
        enum: ['auto', 'showProducts', 'showAccessories', 'textOnly']
      },
      followUpPolicy: {
        type: 'string',
        enum: [
          'auto',
          'answerNowNoDeferredOffer',
          'askClarifyingQuestion',
          'offerNextStepAllowed',
          'collectLead'
        ]
      },
      contextScope: {
        type: 'string',
        enum: ['latestMessageOnly', 'activeNeed', 'previousSelection', 'fullSession']
      },
      searchScope: {
        type: 'string',
        enum: ['focusedNeed', 'broadenAlternatives', 'sameBrandOnly', 'previousSelectionOnly']
      },
      catalogSearchQuery: { type: 'string' },
      selectedProductIds: {
        type: 'array',
        items: { type: 'string' },
        maxItems: MAX_PRODUCT_CARDS
      },
      requiredProductTraits: {
        type: 'object',
        additionalProperties: false,
        properties: {
          productIntent: {
            type: 'string',
            enum: [
              'generator',
              'weldingGenerator',
              'generatorOil',
              'engineOil',
              'generatorAccessory',
              'plateAccessory',
              'plate',
              'rammer',
              'roller',
              'cutter',
              'diamondBlade',
              'diamondCore',
              'trowel',
              'unknown'
            ]
          },
          productRole: {
            type: 'string',
            enum: ['coreProduct', 'accessory', 'consumable', 'unknown']
          },
          fuel: {
            type: 'string',
            enum: ['gasoline', 'diesel', 'any', 'unknown']
          },
          startType: {
            type: 'string',
            enum: ['electric', 'manual', 'any', 'unknown']
          },
          enclosure: {
            type: 'string',
            enum: ['enclosed', 'open', 'any', 'unknown']
          },
          conventionalGenerator: { type: ['boolean', 'null'] },
          singlePhase220: { type: ['boolean', 'null'] },
          nominalPowerKwMin: { type: ['number', 'null'] },
          nominalPowerKwMax: { type: ['number', 'null'] },
          maxPowerKwMin: { type: ['number', 'null'] },
          maxPowerKwMax: { type: ['number', 'null'] },
          powerReasoning: { type: 'string' }
        },
        required: [
          'productIntent',
          'productRole',
          'fuel',
          'startType',
          'enclosure',
          'conventionalGenerator',
          'singlePhase220',
          'nominalPowerKwMin',
          'nominalPowerKwMax',
          'maxPowerKwMin',
          'maxPowerKwMax',
          'powerReasoning'
        ]
      },
      needsWebSearch: { type: 'boolean' },
      missingInformation: {
        type: 'array',
        items: { type: 'string' }
      },
      answerGuidance: { type: 'string' }
    },
    required: [
      'action',
      'answerMode',
      'cardPolicy',
      'followUpPolicy',
      'contextScope',
      'searchScope',
      'catalogSearchQuery',
      'selectedProductIds',
      'requiredProductTraits',
      'needsWebSearch',
      'missingInformation',
      'answerGuidance'
    ]
  };
}

function safeError(error: unknown) {
  if (!error || typeof error !== 'object') return { message: String(error) };
  const value = error as { name?: string; status?: number; code?: string; message?: string };
  return {
    name: value.name,
    status: value.status,
    code: value.code,
    message: value.message
  };
}

function logOpenAIUsage(stage: string, model: string, response: unknown) {
  if (!config.DEBUG_OPENAI_USAGE || !response || typeof response !== 'object') return;
  const usage = (response as { usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
  } }).usage;
  if (!usage) return;
  console.info('OpenAI usage', {
    stage,
    model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
    totalTokens: usage.total_tokens
  });
}

function hasResponseNode(value: unknown, predicate: (object: Record<string, unknown>) => boolean, depth = 0): boolean {
  if (!value || depth > 8) return false;
  if (Array.isArray(value)) return value.some((item) => hasResponseNode(item, predicate, depth + 1));
  if (typeof value !== 'object') return false;

  const object = value as Record<string, unknown>;
  if (predicate(object)) return true;
  return Object.values(object).some((item) => hasResponseNode(item, predicate, depth + 1));
}

function extractUrlCitations(value: unknown, depth = 0): WebCitation[] {
  if (!value || depth > 8) return [];
  if (Array.isArray(value)) return value.flatMap((item) => extractUrlCitations(item, depth + 1));
  if (typeof value !== 'object') return [];

  const object = value as Record<string, unknown>;
  const type = typeof object.type === 'string' ? object.type : '';
  const url = typeof object.url === 'string' ? object.url : undefined;
  const isCitation = Boolean(url && /url_citation|web_search|search_result|citation/i.test(type));
  const own: WebCitation[] = isCitation && url
    ? [{
        url,
        title: typeof object.title === 'string' ? object.title : undefined,
        snippet: typeof object.snippet === 'string' ? object.snippet : undefined
      }]
    : [];

  return [
    ...own,
    ...Object.values(object).flatMap((item) => extractUrlCitations(item, depth + 1))
  ].filter((citation, index, all) => all.findIndex((item) => item.url === citation.url) === index);
}

export const assistantTestHooks = {
  buildProductFitProfile,
  selectCardsFromPlan,
  cardsFromPlan,
  sanitizeVisibleAnswer,
  recommendationScore,
  supplementalCatalogQueries,
  productFitPenalty,
  isCardWorthy,
  purchasePlanIfNeeded,
  shouldUseWebSearch,
  shouldUseDetailedFactStyle,
  shouldUseCurrentLineupStyle,
  shouldUseDeepReasoningForPlanning,
  shouldUseDeepReasoningForAnswer,
  resolveReasoningProfile,
  buildFactualVerificationPolicy,
  webSearchContextSize
};
