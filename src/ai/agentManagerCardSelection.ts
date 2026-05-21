import type { CustomerNeedState, Message, Product, ProductCard, ProductSelectionClass } from '../shared/types.js';
import type { AgentIntentContract, AnswerContract, ToolRequest, ToolResult } from './agentManagerContracts.js';
import type { ReducedDialogueLedgerState } from './dialogueLedgerReducer.js';
import {
  compactModelText,
  displayProductBrand,
  extractGeneratorPowerForHardSelection,
  extractModelTokens,
  extractWeightKg,
  inferProductIntent,
  isCoreEquipment,
  parseWeightNeedRangeKg,
  productMatchesIntent,
  productMentionedInText
} from './productClassifier.js';

export function productCards(products: Product[], reasons: string[] = []): ProductCard[] {
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

export function uniqueStrings(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
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

export const productSelectionClasses: ProductSelectionClass[] = [
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

function coerceProductSelectionClass(value: unknown): ProductSelectionClass {
  return productSelectionClasses.includes(value as ProductSelectionClass)
    ? value as ProductSelectionClass
    : 'unknown';
}

export function toolRequestProductIntent(request: ToolRequest, fallbackText = ''): ProductSelectionClass {
  const args = request.args as Record<string, unknown>;
  const explicit = coerceProductSelectionClass(args.productIntent);
  if (explicit !== 'unknown') return explicit;
  const semanticText = [
    typeof args.semanticQuery === 'string' ? args.semanticQuery : '',
    typeof args.query === 'string' ? args.query : '',
    typeof args.reason === 'string' ? args.reason : '',
    typeof args.notes === 'string' ? args.notes : '',
    request.rationale,
    fallbackText
  ].filter(Boolean).join('\n');
  return inferProductIntent(semanticText);
}

export function toolRequestScopedQuery(request: ToolRequest, fallbackQuery: string) {
  const args = request.args as Record<string, unknown>;
  const query = typeof args.query === 'string' && args.query.trim()
    ? args.query.trim()
    : fallbackQuery;
  const semanticQuery = typeof args.semanticQuery === 'string' && args.semanticQuery.trim()
    ? args.semanticQuery.trim()
    : [
        query,
        typeof args.reason === 'string' ? args.reason : '',
        typeof args.notes === 'string' ? args.notes : '',
        request.rationale
      ].filter(Boolean).join('\n');
  return { query, semanticQuery };
}

function intentFromContractToolRequests(intent: AgentIntentContract): ProductSelectionClass {
  for (const request of intent.toolRequests) {
    const productIntent = toolRequestProductIntent(request);
    if (productIntent !== 'unknown') return productIntent;
  }
  return 'unknown';
}

function inferVisibleCardIntent(input: {
  userMessage: string;
  history: Message[];
  intent: AgentIntentContract;
  answerText: string;
  needState: CustomerNeedState;
}): ProductSelectionClass {
  const toolIntent = intentFromContractToolRequests(input.intent);
  if (toolIntent !== 'unknown') return toolIntent;
  const semanticText = [
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

function productModelMentionedInText(product: Product, text: string) {
  const compactText = compactModelText(text);
  if (!compactText) return false;
  const modelTokens = extractModelTokens(product.name)
    .map((token) => compactModelText(token))
    .filter((token) => token.length >= 5);
  return modelTokens.some((token) => compactText.includes(token));
}

function productBrandMentionedInText(product: Product, text: string) {
  const compactText = compactModelText(text);
  const brand = displayProductBrand(product) || product.brand;
  const compactBrand = compactModelText(brand ?? '');
  const aliases = new Set([compactBrand]);
  if (compactBrand === compactModelText('ТСС')) aliases.add('tss');
  return [...aliases].some((alias) => alias.length >= 3 && compactText.includes(alias));
}

function answerMentionedProducts(products: Product[], answerText: string) {
  const exactModelMatches = products.filter((product) => productModelMentionedInText(product, answerText));
  const exactWithBrand = exactModelMatches.filter((product) => productBrandMentionedInText(product, answerText));
  if (exactWithBrand.length) return exactWithBrand;
  if (exactModelMatches.length) return exactModelMatches;
  return products.filter((product) => productMentionedInText(product, answerText));
}

function parseKw(value: string) {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function requestedPowerRangeKw(text: string) {
  const range = text.match(/(\d+(?:[,.]\d+)?)\s*(?:-|–|—|до)\s*(\d+(?:[,.]\d+)?)\s*(?:кВт|kw|kva|ква)/iu);
  if (range) {
    const left = parseKw(range[1]);
    const right = parseKw(range[2]);
    if (left !== undefined && right !== undefined) {
      return {
        min: Math.min(left, right),
        max: Math.max(left, right)
      };
    }
  }
  const exact = text.match(/(\d+(?:[,.]\d+)?)\s*(?:кВт|kw|kva|ква)/iu);
  const kw = exact ? parseKw(exact[1]) : undefined;
  return kw !== undefined ? { min: Math.max(0.1, kw - 0.75), max: kw + 0.75 } : undefined;
}

function generatorPowerFitScore(product: Product, range: { min: number; max: number }) {
  const power = extractGeneratorPowerForHardSelection(product);
  const nominal = power.nominalKw ?? power.maxKw;
  if (nominal === undefined) return -10_000;

  const target = (range.min + range.max) / 2;
  const distance = nominal < range.min
    ? range.min - nominal
    : nominal > range.max
      ? nominal - range.max
      : 0;
  let score = 100 - Math.abs(nominal - target);
  if (nominal >= range.min && nominal <= range.max) score += 50;
  if (power.maxKw !== undefined && nominal < range.min && power.maxKw >= range.min) score += 25;
  score -= distance * 12;
  if (nominal > range.max * 3 && nominal > range.max + 20) score -= 10_000;
  return score;
}

function isSelfLoadingPlateText(text: string) {
  return /(?:self[-\s]?loading|load(?:ing)?\s+(?:it\s+)?myself|one[-\s]?person|\u0433\u0440\u0443\u0437\w{0,16}[^.!?\n]{0,35}\u0441\u0430\u043c|\u0441\u0430\u043c[^.!?\n]{0,35}\u0433\u0440\u0443\u0437|\u0432\s+\u043e\u0434\u043d\u043e\u0433\u043e|\u043e\u0434\u043d\u043e\u043c\u0443)/iu.test(text);
}

function isSmallPlateSiteText(text: string) {
  return /(?:small\s+(?:site|area|driveway)|driveway|paving|slabs?|sand|crushed\s+stone|garden|yard|\u043d\u0435\u0431\u043e\u043b\u044c\u0448\w{0,12}\s+\u043f\u043b\u043e\u0449\u0430\u0434|\u0432\u044a\u0435\u0437\u0434|\u043f\u043b\u0438\u0442\u043a|\u043f\u0435\u0441\u043e\u043a|\u0449\u0435\u0431|\u0434\u0432\u043e\u0440|\u0434\u043e\u0440\u043e\u0436)/iu.test(text);
}

function isHeavyPlateSiteText(text: string) {
  return /(?:reversible|heavy[-\s]?duty|industrial|road\s+base|parking|crew|\u0440\u0435\u0432\u0435\u0440\u0441\u0438\u0432|\u0442\u044f\u0436[^\s,.!?]*|\u0434\u043e\u0440\u043e\u0433|\u043f\u0430\u0440\u043a\u043e\u0432|\u043a\u0430\u0442\u043e\u043a|\u0431\u0440\u0438\u0433\u0430\u0434|\u043e\u0431\u044a\u0435\u043a\u0442)/iu.test(text);
}

function requestedPlateWeightRangeKg(input: {
  userMessage: string;
  query: string;
  semanticContext: string;
}) {
  const userExplicit = parseWeightNeedRangeKg(input.userMessage);
  if (userExplicit) return { ...userExplicit, source: 'explicit_user' as const };

  const joined = [input.userMessage, input.query, input.semanticContext].join('\n');
  if (isSelfLoadingPlateText(joined)) return { min: 40, max: 75, source: 'self_loading' as const };
  if (isSmallPlateSiteText(joined) && !isHeavyPlateSiteText(joined)) return { min: 45, max: 95, source: 'small_site' as const };

  const plannerExplicit = parseWeightNeedRangeKg(input.query) ?? parseWeightNeedRangeKg(input.semanticContext);
  return plannerExplicit ? { ...plannerExplicit, source: 'planner' as const } : undefined;
}

function plateWeightFitScore(product: Product, range: { min: number; max: number; source: string }) {
  const weight = extractWeightKg(product);
  if (weight === undefined) return range.source === 'self_loading' ? -25 : 0;

  const target = range.source === 'self_loading'
    ? Math.min(62, Math.max(range.min, (range.min + range.max) / 2))
    : (range.min + range.max) / 2;
  let score = 120 - Math.abs(weight - target);
  if (weight >= range.min && weight <= range.max) score += 80;
  if (weight < range.min) score -= (range.min - weight) * 2;
  if (weight > range.max) score -= (weight - range.max) * (range.source === 'self_loading' ? 10 : 5);
  if (range.source === 'self_loading' && weight > 90) score -= 300;
  if (range.source === 'self_loading' && weight > 120) score -= 1_000;
  return score;
}

export function rankCatalogProductsByNumericFit(input: {
  products: Product[];
  intent: ProductSelectionClass;
  query: string;
  semanticContext: string;
  userMessage: string;
}) {
  if (input.intent === 'plate') {
    const range = requestedPlateWeightRangeKg(input);
    if (!range) return input.products;
    return input.products
      .map((product, index) => ({
        product,
        index,
        score: plateWeightFitScore(product, range)
      }))
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map((item) => item.product);
  }
  if (input.intent !== 'generator' && input.intent !== 'weldingGenerator') return input.products;
  const range = requestedPowerRangeKw(input.query) ?? requestedPowerRangeKw(input.semanticContext);
  if (!range) return input.products;
  return input.products
    .map((product, index) => ({
      product,
      index,
      score: generatorPowerFitScore(product, range)
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.product);
}

export function selectProductsForVisibleCards(input: {
  products: Product[];
  userMessage: string;
  history: Message[];
  intent: AgentIntentContract;
  answerText: string;
  needState: CustomerNeedState;
}) {
  const unique = uniqueProducts(input.products);
  const hasExplicitCardTool = input.intent.toolRequests.some((request) =>
    request.tool === 'catalog.search' || request.tool === 'catalog.getProductDetails'
  );
  const cardIntent = inferVisibleCardIntent(input);
  if (!hasExplicitCardTool) {
    return {
      intent: cardIntent,
      products: [],
      selectedProductIds: [],
      answerMentionedProductIds: [],
      droppedProductIds: unique.map((product) => product.id),
      warnings: unique.length ? ['product_cards_suppressed:no_explicit_catalog_card_tool'] : []
    };
  }
  const mentioned = answerMentionedProducts(unique, input.answerText);
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

type VisibleCardSelection = ReturnType<typeof selectProductsForVisibleCards>;

export type VisibleCardReadiness = {
  status: 'ready_for_cards' | 'needs_load_profile';
  productClass: ProductSelectionClass;
  missingFacts: string[];
  rationale: string;
  warnings: string[];
};

function isGeneratorClass(value: ProductSelectionClass) {
  return value === 'generator' || value === 'weldingGenerator';
}

function generatorLoadProfileReady(toolResults: ToolResult[]) {
  return toolResults.some((result) => {
    if (result.tool !== 'calculator.generatorLoad' || result.status !== 'ok') return false;
    const profile = (result.payload as { profile?: { requiredNominalKw?: unknown; requiredStartingKw?: unknown } }).profile;
    return Number(profile?.requiredNominalKw) > 0 || Number(profile?.requiredStartingKw) > 0;
  });
}

function activeFactValue(ledgerState: ReducedDialogueLedgerState, factKey: string) {
  const fact = ledgerState.factsByKey[factKey];
  return fact?.status === 'active' ? fact.value : undefined;
}

function factIsTrue(value: unknown) {
  return value === true || value === 'true' || value === 'yes' || value === 'да';
}

function hasGeneratorLoadUncertaintyText(text: string) {
  return /(?:насос|холодильник|болгарк|инструмент|свет|led|пуск|нагруз|потребител|точн\w*\s+цифр\w*\s+нет|мощност\w*\s+не\s+зна|pump|fridge|refrigerator|tool|startup|starting|load)/iu.test(text);
}

function mentionsPump(text: string) {
  return /(?:\u043d\u0430\u0441\u043e\u0441|\u0441\u043a\u0432\u0430\u0436\u0438\u043d|\u043f\u043e\u0433\u0440\u0443\u0436\u043d|\u043f\u043e\u0432\u0435\u0440\u0445\u043d\u043e\u0441\u0442\u043d|pump|well pump|submersible)/iu.test(text);
}

function hasTypedPumpSignal(text: string) {
  return /(?:\u0441\u043a\u0432\u0430\u0436\u0438\u043d|\u043f\u043e\u0433\u0440\u0443\u0436\u043d|\u043f\u043e\u0432\u0435\u0440\u0445\u043d\u043e\u0441\u0442\u043d|\u0446\u0438\u0440\u043a\u0443\u043b\u044f\u0446|\u0434\u0440\u0435\u043d\u0430\u0436\u043d|\u043d\u0430\u0441\u043e\u0441\u043d\w*\s+\u0441\u0442\u0430\u043d\u0446|well pump|submersible|surface pump|circulation pump|\u043d\u0430\u0441\u043e\u0441.{0,80}\d+(?:[,.]\d+)?\s*(?:\u043a\u0412\u0442|kw|\u0412\u0442|W))/iu.test(text);
}

function hasGenericUnknownPumpSignal(text: string) {
  return mentionsPump(text) &&
    !hasTypedPumpSignal(text) &&
    /(?:\u043d\u0430\u0441\u043e\u0441.{0,80}(?:\u043d\u0435\s+\u0437\u043d\u0430|\u043d\u0435\s+\u0441\u043a\u0430\u0436\u0443|\u043a\u0430\u043a\u043e\u0439|\u043c\u043e\u0434\u0435\u043b\u044c|\u0431\u0435\u0437\s+\u043c\u043e\u0434\u0435\u043b|\u043d\u0435\u0438\u0437\u0432\u0435\u0441\u0442)|(?:\u043d\u0435\s+\u0437\u043d\u0430|\u043d\u0435\s+\u0441\u043a\u0430\u0436\u0443).{0,80}\u043d\u0430\u0441\u043e\u0441|unknown.{0,80}pump|pump.{0,80}unknown)/iu.test(text);
}

export function answerAsksPumpDetails(text: string, answer: AnswerContract) {
  const questionText = answer.questionsAsked.map((question) => `${question.questionId} ${question.text}`).join('\n');
  const combined = [text, questionText].join('\n');
  return /(?:уточн|скаж|напиш|пришл|посмотр|какой|тип|модель|мощност|шильдик).{0,90}насос|насос.{0,90}(?:уточн|скаж|напиш|пришл|посмотр|какой|тип|модель|мощност|шильдик|\?)/iu.test(combined);
}

export function appendGeneratorPumpQuestion(text: string) {
  const question = ' Уточните, пожалуйста, тип/модель или мощность насоса с шильдика - без этого подбор конкретной модели генератора будет только предварительным.';
  return /тип\/модель|мощност\w*\s+насос|насос.{0,80}шильдик/iu.test(text)
    ? text
    : `${text.trim()}${question}`;
}

function hasExplicitPowerTarget(text: string) {
  return Boolean(requestedPowerRangeKw(text));
}

function hasGeneratorUncertaintyRisk(input: {
  intent: AgentIntentContract;
  answer: AnswerContract;
  ledgerState: ReducedDialogueLedgerState;
  semanticText: string;
}) {
  const riskText = [
    ...input.intent.riskFlags,
    ...input.answer.riskFlags,
    ...Object.entries(input.ledgerState.factsByKey).map(([key, fact]) => `${key}:${String(fact.value)}`)
  ].join('\n');
  if (/power.*uncertain|uncertain.*power|unknown.*pump|pump.*unknown|needs.*load|load.*calculat|load_profile|power_uncertainty|мощност\w*.{0,40}(неизвест|не\s+зна|нет\s+точн)|насос.{0,40}(неизвест|не\s+зна|модель)|пуск\w*.{0,40}(неизвест|не\s+зна)/iu.test(riskText)) {
    return true;
  }
  if (factIsTrue(activeFactValue(input.ledgerState, 'power_uncertainty'))) return true;
  return hasGeneratorLoadUncertaintyText(input.semanticText) && !hasExplicitPowerTarget(input.semanticText);
}

export function assessVisibleCardReadiness(input: {
  cardSelection: VisibleCardSelection;
  userMessage: string;
  intent: AgentIntentContract;
  answer: AnswerContract;
  ledgerState: ReducedDialogueLedgerState;
  toolResults: ToolResult[];
}): VisibleCardReadiness {
  const productClass = input.cardSelection.intent;
  if (!isGeneratorClass(productClass)) {
    return {
      status: 'ready_for_cards',
      productClass,
      missingFacts: [],
      rationale: 'Visible card readiness is not constrained by generator load sizing.',
      warnings: []
    };
  }

  const semanticText = [
    input.userMessage,
    input.intent.userMessageSummary,
    input.intent.dialogueUnderstanding,
    input.intent.nextStepRationale,
    toolRequestSemanticText(input.intent)
  ].filter(Boolean).join('\n');
  if (hasGenericUnknownPumpSignal(semanticText)) {
    return {
      status: 'needs_load_profile',
      productClass,
      missingFacts: ['pump_type_or_power', 'starting_loads_or_load_profile'],
      rationale: 'The buyer mentioned a pump but did not know its type/model/power, so generator cards remain unsafe.',
      warnings: ['product_cards_suppressed:generic_pump_unknown']
    };
  }

  if (generatorLoadProfileReady(input.toolResults)) {
    return {
      status: 'ready_for_cards',
      productClass,
      missingFacts: [],
      rationale: 'A generator load profile is available from calculator.generatorLoad.',
      warnings: []
    };
  }

  if (!hasGeneratorUncertaintyRisk({
    intent: input.intent,
    answer: input.answer,
    ledgerState: input.ledgerState,
    semanticText
  })) {
    return {
      status: 'ready_for_cards',
      productClass,
      missingFacts: [],
      rationale: 'No generator load uncertainty signal is active for this turn.',
      warnings: []
    };
  }

  return {
    status: 'needs_load_profile',
    productClass,
    missingFacts: ['pump_type_or_power', 'starting_loads_or_load_profile'],
    rationale: 'Generator cards require a usable load profile when pump/startup power is uncertain.',
    warnings: ['product_cards_suppressed:generator_load_profile_not_ready']
  };
}

export function suppressVisibleCardsForReadiness(input: {
  cardSelection: VisibleCardSelection;
  readiness: VisibleCardReadiness;
}): VisibleCardSelection & { selectionReadiness: VisibleCardReadiness; suppressedProductIds: string[] } {
  if (input.readiness.status === 'ready_for_cards') {
    return {
      ...input.cardSelection,
      selectionReadiness: input.readiness,
      suppressedProductIds: []
    };
  }

  const suppressedProductIds = uniqueStrings([
    ...input.cardSelection.selectedProductIds,
    ...input.cardSelection.products.map((product) => product.id)
  ]);

  return {
    ...input.cardSelection,
    products: [],
    selectedProductIds: [],
    droppedProductIds: uniqueStrings([
      ...input.cardSelection.droppedProductIds,
      ...suppressedProductIds
    ]),
    warnings: uniqueStrings([
      ...input.cardSelection.warnings,
      ...input.readiness.warnings
    ]),
    selectionReadiness: input.readiness,
    suppressedProductIds
  };
}

export function generatorLoadReadinessAnswer() {
  return [
    'Для точного подбора генератора сейчас не хватает главного: какой насос и какая у него мощность или пусковой ток.',
    'Холодильник и насос дают кратковременные пусковые нагрузки, поэтому конкретную модель лучше не выбирать вслепую.',
    'Пришлите модель насоса или мощность с шильдика. Если посмотреть нельзя, я посчитаю по типовым значениям и дам предварительный диапазон с запасом.'
  ].join(' ');
}
