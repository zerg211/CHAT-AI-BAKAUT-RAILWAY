import type { Product, ProductSelectionClass, ProductSelectionState, CustomerNeedState, GeneratorPowerProfile, ProductFitProfile } from '../shared/types.js';

export type ProductIntent = ProductSelectionClass;

export const fromEscaped = (value: string) => JSON.parse(`"${value}"`) as string;
export const weightRegex = new RegExp(String.raw`(\d{2,4})\s*(?:\u043a\u0433|kg)`, 'i');
export const powerRegex = new RegExp(String.raw`(\d+(?:[,.]\d+)?)\s*(?:\u043a\u0432\u0442|kw|kva|\u043a\u0432\u0430)`, 'i');
export const powerRangeRegex = new RegExp(String.raw`(\d+(?:[,.]\d+)?)\s*(?:-|–|—|\u0434\u043e)\s*(\d+(?:[,.]\d+)?)\s*(?:\u043a\u0432\u0442|kw|kva|\u043a\u0432\u0430)`, 'i');
export const budgetMaxRegex = new RegExp(String.raw`(?:\u0434\u043e|\u0437\u0430|\u0432\s+\u043f\u0440\u0435\u0434\u0435\u043b\u0430\u0445|\u0432\s+\u0440\u0430\u043c\u043a\u0430\u0445|\u043d\u0435\s+\u0434\u043e\u0440\u043e\u0436\u0435|budget\s*(?:up\s*to)?|max|maximum|<=?)\s*(\d+(?:[,.]\d+)?)\s*(?:\u0442\u044b\u0441(?:\u044f\u0447)?|\u0442\.?\s*\u0440\.?|\u0440\u0443\u0431|rub|₽)?`, 'i');
export const plateTerms = ['vibroplity', 'vibroplita', 'виброплит', fromEscaped('\\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442')];
export const generatorTerms = ['generator', 'generatory', 'генерат', 'электростанц', fromEscaped('\\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442'), fromEscaped('\\u044d\\u043b\\u0435\\u043a\\u0442\\u0440\\u043e\\u0441\\u0442\\u0430\\u043d\\u0446')];
export const rammerTerms = ['rammer', 'трамбовк', 'виброног', fromEscaped('\\u0442\\u0440\\u0430\\u043c\\u0431\\u043e\\u0432\\u043a'), fromEscaped('\\u0432\\u0438\\u0431\\u0440\\u043e\\u043d\\u043e\\u0433')];
export const cutterTerms = ['cutter', 'резчик', 'швонарез', fromEscaped('\\u0440\\u0435\\u0437\\u0447\\u0438\\u043a'), fromEscaped('\\u0448\\u0432\\u043e\\u043d\\u0430\\u0440\\u0435\\u0437')];
export const diamondBladeTerms = [
  'diamond blade',
  'almaz',
  fromEscaped('\\u0430\\u043b\\u043c\\u0430\\u0437'),
  fromEscaped('\\u0434\\u0438\\u0441\\u043a'),
  fromEscaped('\\u043a\\u0440\\u0443\\u0433'),
  fromEscaped('\\u043a\\u0435\\u0440\\u0430\\u043c\\u043e\\u0433\\u0440\\u0430\\u043d\\u0438\\u0442'),
  fromEscaped('\\u043a\\u0435\\u0440\\u0430\\u043c\\u0438\\u043a'),
  fromEscaped('\\u043f\\u043b\\u0438\\u0442\\u043a\\u043e\\u0440\\u0435\\u0437')
];
export const weightTerms = [
  fromEscaped('\\u0432\\u0435\\u0441'),
  fromEscaped('\\u043f\\u0435\\u0440\\u0435\\u043d\\u043e\\u0441'),
  fromEscaped('\\u043f\\u0435\\u0440\\u0435\\u0432\\u043e\\u0437'),
  fromEscaped('\\u0442\\u0440\\u0430\\u043d\\u0441\\u043f\\u043e\\u0440\\u0442'),
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
export const wheelTransportTerms = [
  fromEscaped('\\u043a\\u043e\\u043b\\u0435\\u0441'),
  fromEscaped('\\u0442\\u0435\\u043b\\u0435\\u0436'),
  fromEscaped('\\u0442\\u0440\\u0430\\u043d\\u0441\\u043f\\u043e\\u0440\\u0442'),
  fromEscaped('\\u043f\\u0435\\u0440\\u0435\\u0432\\u043e\\u0437'),
  'wheel',
  'transport'
];
export const homeTerms = [
  fromEscaped('\\u0434\\u0430\\u0447'),
  fromEscaped('\\u0431\\u044b\\u0442\\u043e\\u0432'),
  fromEscaped('\\u0443\\u0447\\u0430\\u0441\\u0442')
];
export const inverterTerms = ['invertor', 'inverter', fromEscaped('\\u0438\\u043d\\u0432\\u0435\\u0440\\u0442\\u043e\\u0440')];
export const dieselTerms = ['diesel', 'dizel', 'дизел', fromEscaped('\\u0434\\u0438\\u0437\\u0435\\u043b')];
export const gasolineTerms = ['benzin', 'бензин', fromEscaped('\\u0431\\u0435\\u043d\\u0437\\u0438\\u043d')];
export const professionalTerms = [
  fromEscaped('\\u043f\\u0440\\u043e\\u0444'),
  fromEscaped('\\u043f\\u0440\\u043e\\u043c\\u044b\\u0448\\u043b'),
  fromEscaped('\\u0440\\u0435\\u0432\\u0435\\u0440\\u0441'),
  'wacker',
  'husqvarna',
  'bomag',
  'ammann'
];
export const coldStartTerms = [
  'электростарт',
  'стартер',
  fromEscaped('\\u044d\\u043b\\u0435\\u043a\\u0442\\u0440\\u043e\\u0441\\u0442\\u0430\\u0440\\u0442'),
  fromEscaped('\\u0441\\u0442\\u0430\\u0440\\u0442\\u0435\\u0440'),
  fromEscaped('\\u043f\\u043e\\u0434\\u043e\\u0433\\u0440\\u0435\\u0432'),
  fromEscaped('\\u0437\\u0438\\u043c'),
  fromEscaped('\\u043c\\u043e\\u0440\\u043e\\u0437')
];
export const quietTerms = [
  fromEscaped('\\u0442\\u0438\\u0445'),
  fromEscaped('\\u0448\\u0443\\u043c\\u043e\\u0438\\u0437\\u043e\\u043b'),
  fromEscaped('\\u043a\\u043e\\u0436\\u0443\\u0445'),
  fromEscaped('\\u0437\\u0430\\u043a\\u0440\\u044b\\u0442')
];
export const accessoryTerms = [
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
export const accessoryNeedTerms = [
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
export const trowelTerms = ['затироч', fromEscaped('\\u0437\\u0430\\u0442\\u0438\\u0440\\u043e\\u0447')];
export const weldingTerms = ['свароч', fromEscaped('\\u0441\\u0432\\u0430\\u0440\\u043e\\u0447'), 'welding'];
export const oilTerms = ['масло', 'oil', 'sae', '10w', '5w', fromEscaped('\\u043c\\u0430\\u0441\\u043b')];
export const diamondCoreTerms = ['коронк', 'almaznye_koronki', 'core drill', 'подрозет', 'бурен', 'сверлен', fromEscaped('\\u043a\\u043e\\u0440\\u043e\\u043d\\u043a')];
export const rollerTerms = ['виброкат', 'каток', 'roller', fromEscaped('\\u0432\\u0438\\u0431\\u0440\\u043e\\u043a\\u0430\\u0442'), fromEscaped('\\u043a\\u0430\\u0442\\u043e\\u043a')];
export const singlePhaseTerms = ['220', '230', 'однофаз', 'одной фаз', fromEscaped('\\u043e\\u0434\\u043d\\u043e\\u0444\\u0430\\u0437'), fromEscaped('\\u043e\\u0434\\u043d\\u043e\\u0439 \\u0444\\u0430\\u0437')];

export const fourStrokeOilTerms = [
  '4t',
  '4-t',
  '4 takt',
  'sae',
  '10w',
  '15w',
  fromEscaped('\\u0447\\u0435\\u0442\\u044b\\u0440\\u0435\\u0445\\u0442\\u0430\\u043a\\u0442'),
  fromEscaped('\\u043c\\u043e\\u0442\\u043e\\u0440\\u043d')
];
export const incompatibleOilTerms = [
  '2t',
  '2-t',
  fromEscaped('\\u0434\\u0432\\u0443\\u0445\\u0442\\u0430\\u043a\\u0442'),
  fromEscaped('\\u0432\\u043e\\u0437\\u0434\\u0443\\u0448\\u043d\\u044b\\u0439 \\u0444\\u0438\\u043b\\u044c\\u0442\\u0440'),
  fromEscaped('\\u043c\\u0430\\u0441\\u043b\\u043e \\u0434\\u043b\\u044f \\u0444\\u0438\\u043b\\u044c\\u0442\\u0440')
];
export const plateAccessoryTerms = [
  fromEscaped('\\u043a\\u043e\\u0432\\u0440\\u0438\\u043a'),
  fromEscaped('\\u043a\\u043e\\u0432\\u0435\\u0440'),
  fromEscaped('\\u043d\\u0430\\u043a\\u043b\\u0430\\u0434\\u043a'),
  fromEscaped('\\u043f\\u043e\\u043b\\u0438\\u0443\\u0440\\u0435\\u0442\\u0430\\u043d'),
  fromEscaped('\\u0432\\u0443\\u043b\\u043a\\u0430\\u043b\\u0430\\u043d')
];

// Product-card role guard terms. These classify catalogue items, not buyer intent.
// They exist to stop accessories/spares/consumables from being rendered as core
// machines when the LLM asks for a whole product class such as a виброплита.
export const spareAccessoryTerms = [
  'accessory',
  'spare',
  'spares',
  'parts',
  'filter',
  'belt',
  fromEscaped('\\u0437\\u0430\\u043f\\u0447\\u0430\\u0441\\u0442'),
  fromEscaped('\\u0440\\u0430\\u0441\\u0445\\u043e\\u0434\\u043d\\u0438\\u043a'),
  fromEscaped('\\u0444\\u0438\\u043b\\u044c\\u0442\\u0440'),
  fromEscaped('\\u0440\\u0435\\u043c\\u0435\\u043d'),
  fromEscaped('\\u0440\\u0435\\u043c\\u0435\\u043d\\u044c'),
  fromEscaped('\\u043c\\u0430\\u0441\\u043b'),
  fromEscaped('\\u043f\\u043e\\u0434\\u043e\\u0433\\u0440\\u0435\\u0432'),
  fromEscaped('\\u0431\\u0430\\u043a'),
  fromEscaped('\\u043a\\u0440\\u044b\\u0448\\u043a'),
  fromEscaped('\\u0441\\u0432\\u0435\\u0447'),
  fromEscaped('\\u043a\\u0430\\u0440\\u0431\\u044e\\u0440\\u0430\\u0442'),
  fromEscaped('\\u043a\\u043e\\u0432\\u0440\\u0438\\u043a'),
  fromEscaped('\\u043a\\u043e\\u0432\\u0435\\u0440'),
  fromEscaped('\\u043d\\u0430\\u043a\\u043b\\u0430\\u0434\\u043a'),
  fromEscaped('\\u043a\\u043e\\u043c\\u043f\\u043b\\u0435\\u043a\\u0442'),
  fromEscaped('\\u0430\\u0432\\u0440')
];


export function containsAny(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function hasAccessoryCategorySignal(category: string) {
  return /(?:запчаст|расходник|аксессуар|комплектующ|сервис|масл|кожух|фильтр|ремн|ремен|свеч|карбюратор)/iu.test(category);
}

function startsWithAnyWord(text: string, words: string[]) {
  const source = text.trim().toLowerCase();
  return words.some((word) => new RegExp(`^${word}(?:\\b|\\s|$)`, 'iu').test(source));
}

function hasCoreMachineTitleSignal(title: string) {
  return startsWithAnyWord(title, [
    'виброплита',
    'генератор',
    'электростанция',
    'бензорез',
    'резчик',
    'швонарезчик',
    'вибротрамбовка',
    'трамбовка',
    'виброкаток',
    'каток',
    'затирочная',
    'затирочная машина'
  ]) || /^(?:vibroplita|generator|cutter|rammer|roller|trowel)\b/i.test(title.trim());
}

function hasAccessoryTitleForm(title: string) {
  const normalized = title.trim().toLowerCase();
  if (/(?:\b|^)(?:фильтр|ремень|свеча|карбюратор|коврик|ковер|накладка|кожух|бак|крышка|подогрев|амортизатор|система\s+смачивания)\b/iu.test(normalized)) {
    return true;
  }
  if (/^(?:комплект\s+(?:сервис|обслуживан|расходник|запчаст)|блок\s+авр|авр\s+для)\b/iu.test(normalized)) {
    return true;
  }
  return /(?:для\s+(?:виброплит|генератор|бензорез|резчик|швонарез|трамбовк|двигател))/iu.test(normalized) &&
    /(?:фильтр|ремень|свеч|карбюратор|коврик|кожух|бак|крышк|подогрев|накладк|комплект|авр|амортизатор)/iu.test(normalized);
}

function hasCoreMachineCategorySignal(category: string) {
  return !hasAccessoryCategorySignal(category) && (
    containsAny(category, plateTerms) ||
    containsAny(category, generatorTerms) ||
    containsAny(category, rammerTerms) ||
    containsAny(category, cutterTerms) ||
    containsAny(category, rollerTerms) ||
    containsAny(category, trowelTerms)
  );
}

export function oilViscosities(text: string) {
  return [...text.toLowerCase().matchAll(/\b\d{1,2}w-?\d{2}\b/g)]
    .map((match) => match[0].replace('-', ''));
}

export function hasOilProductSignal(text: string) {
  return containsAny(text, ['РјР°СЃР»Рѕ', 'oil', 'sae', fromEscaped('\\u043c\\u0430\\u0441\\u043b')]) || oilViscosities(text).length > 0;
}

export function requestedLiters(text: string) {
  const match = text.toLowerCase().match(/(\d+(?:[,.]\d+)?)\s*(?:л|l|литр)/i);
  if (!match) return undefined;
  const liters = Number(match[1].replace(',', '.'));
  return Number.isFinite(liters) && liters > 0 ? liters : undefined;
}

export function productLiters(product: Product) {
  return requestedLiters([product.name, product.category, product.description, JSON.stringify(product.specs ?? {})].join(' '));
}

export function parseLoosePositiveNumber(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined;
  const match = String(value ?? '').replace(/\s+/g, ' ').match(/(\d+(?:[,.]\d+)?)/);
  if (!match) return undefined;
  const parsed = Number(match[1].replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function extractWeightKg(product: Product) {
  for (const [key, value] of Object.entries(product.specs ?? {})) {
    if (!/(?:\u043c\u0430\u0441\u0441|\u0432\u0435\u0441|weight)/iu.test(key)) continue;
    const parsed = parseLoosePositiveNumber(value);
    if (parsed !== undefined) return parsed;
  }
  const text = [
    product.name,
    product.description,
    JSON.stringify(product.specs ?? {})
  ].join(' ');
  const match = text.match(weightRegex);
  return match ? Number(match[1]) : undefined;
}

export function extractDimensionMm(product: Product) {
  for (const [key, value] of Object.entries(product.specs ?? {})) {
    if (!/(?:\u0434\u0438\u0430\u043c\u0435\u0442\u0440|diameter|\u0434\u0438\u0441\u043a|\u043a\u0440\u0443\u0433|\u043a\u043e\u0440\u043e\u043d\u043a|\u0433\u043b\u0443\u0431\u0438\u043d|\u0434\u043b\u0438\u043d)/iu.test(key)) continue;
    const parsed = parseLoosePositiveNumber(value);
    if (parsed !== undefined && parsed >= 10 && parsed <= 2500) return parsed;
  }
  const text = [
    product.name,
    product.description,
    JSON.stringify(product.specs ?? {})
  ].join(' ');
  const diameter = text.match(/(?:\u0434\u0438\u0430\u043c\u0435\u0442\u0440|diameter|[dD]\s*=?)\D{0,20}(\d{2,4})\s*(?:\u043c\u043c|mm)\b/iu);
  if (diameter) return Number(diameter[1]);
  const nearUnit = text.match(/\b(\d{2,4})\s*(?:\u043c\u043c|mm)\b/iu);
  return nearUnit ? Number(nearUnit[1]) : undefined;
}

export function extractPowerKw(product: Product) {
  const text = [
    product.name,
    product.description,
    JSON.stringify(product.specs ?? {})
  ].join(' ');
  const match = text.match(powerRegex);
  return match ? Number(match[1].replace(',', '.')) : undefined;
}

export function extractNamePowerKw(product: Product) {
  const match = String(product.name ?? '').match(powerRegex);
  return match ? Number(match[1].replace(',', '.')) : undefined;
}

export function normalizePowerValue(value: string) {
  const number = Number(value.replace(',', '.'));
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

export function extractPowerNearKeywords(text: string, keywords: string[]) {
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

export function extractGeneratorPower(product: Product) {
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

export function numberNearNeed(text: string, need: RegExp) {
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

export function compactModelText(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export function normalizeBrandKey(value?: string | null) {
  return compactModelText(String(value ?? ''))
    .replace(/^ооо/, '')
    .replace(/^тм/, '');
}

function compactTextTokens(value: string) {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/gu)
    .map((token) => compactModelText(token))
    .filter(Boolean);
}

function brandKeyMentionedInText(brandKey: string, text: string) {
  const tokens = compactTextTokens(text);
  if (tokens.includes(brandKey)) return true;
  if (brandKey.length <= 3) return false;
  return compactModelText(text).includes(brandKey);
}

export function requestedBrandKeysFromProducts(products: Product[], text: string) {
  const brands = new Set<string>();
  for (const product of products) {
    const key = normalizeBrandKey(product.brand);
    if (key.length >= 3 && brandKeyMentionedInText(key, text)) brands.add(key);
  }
  return brands;
}

export function productMatchesRequestedBrand(product: Product, requestedBrands: Set<string>) {
  if (!requestedBrands.size) return true;
  const productText = [product.brand, product.name].filter(Boolean).join(' ');
  return [...requestedBrands].some((brand) => brandKeyMentionedInText(brand, productText));
}

export function productMatchesIntent(product: Product, intent: ProductIntent) {
  if (intent === 'unknown') return true;
  const flags = classifyProduct(product);
  switch (intent) {
    case 'generator':
      return flags.isGenerator;
    case 'weldingGenerator':
      return flags.isWeldingGenerator;
    case 'generatorOil':
      return flags.isGeneratorOil;
    case 'engineOil':
      return flags.isEngineOil;
    case 'generatorAccessory':
      return flags.isGeneratorAccessory;
    case 'plateAccessory':
      return flags.isPlateAccessory;
    case 'plate':
      return flags.isPlate;
    case 'rammer':
      return flags.isRammer;
    case 'roller':
      return flags.isRoller;
    case 'cutter':
      return flags.isCutter;
    case 'diamondBlade':
      return flags.isDiamondBlade;
    case 'diamondCore':
      return flags.isDiamondCore;
    case 'trowel':
      return flags.isTrowel;
    default:
      return true;
  }
}

export function extractGeneratorPowerForHardSelection(product: Product) {
  const displayedNominal = extractNamePowerKw(product);
  const power = extractGeneratorPower(product);
  return {
    nominalKw: displayedNominal ?? power.nominalKw,
    maxKw: power.maxKw
  };
}

export function isTechnicalSpecToken(token: string) {
  const normalized = token.trim().toLowerCase().replace(/\s+/g, '');
  const compact = compactModelText(token);
  if (!compact) return true;
  if (/^\d+(?:[,.]\d+)?(?:-|–|—|\/|\u0434\u043e|to)\d+(?:[,.]\d+)?(?:kg|\u043a\u0433|kw|\u043a\u0432\u0442|kva|\u043a\u0432\u0430|mm|\u043c\u043c|cm|\u0441\u043c|v|\u0432|w|\u0432\u0442)?$/iu.test(normalized)) return true;
  if (/^(?:under|over|upto|to|до|от|около|about|around|max|maximum|min|minimum)\d{1,7}$/iu.test(compact)) return true;
  if (/^(?:for|to|under|with|для|под|с)\s*\d{1,4}$/iu.test(token.trim())) return true;
  if (/^(?:plate|generator|cutter|core|blade|vibroplate|виброплит[аы]?|генератор|диск|коронка|резчик)\s*\d{1,4}$/iu.test(token.trim())) return true;
  if (/\b(?:generator|генератор|электростанц)\b.*?\d{2,4}\s*[vв]\b/iu.test(token)) return true;
  if (/^(?:\d{2,4}[vв]|[vв]\d{2,4})(?:[-/](?:\d{2,4}[vв]|[vв]\d{2,4}))*$/iu.test(normalized)) return true;
  if (/^(?:[vв]?\d{2,4}[vв]?){1,2}$/iu.test(compact) && /[vв]/iu.test(compact)) return true;
  if (/^\d+(?:kw|квт|kva|ква)$/iu.test(normalized)) return true;
  if (/^\d+(?:kg|кг|mm|мм)$/iu.test(normalized)) return true;
  if (/^(?:kw|kva|w|v)\d{1,4}$/iu.test(normalized)) return true;
  return false;
}

export function isLikelyModelToken(token: string) {
  const compact = compactModelText(token);
  if (compact.length < 4) return false;
  if (isTechnicalSpecToken(token)) return false;
  return /\d/u.test(compact) && /\p{L}/u.test(compact);
}

export function extractModelTokens(value: string) {
  const dashed = value.match(/[\p{L}\p{N}]+(?:[-/][\p{L}\p{N}]+)+/gu) ?? [];
  const compact = value.match(/\b(?=[\p{L}\p{N}]*\d)(?=[\p{L}\p{N}]*\p{L})[\p{L}\p{N}]{6,}\b/gu) ?? [];
  const shortModel = value.match(/\b(?=[\p{L}\p{N}\s\/-]{4,12}\b)(?=[\p{L}\p{N}\s\/-]*\d{2,})(?=[\p{L}\p{N}\s\/-]*\p{L})\p{L}{1,4}\s*[-/]?\s*\d{2,4}[\p{L}\p{N}]{0,3}\b/gu) ?? [];
  const spaced = value.match(/\b[\p{L}]{2,}\s+\d{3,}[\p{L}\p{N}]*\b/gu) ?? [];
  return [...new Set([...dashed, ...compact, ...shortModel, ...spaced].filter(isLikelyModelToken))];
}

export function expandModelTokenAliases(tokens: string[]) {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    const compact = compactModelText(token);
    const lat = compact.match(/^lat(\d{2,4})$/i);
    if (lat) {
      expanded.add(`LF ${lat[1]} LAT`);
      expanded.add(`LF ${lat[1]}`);
    }
    const lf = compact.match(/^lf(\d{2,4})lat?$/i) ?? compact.match(/^lf(\d{2,4})$/i);
    if (lf) {
      expanded.add(`LAT ${lf[1]}`);
      expanded.add(`LF ${lf[1]} LAT`);
    }
  }
  return [...expanded];
}

export function parseSingleWeightTargetKg(text: string) {
  const normalized = text.replace(/\s+/g, ' ');
  if (/(\d{2,4})\s*(?:[-\u2010-\u2015]|\u0434\u043e)\s*(\d{2,4})\s*(?:\u043a\u0433|kg)/iu.test(normalized)) return undefined;
  if (/(?:\u0434\u043e|\u043d\u0435\s+\u0442\u044f\u0436\u0435\u043b\u0435\u0435|\u043c\u0430\u043a\u0441(?:\u0438\u043c\u0443\u043c)?|up\s+to|max(?:imum)?)\s*(\d{2,4})\s*(?:\u043a\u0433|kg)/iu.test(normalized)) return undefined;
  if (/(?:\u043e\u0442|\u043d\u0435\s+\u043b\u0435\u0433\u0447\u0435|\u043c\u0438\u043d(?:\u0438\u043c\u0443\u043c)?|from|min(?:imum)?)\s*(\d{2,4})\s*(?:\u043a\u0433|kg)/iu.test(normalized)) return undefined;
  const single = normalized.match(/(?:\u043e\u043a\u043e\u043b\u043e|\u043f\u0440\u0438\u043c\u0435\u0440\u043d\u043e|\u043f\u043e\u0440\u044f\u0434\u043a\u0430|~|around|about)?\s*(\d{2,4})\s*(?:\u043a\u0433|kg)(?![\p{L}\p{N}])/iu);
  if (!single) return undefined;
  const value = Number(single[1]);
  return Number.isFinite(value) ? value : undefined;
}

function practicalSingleWeightToleranceKg(value: number) {
  if (value <= 120) return 10;
  if (value <= 250) return 20;
  if (value <= 500) return 50;
  if (value <= 700) return Math.round(value * 0.15);
  return Math.round(value * 0.2);
}

export function parseWeightNeedRangeKg(text: string) {
  const normalized = text.replace(/\s+/g, ' ');
  const range = normalized.match(/(\d{2,4})\s*(?:[-\u2010-\u2015]|\u0434\u043e)\s*(\d{2,4})\s*(?:\u043a\u0433|kg)/iu);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
    const toleranceMatch = normalized.match(/(?:±|\+\/-|\u043f\u043b\u044e\u0441\s*(?:-|\u2011|\u2012|\u2013|\u2014|\s)\s*\u043c\u0438\u043d\u0443\u0441)\s*(\d{1,3})\s*(?:\u043a\u0433|kg)?/iu);
    const tolerance = toleranceMatch ? Number(toleranceMatch[1]) : 0;
    return {
      min: Math.max(0, Math.min(a, b) - (Number.isFinite(tolerance) ? tolerance : 0)),
      max: Math.max(a, b) + (Number.isFinite(tolerance) ? tolerance : 0)
    };
  }
  const upperBound = normalized.match(/(?:\u0434\u043e|\u043d\u0435\s+\u0442\u044f\u0436\u0435\u043b\u0435\u0435|\u043c\u0430\u043a\u0441(?:\u0438\u043c\u0443\u043c)?|up\s+to|max(?:imum)?)\s*(\d{2,4})\s*(?:\u043a\u0433|kg)/iu);
  if (upperBound) {
    const max = Number(upperBound[1]);
    return Number.isFinite(max) ? { min: 0, max } : undefined;
  }
  const lowerBound = normalized.match(/(?:\u043e\u0442|\u043d\u0435\s+\u043b\u0435\u0433\u0447\u0435|\u043c\u0438\u043d(?:\u0438\u043c\u0443\u043c)?|from|min(?:imum)?)\s*(\d{2,4})\s*(?:\u043a\u0433|kg)/iu);
  if (lowerBound) {
    const min = Number(lowerBound[1]);
    if (!Number.isFinite(min)) return undefined;
    return { min, max: Math.round(min * 1.25) };
  }
  const value = parseSingleWeightTargetKg(normalized);
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return undefined;
  const tolerance = practicalSingleWeightToleranceKg(value);
  return { min: Math.max(0, value - tolerance), max: value + tolerance };
}

export function parseDimensionNeedRangeMm(text: string) {
  const normalized = text.replace(/\s+/g, ' ');
  const range = normalized.match(/(\d{2,4})\s*(?:-|вЂ“|вЂ”|\/|\u0438\u043b\u0438|\u0434\u043e)\s*(\d{2,4})\s*(?:\u043c\u043c|mm)\b/iu);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const single = normalized.match(/(?:\u0434\u0438\u0430\u043c\u0435\u0442\u0440|diameter|[dD]\s*=?)?\D{0,20}\b(\d{2,4})\s*(?:\u043c\u043c|mm)\b/iu);
  if (!single) return undefined;
  const value = Number(single[1]);
  if (!Number.isFinite(value)) return undefined;
  const tolerance = value <= 120 ? 2 : value <= 450 ? 5 : 15;
  return { min: Math.max(0, value - tolerance), max: value + tolerance };
}

export function isCatalogAvailabilityQuestion(text: string) {
  return /(?:\u0440\u0430\u0437\u0432\u0435|\u0435\u0441\u0442\u044c\s+\u043b\u0438|\u0435\u0441\u0442\u044c\s+[^?!.]{0,40}\s+\u0432\s+\u043a\u0430\u0442\u0430\u043b\u043e\u0433|\u0435\u0441\u0442\u044c\s+[^?!.]{0,50}\s+(?:\u0434\u043e|\u0437\u0430)\s*\d|\u043d\u0435\u0442\u0443\s+(?:\u043b\u0438\s+)?|\u043d\u0435\u0442\s+(?:\u043b\u0438\s+)?|\u0443\s+\u0432\u0430\u0441|\u0432\s+\u043d\u0430\u0448\u0435\u043c\s+\u043a\u0430\u0442\u0430\u043b\u043e\u0433\u0435)/iu.test(text);
}

export function isManufacturingStatusQuestion(text: string) {
  return /(?:\u0432\u044b\u043f\u0443\u0441\u043a|\u043f\u0440\u043e\u0438\u0437\u0432\u043e\u0434|\u0441\u043d\u044f(?:\u0442|\u043b)|\u0437\u0430\u0432\u043e\u0434|\u0442\u0435\u043a\u0443\u0449(?:\u0430\u044f|\u0435\u0439|\u0443\u044e)?\s+\u043b\u0438\u043d\u0435\u0439\u043a|current\s+lineup|discontinued|still\s+(?:made|produced))/iu.test(text);
}

function isExploratoryPowerRangeQuestion(text: string, match: RegExpMatchArray) {
  const start = match.index ?? 0;
  const end = start + match[0].length;
  const before = text.slice(Math.max(0, start - 80), start).toLowerCase();
  const after = text.slice(end, Math.min(text.length, end + 80)).toLowerCase();
  const sentenceTailAsQuestion = /(?:\?|или\s+нет|or\s+not|или\s+не\s+надо)/iu.test(after);
  if (!sentenceTailAsQuestion) return false;
  return /(?:надо\s+(?:ли\s+)?(?:переходить|перейти|подниматься|уходить)|нужно\s+(?:ли\s+)?(?:переходить|перейти|подниматься|уходить|брать|смотреть)|стоит\s+(?:ли\s+)?(?:переходить|перейти|брать|смотреть)|имеет\s+смысл\s+(?:переходить|перейти|брать|смотреть)|do\s+i\s+need\s+to\s+(?:switch|move)|should\s+i\s+(?:switch|move|take))/iu.test(before);
}

export function parseDesiredPowerRange(text: string) {
  const match = text.match(powerRangeRegex);
  if (!match) return undefined;
  if (isExploratoryPowerRangeQuestion(text, match)) return undefined;
  const a = Number(match[1].replace(',', '.'));
  const b = Number(match[2].replace(',', '.'));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

export function parseBudgetMax(text: string) {
  const matcher = new RegExp(budgetMaxRegex.source, 'giu');
  for (const match of text.matchAll(matcher)) {
    const value = Number(match[1].replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) continue;

    const index = match.index ?? 0;
    const end = index + match[0].length;
    const matchedText = match[0].toLowerCase();
    const before = text.slice(Math.max(0, index - 45), index).toLowerCase();
    const after = text.slice(end, Math.min(text.length, end + 30)).toLowerCase();
    if (/^\s*(?:\u043a\u0432\u0442|kw|kva|\u043a\u0432\u0430|\u0432\u0442|w|\u0432\u0430\u0442\u0442|\u043a\u0433|kg|\u043c\u043c|mm|\u0441\u043c|cm)(?=$|[\s,.;:!?)]|-)/iu.test(after)) continue;

    const local = `${before} ${matchedText} ${after}`;
    const hasMoneyContext = /(?:\u0431\u044e\u0434\u0436\u0435\u0442|\u0446\u0435\u043d|\u0441\u0442\u043e\u0438\u043c\u043e\u0441\u0442|\u0440\u0443\u0431|₽|\u0442\u044b\u0441|\u0442\.?\s*\u0440|rub|budget|price|cost|\u0437\u0430\s*\d|\u0432\s+\u043f\u0440\u0435\u0434\u0435\u043b\u0430\u0445\s*\d|\u0432\s+\u0440\u0430\u043c\u043a\u0430\u0445\s*\d|\u043d\u0435\s+\u0434\u043e\u0440\u043e\u0436\u0435\s*\d)/iu.test(local);
    if (!hasMoneyContext) continue;

    if (value < 1000 || /(?:тыс|т\.?\s*р)/iu.test(matchedText)) return Math.round(value * 1000);
    return Math.round(value);
  }
  return undefined;
}

export function hasBudgetSignal(text: string) {
  return /(?:бюджет|цена|цене|стоимост|руб|₽|тыс|т\.?\s*р|rub|budget|price|cost|\bза\s*\d|в\s+пределах\s*\d|в\s+рамках\s*\d|не\s+дороже\s*\d)/iu.test(text);
}

export function hasExplicitGeneratorPowerRequest(text: string) {
  return /(?:генератор|бензогенератор|электростанц)[^.!?\n]{0,60}\d+(?:[,.]\d+)?\s*(?:квт|kw|kva|ква)/iu.test(text) ||
    /\d+(?:[,.]\d+)?\s*(?:квт|kw|kva|ква)[^.!?\n]{0,60}(?:генератор|бензогенератор|электростанц)/iu.test(text);
}

// Text classifiers below are retrieval/fallback helpers. They must not override
// an explicit AssistantTurnPlan field returned by the AI turn planner.
export function inferProductIntent(text: string): ProductIntent {
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

export function fallbackDetectGeneratorEnclosureSignal(text: string) {
  return /(?:генератор|электростанц)[^.!?\n]{0,80}(?:в|со|с)\s+(?:закрыт\w*\s+)?(?:кожух|корпус|шумозащит|шумоизоляц|тих\w*)/iu.test(text) ||
    /(?:генератор|электростанц)[^.!?\n]{0,80}(?:закрыт\w*|тих\w*|шумозащит\w*|шумоизоляц\w*)/iu.test(text) ||
    /(?:закрыт\w*|тих\w*|шумозащит\w*|шумоизоляц\w*|в\s+кожухе|в\s+корпусе)[^.!?\n]{0,80}(?:генератор|электростанц)/iu.test(text);
}

export function fallbackDetectStandaloneGeneratorAccessoryRequest(text: string) {
  return /(?:кожух|блок\s+авр|авр|подогрев|фильтр|ремень|масло|расходник)[^.!?\n]{0,50}(?:для|на|к)\s+(?:генератор|электростанц)/iu.test(text);
}

export function hasElectricStartSignal(text: string) {
  return /(?:электр(?:о)?\s*стартер|электростарт|эл\.?\s*старт|ключ|ручн(?:ой|ая|ой\/)?\s*\/\s*электр|\p{L}{0,8}\s*\d{3,}\s*[eе]\b)/iu.test(text);
}

export function productFullText(product: Product) {
  return [product.name, product.brand, product.category, product.sourceUrl, product.description, JSON.stringify(product.specs ?? {})]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function productHasExactModel(product: Product, profile: ProductFitProfile) {
  const compact = compactModelText(productFullText(product));
  return profile.exactModelTokens.some((token) => compact.includes(compactModelText(token)));
}

export type ProductPhaseProfile = 'single_220' | 'mixed_220_380' | 'three_phase_380' | 'unknown';

export function generatorPhaseProfile(product: Product): ProductPhaseProfile {
  const text = productFullText(product);
  const compact = compactModelText(text);
  const hasMixedVoltage = /(?:220|230)\s*[\/\\-]\s*(?:380|400)|(?:380|400)\s*[\/\\-]\s*(?:220|230)/iu.test(text) ||
    /(?:220|230)(?:380|400)|(?:380|400)(?:220|230)/iu.test(compact);
  if (hasMixedVoltage) return 'mixed_220_380';
  const tssSggModels = String(product.name ?? '').match(/\bsgg\s*\d{3,5}\s*[\p{L}\p{N}]{0,8}\b/giu) ?? [];
  if (tssSggModels.some((model) => /^sgg\d{3,5}[a-z]*3[a-z0-9]*/iu.test(model.replace(/\s+/g, '').toLowerCase()))) {
    return 'three_phase_380';
  }

  const hasThreePhase = /(?:\b3\s*(?:phase|ph|фаз)|three[-\s]?phase|тр[её]х\s*фаз|тр[её]хфаз|3фаз)/iu.test(text);
  const has380 = /(?:^|[^\d])(?:380|400)\s*(?:в|v|volt|вольт)?(?:[^\d]|$)/iu.test(text);
  const has220 = /(?:^|[^\d])(?:220|230)\s*(?:в|v|volt|вольт)?(?:[^\d]|$)/iu.test(text) || containsAny(text, singlePhaseTerms);
  if (hasThreePhase || (has380 && !has220)) return 'three_phase_380';
  if (has220) return 'single_220';
  return 'unknown';
}

export function strictExactModelTokens(value: string) {
  const tokens = extractModelTokens(value);
  const strict = new Set<string>();
  for (const token of tokens) {
    const compact = compactModelText(token);
    if (!compact) continue;
    strict.add(token);
    const lat = compact.match(/^lat(\d{2,4})$/i);
    if (lat) strict.add(`LF ${lat[1]} LAT`);
    const lfLat = compact.match(/^lf(\d{2,4})lat$/i);
    if (lfLat) strict.add(`LF ${lfLat[1]} LAT`);
  }
  return [...strict];
}

export function productMatchesExactModelConstraint(product: Product, exactModelConstraint: string, fallbackTokens: string[]) {
  const productCompact = compactModelText(productFullText(product));
  const compactConstraint = compactModelText(exactModelConstraint);
  const latConstraint = compactConstraint.match(/^lat(\d{2,4})$/i);
  if (latConstraint) {
    const number = latConstraint[1];
    return productCompact.includes(`lat${number}`) || productCompact.includes(`lf${number}lat`);
  }
  const lfLatConstraint = compactConstraint.match(/^lf(\d{2,4})lat$/i);
  if (lfLatConstraint) return productCompact.includes(`lf${lfLatConstraint[1]}lat`);
  if (/^[a-zа-я]+\d{2,4}[a-zа-я]+$/iu.test(compactConstraint)) return productCompact.includes(compactConstraint);

  const constraintTokens = strictExactModelTokens(exactModelConstraint);
  const tokens = constraintTokens.length ? constraintTokens : fallbackTokens;
  if (!tokens.length) return true;
  return tokens.some((token) => {
    const compact = compactModelText(token);
    return compact.length >= 4 && productCompact.includes(compact);
  });
}

type ClassifyResult = ReturnType<typeof classifyProductUncached>;
const classifyCache = new WeakMap<Product, ClassifyResult>();

export function classifyProduct(product: Product): ClassifyResult {
  const cached = classifyCache.get(product);
  if (cached) return cached;
  const result = classifyProductUncached(product);
  classifyCache.set(product, result);
  return result;
}

function classifyProductUncached(product: Product) {
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
  const titleText = String(product.name ?? '').toLowerCase();
  const category = String(product.category ?? '').toLowerCase();
  const hasCoreTitleSignal = hasCoreMachineTitleSignal(titleText);
  const hasCoreCategorySignal = hasCoreMachineCategorySignal(category);
  const hasStrongCoreRoleEvidence = hasCoreTitleSignal || hasCoreCategorySignal;
  const hasAccessoryRoleEvidence = hasAccessoryCategorySignal(category) || hasAccessoryTitleForm(titleText);
  const isOilProduct = hasOilProductSignal(classText);
  const isIncompatibleOil = isOilProduct && containsAny(text, incompatibleOilTerms);
  const isEngineOil = isOilProduct && !isIncompatibleOil && (containsAny(text, fourStrokeOilTerms) || containsAny(category, oilTerms));
  const isGenericAccessoryProduct = hasAccessoryRoleEvidence && !hasStrongCoreRoleEvidence;
  const isPlateAccessory = containsAny(text, plateTerms) && (containsAny(classText, plateAccessoryTerms) || isGenericAccessoryProduct);
  const isGeneratorOil = (isOilProduct && containsAny(text, generatorTerms)) ||
    /масло\s+для\s+генератор|generator.?oil|10w-?40|5w-?30|sae\s*\d/i.test(text);
  const catalogGeneratorOil = (isOilProduct && containsAny(text, generatorTerms)) ||
    /generator.?oil|10w-?40|5w-?30|sae\s*\d/i.test(classText);
  const classHasGenerator = containsAny(classText, generatorTerms);
  const standaloneGeneratorAccessory = /(?:кожухи\s+для\s+генератора|^кожух\b|блок(?:и)?\s+авр|подогрев|фильтр|ремень|расходник|масло\s+для\s+генератор)/i.test(classText);
  const isAccessory = isPlateAccessory || catalogGeneratorOil || (containsAny(classText, accessoryTerms) && !hasStrongCoreRoleEvidence) ||
    (standaloneGeneratorAccessory && !/(?:^|\s)(?:генератор|электростанц)/i.test(classText));
  const isWeldingGenerator = containsAny(classText, weldingTerms) || category.includes('сварочные генераторы');
  const isConcreteVibrator = /(?:вибратор|vibrator|vibratory)/iu.test(classText) && !containsAny(classText, generatorTerms);
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
    isGenerator: containsAny(text, generatorTerms) && !isAccessory && !isWeldingGenerator && !isConcreteVibrator,
    isGeneratorAccessory: isAccessory && !isGeneratorOil && !isPlateAccessory,
    isGeneratorOil: catalogGeneratorOil && !isIncompatibleOil,
    isEngineOil,
    isPlateAccessory,
    isWeldingGenerator,
    isPlate: containsAny(classText, plateTerms) && !isPlateAccessory && (!isGenericAccessoryProduct || hasStrongCoreRoleEvidence),
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

export function isCoreEquipment(product: Product) {
  const flags = classifyProduct(product);
  return flags.isGenerator || flags.isWeldingGenerator || flags.isPlate || flags.isRammer || flags.isRoller || flags.isCutter || flags.isDiamondBlade || flags.isDiamondCore || flags.isTrowel;
}

export function isOilCard(product: Product) {
  const flags = classifyProduct(product);
  return flags.isEngineOil || flags.isGeneratorOil;
}

export function productMentionedInText(product: Product, text: string) {
  const compactText = compactModelText(text);
  if (!compactText) return false;
  const modelTokens = extractModelTokens(product.name).filter((token) => compactModelText(token).length >= 6);
  if (modelTokens.some((token) => compactText.includes(compactModelText(token)))) return true;
  const brand = displayProductBrand(product) || product.brand;
  const compactBrand = compactModelText(brand ?? '');
  return compactBrand.length >= 3 && compactText.includes(compactBrand);
}

export function displayProductBrand(product: Product) {
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

export function intentTextPatterns(intent: ProductSelectionClass): string[] {
  const patternMap: Partial<Record<ProductSelectionClass, string[]>> = {
    generator: ['генерат', 'электростанц', 'generator'],
    weldingGenerator: ['сварочн', 'welding', 'генерат'],
    generatorOil: ['масло', 'oil', 'sae', '10w', '5w'],
    engineOil: ['масло', 'oil', 'sae'],
    generatorAccessory: ['кожух', 'авр', 'подогрев', 'фильтр', 'расходник', 'генерат'],
    plateAccessory: ['виброплит', 'коврик', 'бак'],
    plate: ['виброплит', 'vibroplita'],
    rammer: ['трамбовк', 'виброног', 'rammer'],
    roller: ['виброкат', 'каток', 'roller'],
    cutter: ['резчик', 'швонарез', 'cutter'],
    diamondBlade: ['алмаз', 'диск', 'круг', 'diamond', 'blade'],
    diamondCore: ['коронк', 'алмаз', 'core', 'подрозет', 'бурен', 'сверлен'],
    trowel: ['затироч']
  };
  return patternMap[intent] ?? [];
}

export function strongProductMentionIndex(product: Product, text: string) {
  const compactText = compactModelText(text);
  if (!compactText) return -1;
  const compactName = compactModelText(product.name);
  if (compactName.length >= 12) {
    const index = compactText.indexOf(compactName);
    if (index >= 0) return index;
  }
  const modelTokens = extractModelTokens(product.name)
    .map((token) => compactModelText(token))
    .filter((token) => token.length >= 4);
  for (const token of modelTokens) {
    const index = compactText.indexOf(token);
    if (index >= 0) return index;
  }
  const nameTokens = String(product.name)
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => compactModelText(token))
    .filter((token) => token.length >= 4 && /\d/.test(token));
  for (const token of nameTokens) {
    const index = compactText.indexOf(token);
    if (index >= 0) return index;
  }
  return -1;
}
