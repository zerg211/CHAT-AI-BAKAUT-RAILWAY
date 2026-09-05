import type { Product } from '../shared/types.js';
import { AgentSelectionPolicySchema, type AgentIntentContract, type SelectionRequirement, type ToolResult } from './agentManagerContracts.js';
import { isModelTokenChar, modelTextTokens, textMatchesTargetName } from './modelTextMatching.js';
import { generatorPhaseProfile, generatorRemoteStartProfile, hasElectricStartSignal, productMatchesIntent } from './productClassifier.js';
import { classifyProductResearchSource } from './productComparisonResearch.js';

export type RequirementProofStatus = 'satisfied' | 'violated' | 'conflicted' | 'unverified';
export type RequirementEligibilityStatus = 'satisfied' | 'violated' | 'unknown';
export type RequirementProofSourceAuthority = 'authoritative_web' | 'corroborated_web' | 'catalog' | 'none';
export type RequirementProofNormalizedValue = string | number | boolean | null;

export interface RequirementProof {
  requirementId: string;
  productId: string;
  status: RequirementProofStatus;
  eligibilityStatus: RequirementEligibilityStatus;
  attribute: string;
  normalizedValue: RequirementProofNormalizedValue;
  normalizedUnit: string | null;
  normalizedRequirementValue: RequirementProofNormalizedValue;
  sourceResultIds: string[];
  sourceAuthority: RequirementProofSourceAuthority;
  caveats: string[];
}

const nativelyVerifiedRequirementKinds = new Set([
  'product_type',
  'product_class',
  'budget_max_rub',
  'price_max_rub',
  'price_lower_than_reference',
  'price_lower_than_reference_rub',
  'weight_min_kg',
  'weight_max_kg',
  'nominal_power_min_kw',
  'nominal_power_max_kw',
  'power_min_kw',
  'power_max_kw',
  'phase',
  'voltage_v',
  'fuel_type',
  'power_source',
  'auto_start_required',
  'autostart_required',
  'remote_start',
  'remote_start_required',
  'price_visibility',
  'comparison_scope',
  'quantity',
  'material',
  'generator_load_scenario'
]);

export function requirementUsesGenericReadProof(requirement: SelectionRequirement) {
  const verification = requirement.verification;
  if (verification?.mode === 'typed_tool') {
    return verification.tool === 'web.researchProductFacts' ||
      verification.tool === 'catalog.search' ||
      verification.tool === 'catalog.getProductDetails';
  }
  return !nativelyVerifiedRequirementKinds.has(requirement.kind);
}

type ProofCandidate = {
  productId: string;
  attribute: string;
  rawValue: unknown;
  rawUnit?: unknown;
  resultId: string;
  authority: 1 | 2 | 3;
  sourceAuthority: Exclude<RequirementProofSourceAuthority, 'none'>;
  reportedConflict?: boolean;
};

type NormalizedComparable = {
  value: RequirementProofNormalizedValue;
  unit: string | null;
};

const attributeStopWords = new Set([
  'attribute', 'fact', 'field', 'maximum', 'minimum', 'max', 'min', 'required', 'requirement',
  'value', 'spec', 'specification', 'характеристика', 'значение', 'максимальный', 'минимальный',
  'максимум', 'минимум', 'требуется', 'обязательный'
].flatMap((value) => modelTextTokens(value)));

const unitAliases = [
  { unit: 'db', aliases: ['db', 'дб', 'децибел'] },
  { unit: 'kw', aliases: ['kw', 'квт', 'kilowatt', 'киловатт'] },
  { unit: 'kva', aliases: ['kva', 'ква', 'kilovolt ampere', 'киловольт ампер'] },
  { unit: 'w', aliases: ['w', 'вт', 'watt', 'ватт'] },
  { unit: 'kg', aliases: ['kg', 'кг', 'kilogram', 'килограмм'] },
  { unit: 'l', aliases: ['l', 'л', 'liter', 'litre', 'литр'] },
  { unit: 'v', aliases: ['v', 'в', 'volt', 'вольт'] },
  { unit: 'mm', aliases: ['mm', 'мм', 'millimeter', 'миллиметр'] },
  { unit: 'cm', aliases: ['cm', 'см', 'centimeter', 'сантиметр'] },
  { unit: 'm', aliases: ['meter', 'metre', 'метр'] },
  { unit: 'h', aliases: ['hour', 'hours', 'час', 'ч'] }
] as const;

function normalizedWords(value: unknown) {
  return modelTextTokens(value).filter(Boolean);
}

function hasAnyWords(words: Set<string>, values: string[]) {
  return values.some((value) => normalizedWords(value).some((expectedWord) =>
    [...words].some((actualWord) => {
      if (actualWord === expectedWord) return true;
      const sharedPrefixLength = Math.min(5, actualWord.length, expectedWord.length);
      return sharedPrefixLength >= 4 &&
        actualWord.slice(0, sharedPrefixLength) === expectedWord.slice(0, sharedPrefixLength);
    })
  ));
}

function hasOnlyConceptWords(words: Set<string>, values: string[]) {
  return [...words].every((word) =>
    attributeStopWords.has(word) || hasAnyWords(new Set([word]), values)
  );
}

function canonicalAttribute(value: unknown) {
  const words = new Set(normalizedWords(value));
  const has = (...values: string[]) => hasAnyWords(words, values);
  if (has('phase', 'phases', 'фаза', 'фазы', 'фаз', 'фазность')) return 'phase';
  if (has('voltage', 'volt', 'напряжение', 'вольтаж')) return 'voltage';
  if (has('fuel', 'топливо')) return 'fuel_type';
  if (textHasAny(value, [
    'electric start', 'electric starter', 'электростарт', 'электростартер', 'электрический стартер'
  ])) {
    return 'electric_start';
  }
  if (
    has('remote', 'дистанционный') && has('start', 'запуск', 'старт') ||
    has('пульт', 'брелок', 'key fob') && has('start', 'запуск', 'старт')
  ) return 'remote_start';
  if (has('noise', 'sound', 'шум') && !has('insulation', 'изоляция')) return 'noise';
  if (
    has('engine', 'motor', 'двигатель', 'мотор') &&
    hasOnlyConceptWords(words, [
      'engine', 'motor', 'двигатель', 'мотор',
      'model', 'модель', 'name', 'название'
    ])
  ) return 'engine_model';
  if (has('tank', 'бак') && has('volume', 'capacity', 'объем', 'ёмкость', 'емкость')) return 'fuel_tank_volume';
  if (
    has('wheel', 'wheels', 'колесо', 'колеса', 'колёса') &&
    hasOnlyConceptWords(words, [
      'wheel', 'wheels', 'колесо', 'колеса', 'колёса',
      'kit', 'set', 'комплект', 'набор', 'presence', 'наличие', 'included'
    ])
  ) return 'wheel_kit';
  if (
    has('protective', 'protection', 'mat', 'коврик', 'защитный', 'защитная') &&
    has('paving', 'pave', 'tile', 'slab', 'brick', 'мощение', 'мощения', 'брусчатка', 'плитка')
  ) return 'protective_mat_for_paving';
  if (has('compatible', 'compatibility', 'совместимость', 'совместим', 'подходит')) return 'compatibility';
  if (has('autostart', 'auto start', 'automatic start', 'автозапуск')) return 'auto_start';
  if (has('material', 'материал')) return 'material';
  if (has('weight', 'mass', 'вес', 'масса')) return 'weight';
  if (has('power', 'мощность')) return 'power';
  if (has('price', 'cost', 'цена', 'стоимость', 'budget', 'бюджет')) return 'price';

  const unitWords = new Set(unitAliases.flatMap((entry) => entry.aliases.flatMap(normalizedWords)));
  return [...words]
    .filter((word) => !attributeStopWords.has(word) && !unitWords.has(word))
    .sort()
    .join('_');
}

function attributeMatches(left: unknown, right: unknown) {
  const leftAttribute = canonicalAttribute(left);
  const rightAttribute = canonicalAttribute(right);
  if (!leftAttribute || !rightAttribute) return false;
  if (leftAttribute === rightAttribute) {
    return leftAttribute !== 'power' ||
      powerQualifierForBindingAttribute(left) === powerQualifierForRequirementKind(right);
  }
  if (
    (leftAttribute === 'phase' && rightAttribute === 'voltage') ||
    (leftAttribute === 'voltage' && rightAttribute === 'phase')
  ) return true;
  const leftWords = new Set(leftAttribute.split('_'));
  const rightWords = new Set(rightAttribute.split('_'));
  return [...leftWords].every((word) => rightWords.has(word)) ||
    [...rightWords].every((word) => leftWords.has(word));
}

const strictBindingWordsByAttribute: Record<string, string[]> = {
  phase: ['phase', 'phases', 'фаза', 'фазность', 'single', 'three', 'однофазный', 'трехфазный', 'трёхфазный'],
  voltage: ['voltage', 'volt', 'напряжение', 'вольтаж', 'output', 'выходной'],
  noise: ['noise', 'sound', 'шум', 'level', 'уровень', 'pressure', 'давление', 'acoustic', 'акустический'],
  engine_model: [
    'engine', 'motor', 'двигатель', 'мотор', 'model', 'модель', 'name', 'название'
  ],
  fuel_tank_volume: [
    'fuel', 'топливо', 'tank', 'бак', 'volume', 'capacity', 'объем', 'объём', 'ёмкость', 'емкость'
  ],
  wheel_kit: [
    'wheel', 'wheels', 'колесо', 'колеса', 'колёса', 'kit', 'set', 'комплект', 'набор',
    'presence', 'наличие', 'included'
  ],
  protective_mat_for_paving: [
    'protective', 'protection', 'mat', 'paving', 'pave', 'tile', 'slab', 'brick',
    'коврик', 'защитный', 'защитная', 'мощение', 'мощения', 'брусчатка', 'плитка',
    'presence', 'наличие', 'included', 'комплект'
  ],
  compatibility: ['compatible', 'compatibility', 'совместимость', 'совместим', 'подходит'],
  auto_start: [
    'autostart', 'auto', 'automatic', 'start', 'авто', 'автоматический', 'запуск',
    'presence', 'наличие', 'support', 'поддержка', 'function', 'функция', 'capability', 'возможность'
  ],
  remote_start: [
    'remote', 'start', 'key', 'fob', 'дистанционный', 'запуск', 'старт', 'пульт', 'брелок',
    'presence', 'наличие', 'support', 'поддержка', 'function', 'функция', 'capability', 'возможность'
  ],
  electric_start: [
    'electric', 'start', 'starter', 'электрический', 'электростарт', 'электростартер', 'стартер'
  ],
  fuel_type: ['fuel', 'type', 'топливо', 'тип'],
  material: ['material', 'материал'],
  weight: [
    'weight', 'mass', 'вес', 'масса', 'operating', 'working', 'рабочий', 'эксплуатационный'
  ],
  power: [
    'power', 'мощность', 'output', 'выходной', 'nominal', 'rated', 'continuous', 'номинальный',
    'maximum', 'max', 'максимальный', 'макс', 'peak', 'surge', 'пиковый', 'предельный',
    'engine', 'motor', 'двигатель', 'мотор', 'active', 'активный', 'активная',
    'apparent', 'полный', 'полная', 'kva', 'ква'
  ],
  price: ['price', 'cost', 'цена', 'стоимость', 'budget', 'бюджет']
};

const strictBindingIgnoredWords = new Set([
  'the', 'of', 'for', 'product', 'товар', 'для', 'при', 'по'
].flatMap((value) => normalizedWords(value)));

const strictBindingUnitWords = new Set(
  unitAliases.flatMap((entry) => entry.aliases.flatMap(normalizedWords))
);

function strictBindingHasOnlyExpectedWords(value: unknown, attribute: string) {
  const allowed = strictBindingWordsByAttribute[attribute];
  if (!allowed) return canonicalAttribute(value) === attribute;
  const allowedWords = new Set(allowed.flatMap(normalizedWords));
  return normalizedWords(value).every((word) =>
    attributeStopWords.has(word) ||
    strictBindingIgnoredWords.has(word) ||
    strictBindingUnitWords.has(word) ||
    [...word].every((char) => char >= '0' && char <= '9') ||
    hasAnyWords(new Set([word]), [...allowedWords])
  );
}

type PowerQualifier = 'nominal' | 'maximum' | 'engine' | 'apparent';

function powerQualifierForBindingAttribute(value: unknown): PowerQualifier | undefined {
  const words = new Set(normalizedWords(value));
  if (hasAnyWords(words, ['apparent', 'полная', 'полный', 'kva', 'ква'])) return 'apparent';
  if (hasAnyWords(words, ['engine', 'motor', 'двигатель', 'мотор'])) return 'engine';
  if (hasAnyWords(words, ['nominal', 'rated', 'continuous', 'номинальный'])) return 'nominal';
  if (hasAnyWords(words, ['maximum', 'max', 'максимальный', 'макс', 'peak', 'surge', 'пиковый', 'предельный'])) {
    return 'maximum';
  }
  return undefined;
}

function powerQualifierForRequirementKind(value: unknown): PowerQualifier | undefined {
  const words = normalizedWords(value);
  const wordSet = new Set(words);
  if (hasAnyWords(wordSet, ['apparent', 'полная', 'полный', 'kva', 'ква'])) return 'apparent';
  if (hasAnyWords(wordSet, ['engine', 'motor', 'двигатель', 'мотор'])) return 'engine';
  if (hasAnyWords(wordSet, ['nominal', 'rated', 'continuous', 'номинальный'])) return 'nominal';
  const firstWord = words[0];
  if (firstWord && hasAnyWords(new Set([firstWord]), [
    'maximum', 'max', 'максимальный', 'макс', 'peak', 'surge', 'пиковый', 'предельный'
  ])) return 'maximum';
  return undefined;
}

export function selectionRequirementAttributeMatches(left: unknown, right: unknown) {
  const leftAttribute = canonicalAttribute(left);
  const rightAttribute = canonicalAttribute(right);
  if (
    leftAttribute === 'electric_start' &&
    rightAttribute === 'auto_start' &&
    strictBindingHasOnlyExpectedWords(left, leftAttribute)
  ) return true;
  if (!leftAttribute || leftAttribute !== rightAttribute) return false;
  if (!strictBindingHasOnlyExpectedWords(left, leftAttribute)) return false;
  if (leftAttribute === 'power') {
    return powerQualifierForBindingAttribute(left) === powerQualifierForRequirementKind(right);
  }
  return true;
}

function canonicalUnit(...values: unknown[]) {
  const words = new Set(values.flatMap(normalizedWords));
  for (const entry of unitAliases) {
    if (entry.aliases.some((alias) => normalizedWords(alias).some((word) => words.has(word)))) return entry.unit;
  }
  return null;
}

function firstFiniteNumber(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  let numeric = '';
  let decimalSeen = false;
  let started = false;
  for (const char of String(value ?? '')) {
    const isDigit = char >= '0' && char <= '9';
    if (isDigit) {
      numeric += char;
      started = true;
      continue;
    }
    if (!started && char === '-') {
      numeric = '-';
      continue;
    }
    if (started && !decimalSeen && (char === '.' || char === ',')) {
      numeric += '.';
      decimalSeen = true;
      continue;
    }
    if (started) break;
    numeric = '';
  }
  if (!started) return undefined;
  const numberValue = Number(numeric);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function baseUnitValue(value: number, unit: string | null): NormalizedComparable {
  if (unit === 'w') return { value: value / 1_000, unit: 'kw' };
  if (unit === 'cm') return { value: value * 10, unit: 'mm' };
  if (unit === 'm') return { value: value * 1_000, unit: 'mm' };
  return { value, unit };
}

function normalizedTextValue(value: unknown) {
  return normalizedWords(value).join('_');
}

function textHasAny(value: unknown, alternatives: string[]) {
  const words = new Set(normalizedWords(value));
  return alternatives.some((alternative) => normalizedWords(alternative).every((word) => words.has(word)));
}

function voltageMeasurement(value: unknown, sourceAttribute: unknown): NormalizedComparable {
  const raw = String(value ?? '').trim().toLocaleLowerCase('ru-RU');
  const scalar = raw ? Number(raw.split(',').join('.')) : NaN;
  if (canonicalAttribute(sourceAttribute) === 'voltage' && Number.isFinite(scalar)) {
    return { value: scalar, unit: 'v' };
  }

  // A phase field may also contain a voltage, frequency and current. Only a
  // number explicitly paired with volts proves voltage; the phase count does not.
  const measurements = new Set<number>();
  const units = unitAliases.find((entry) => entry.unit === 'v')!.aliases;
  const isDigit = (char: string | undefined) => char !== undefined && char >= '0' && char <= '9';
  for (let start = 0; start < raw.length; start += 1) {
    if (!isDigit(raw[start]) || start > 0 && isModelTokenChar(raw[start - 1]!)) continue;
    let end = start;
    while (isDigit(raw[end])) end += 1;
    if ((raw[end] === '.' || raw[end] === ',') && isDigit(raw[end + 1])) {
      end += 1;
      while (isDigit(raw[end])) end += 1;
    }
    let unitStart = end;
    while (unitStart < raw.length && raw[unitStart]!.trim() === '') unitStart += 1;
    if (units.some((unit) => raw.startsWith(unit, unitStart) &&
      (unitStart + unit.length === raw.length || !isModelTokenChar(raw[unitStart + unit.length]!)))) {
      const preceding = raw.slice(0, start).trimEnd();
      if (['/', '-', '–'].includes(preceding.at(-1) ?? '') &&
        isDigit(preceding.slice(0, -1).trimEnd().at(-1))) {
        // A shared unit in a list/range such as 230/400 V does not prove
        // that only the last voltage is available.
        return { value: null, unit: null };
      }
      measurements.add(Number(raw.slice(start, end).split(',').join('.')));
    }
    start = end - 1;
  }
  return measurements.size === 1
    ? { value: [...measurements][0]!, unit: 'v' }
    : { value: null, unit: null };
}

function normalizeComparable(input: {
  value: unknown;
  unit?: unknown;
  attribute: string;
  sourceAttribute?: string;
  preferNumeric: boolean;
}): NormalizedComparable {
  if (typeof input.value === 'boolean') return { value: input.value, unit: null };
  const attribute = canonicalAttribute(input.attribute);
  const rawText = String(input.value ?? '').trim();
  const unit = canonicalUnit(input.unit, rawText, input.attribute);

  if (attribute === 'voltage') return voltageMeasurement(input.value, input.sourceAttribute ?? input.attribute);

  if (attribute === 'phase') {
    const sourceAttribute = input.sourceAttribute ?? input.attribute;
    const phaseCount = canonicalAttribute(sourceAttribute) === 'phase' ? Number(rawText) : NaN;
    const voltage = voltageMeasurement(input.value, sourceAttribute).value;
    const single = phaseCount === 1 || voltage === 220 || voltage === 230 || textHasAny(rawText, [
      'single phase', 'one phase', '1 phase', '1 фаза', 'однофазный', 'однофазная', 'однофазное', 'однофазные'
    ]);
    const three = phaseCount === 3 || voltage === 380 || voltage === 400 || textHasAny(rawText, [
      'three phase', '3 phase', '3 фазы', 'трехфазный', 'трёхфазный', 'трехфазная', 'трёхфазная',
      'трехфазное', 'трёхфазное', 'трехфазные', 'трёхфазные'
    ]);
    if (single && three) return { value: 'mixed_phase', unit: null };
    if (single) return { value: 'single_phase', unit: null };
    if (three) return { value: 'three_phase', unit: null };
    return { value: null, unit: null };
  }

  if (attribute === 'auto_start') {
    if (textHasAny(rawText, ['without autostart', 'without auto start', 'без автозапуска'])) {
      return { value: false, unit: null };
    }
    if (textHasAny(rawText, ['with autostart', 'with auto start', 'с автозапуском'])) {
      return { value: true, unit: null };
    }
  }

  if (attribute === 'remote_start') {
    const normalized = rawText.toLocaleLowerCase('ru-RU');
    if ([
      'without remote', 'no remote', 'remote absent', 'без дистанцион',
      'нет дистанцион', 'без пульта', 'без брелока'
    ].some((signal) => normalized.includes(signal))) {
      return { value: false, unit: null };
    }
    if ([
      'remote', 'дистанцион', 'пульт', 'брелок', 'key fob'
    ].some((signal) => normalized.includes(signal))) {
      return { value: true, unit: null };
    }
  }

  if (attribute === 'electric_start') {
    if (textHasAny(rawText, [
      'without electric start', 'without electric starter', 'manual starter only',
      'без электростартера', 'только ручной стартер'
    ])) return { value: false, unit: null };
    if (hasElectricStartSignal(rawText)) return { value: true, unit: null };
  }

  if (typeof input.value === 'number' || input.preferNumeric || unit !== null) {
    const numeric = firstFiniteNumber(input.value);
    if (numeric !== undefined) return baseUnitValue(numeric, unit);
  }

  if (textHasAny(rawText, ['not included', 'not present', 'absent', 'no', 'нет', 'отсутствует', 'несовместим'])) {
    return { value: false, unit: null };
  }
  if (textHasAny(rawText, ['included', 'present', 'available', 'yes', 'да', 'есть', 'в комплекте', 'совместим', 'подходит'])) {
    return { value: true, unit: null };
  }
  const rawWords = new Set(normalizedWords(rawText));
  if (hasAnyWords(rawWords, ['diesel', 'дизель'])) return { value: 'diesel', unit: null };
  if (hasAnyWords(rawWords, ['gasoline', 'petrol', 'бензин'])) return { value: 'gasoline', unit: null };
  return { value: normalizedTextValue(input.value), unit };
}

function requirementBindingAttribute(requirement: SelectionRequirement) {
  return requirement.verification?.mode === 'typed_tool'
    ? requirement.verification.bindAs
    : requirement.kind;
}

function numericRelation(requirement: SelectionRequirement) {
  const words = new Set(normalizedWords([requirement.kind, requirementBindingAttribute(requirement)].join(' ')));
  if (hasAnyWords(words, ['maximum', 'max', 'до', 'максимум', 'максимальный'])) return 'max' as const;
  if (hasAnyWords(words, ['minimum', 'min', 'от', 'минимум', 'минимальный'])) return 'min' as const;
  return 'exact' as const;
}

function compareRequirement(requirement: SelectionRequirement, actual: NormalizedComparable) {
  const attribute = canonicalAttribute(requirementBindingAttribute(requirement));
  const expectedNumber = typeof requirement.value === 'number' || firstFiniteNumber(requirement.value) !== undefined && requirement.unit !== null;
  const expected = normalizeComparable({
    value: requirement.value,
    unit: requirement.unit,
    attribute: requirementBindingAttribute(requirement),
    preferNumeric: expectedNumber
  });
  if (actual.value === null || actual.value === '') return { status: 'unverified' as const, expected };
  if (expected.unit && actual.unit && expected.unit !== actual.unit) return { status: 'unverified' as const, expected };

  let matches: boolean;
  if (
    attribute === 'voltage' &&
    typeof expected.value === 'number' &&
    typeof actual.value === 'number' &&
    (
      ([220, 230].includes(expected.value) && [220, 230].includes(actual.value)) ||
      ([380, 400].includes(expected.value) && [380, 400].includes(actual.value))
    )
  ) {
    matches = true;
  } else if (typeof expected.value === 'number' && typeof actual.value === 'number') {
    const relation = numericRelation(requirement);
    matches = relation === 'max'
      ? actual.value <= expected.value
      : relation === 'min'
        ? actual.value >= expected.value
        : Math.abs(actual.value - expected.value) < 1e-9;
  } else if (attribute === 'phase') {
    matches = actual.value === expected.value ||
      (expected.value === 'single_phase' && actual.value === 220) ||
      (expected.value === 'single_phase' && actual.value === 230) ||
      (expected.value === 'three_phase' && actual.value === 380) ||
      (expected.value === 'three_phase' && actual.value === 400);
  } else if (typeof expected.value === 'string' && typeof actual.value === 'string') {
    // Open text values such as material, purpose and compatibility require
    // semantic interpretation. String inequality or a missing substring is not
    // proof of incompatibility and must not remove a candidate before the LLM
    // writer evaluates the checked facts. Fuel and canonical product classes
    // are closed factual enums and may still be compared deterministically.
    const textMatches = actual.value === expected.value || actual.value.includes(expected.value);
    if (attribute !== 'fuel_type' && requirement.kind !== 'product_class' && requirement.kind !== 'product_type') {
      if (requirement.relation === 'must_not_have') {
        return { status: textMatches ? 'violated' as const : 'unverified' as const, expected };
      }
      return { status: textMatches ? 'satisfied' as const : 'unverified' as const, expected };
    }
    matches = actual.value === expected.value;
  } else {
    matches = actual.value === expected.value;
  }

  if (requirement.relation === 'must_not_have' && typeof requirement.value !== 'boolean') matches = !matches;
  return { status: matches ? 'satisfied' as const : 'violated' as const, expected };
}

function scalarEntries(value: unknown, path = ''): Array<{ path: string; value: unknown }> {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'object') return [{ path, value }];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => scalarEntries(item, path ? `${path}.${index}` : String(index)));
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    scalarEntries(item, path ? `${path}.${key}` : key)
  );
}

function productLookupText(product: Product) {
  return [product.name, product.brand, product.category, product.externalId, product.slug, product.sourceUrl]
    .filter(Boolean)
    .join(' ');
}

function productForFact(products: Product[], fact: { productName?: unknown; sourceUrl?: unknown; sourceTitle?: unknown }) {
  const sourceUrl = typeof fact.sourceUrl === 'string' ? fact.sourceUrl.trim().toLocaleLowerCase('en-US') : '';
  let hasExplicitIdentity = false;
  if (sourceUrl) {
    hasExplicitIdentity = true;
    const byUrl = products.find((product) => product.sourceUrl?.trim().toLocaleLowerCase('en-US') === sourceUrl);
    if (byUrl) return byUrl;
  }
  for (const value of [fact.productName, fact.sourceTitle]) {
    if (typeof value !== 'string' || !value.trim()) continue;
    hasExplicitIdentity = true;
    const byName = products.find((product) => textMatchesTargetName(productLookupText(product), value));
    if (byName) return byName;
  }
  return !hasExplicitIdentity && products.length === 1 ? products[0] : undefined;
}

function resultProducts(result: ToolResult): Product[] {
  const products = (result.payload as { products?: unknown }).products;
  return Array.isArray(products)
    ? products.filter((item): item is Product => Boolean(
        item && typeof item === 'object' &&
        typeof (item as { id?: unknown }).id === 'string' &&
        typeof (item as { name?: unknown }).name === 'string'
      ))
    : [];
}

function fuelTypeFromText(value: unknown): 'diesel' | 'gasoline' | null {
  const words = new Set(normalizedWords(value));
  const diesel = hasAnyWords(words, ['diesel', 'дизель']);
  const gasoline = hasAnyWords(words, ['gasoline', 'petrol', 'бензин']);
  if (diesel === gasoline) return null;
  return diesel ? 'diesel' : 'gasoline';
}

function eligibleResults(input: {
  requirement: SelectionRequirement;
  intent: AgentIntentContract;
  toolResults: ToolResult[];
}) {
  const verification = input.requirement.verification;
  if (verification?.mode === 'typed_tool') {
    const initialRequest = input.intent.toolRequests.find((request) => request.id === verification.toolRequestId);
    if (
      initialRequest?.required !== true ||
      initialRequest.tool !== verification.tool ||
      !(initialRequest.coversRequirementIds ?? []).includes(input.requirement.id)
    ) return [];
    // Read proofs can accumulate evidence from later required reads without
    // rewriting the requirement's original binding. Every result must still
    // belong to a planned tool request that explicitly covers this requirement.
    // Derived tool outputs retain their exact verifier/request binding.
    const readProof = requirementUsesGenericReadProof(input.requirement);
    const coveredRequests = new Map(input.intent.toolRequests.filter((request) =>
      request.required &&
      (request.coversRequirementIds ?? []).includes(input.requirement.id) &&
      (
        request.id === initialRequest.id ||
        (readProof && (
          request.tool === 'catalog.search' ||
          request.tool === 'catalog.getProductDetails' ||
          request.tool === 'web.researchProductFacts'
        ))
      )
    ).map((request) => [request.id, request]));
    return input.toolResults.filter((result) =>
      result.status === 'ok' &&
      coveredRequests.get(result.requestId)?.tool === result.tool
    );
  }
  const coveredRequestIds = new Set(input.intent.toolRequests.flatMap((request) =>
    request.required && (request.coversRequirementIds ?? []).includes(input.requirement.id)
      ? [request.id]
      : []
  ));
  return input.toolResults.filter((result) =>
    result.status === 'ok' &&
    (
      coveredRequestIds.has(result.requestId) ||
      (verification?.mode === 'product_attribute' &&
        (result.tool === 'catalog.search' || result.tool === 'catalog.getProductDetails'))
    )
  );
}

function catalogCandidates(input: {
  result: ToolResult;
  requirement: SelectionRequirement;
  products: Product[];
}) {
  const attribute = requirementBindingAttribute(input.requirement);
  return resultProducts(input.result).flatMap((resultProduct): ProofCandidate[] => {
    const product = input.products.find((candidate) => candidate.id === resultProduct.id) ??
      productForFact(input.products, { productName: resultProduct.name, sourceUrl: resultProduct.sourceUrl });
    if (!product) return [];
    const canonical = canonicalAttribute(attribute);
    const entries = scalarEntries(resultProduct.specs).filter((entry) => {
      const attributeMatch = attributeMatches(entry.path, attribute) ||
        (canonical === 'electric_start' && textHasAny(entry.path, ['starter', 'стартер', 'starting system', 'система запуска']));
      return attributeMatch && (canonical !== 'fuel_type' || fuelTypeFromText(entry.value) !== null);
    });
    if (canonicalAttribute(attribute) === 'price' && typeof resultProduct.price === 'number') {
      entries.push({ path: 'price', value: resultProduct.price });
    }
    if (input.requirement.kind === 'product_class' || input.requirement.kind === 'product_type') {
      const knownClasses = AgentSelectionPolicySchema.shape.canonicalProductClass.unwrap().options
        .filter((productClass) => productClass !== 'unknown' && productMatchesIntent(resultProduct, productClass));
      const expectedClass = knownClasses.find((productClass) => productClass === input.requirement.value);
      for (const productClass of expectedClass ? [expectedClass] : knownClasses) {
        entries.push({ path: attribute, value: productClass });
      }
    }
    if (canonicalAttribute(attribute) === 'phase') {
      const nameOnlyPhase = generatorPhaseProfile({
        id: resultProduct.id,
        name: resultProduct.name,
        specs: {}
      });
      const namePhaseValue = nameOnlyPhase === 'single_220'
        ? 'single phase 230 V'
        : nameOnlyPhase === 'three_phase_380'
          ? 'three phase 400 V'
          : nameOnlyPhase === 'mixed_220_380'
            ? 'single phase 230 V and three phase 400 V'
            : null;
      if (namePhaseValue) entries.push({ path: 'name_phase_marker', value: namePhaseValue });
    }
    if (canonical === 'remote_start') {
      const profile = generatorRemoteStartProfile(resultProduct);
      if (profile === 'present') entries.push({ path: 'remote_start', value: true });
      if (profile === 'absent') entries.push({ path: 'remote_start', value: false });
    }
    if (canonical === 'fuel_type') {
      const identityText = `${resultProduct.name} ${resultProduct.category ?? ''}`;
      const identityFuelType = fuelTypeFromText(identityText);
      if (identityFuelType) entries.push({ path: 'name_fuel_marker', value: identityFuelType });
    }
    return entries.map((entry) => ({
      productId: product.id,
      attribute: entry.path,
      rawValue: entry.value,
      rawUnit: entry.path,
      resultId: input.result.requestId,
      authority: 1,
      sourceAuthority: 'catalog'
    }));
  });
}

function webCandidates(input: {
  result: ToolResult;
  requirement: SelectionRequirement;
  products: Product[];
}) {
  const attribute = requirementBindingAttribute(input.requirement);
  const payload = input.result.payload as {
    facts?: unknown;
    conflicts?: unknown;
    answerGuidance?: { coverage?: unknown };
  };
  const facts = Array.isArray(payload.facts) ? payload.facts : [];
  const candidates: ProofCandidate[] = [];
  for (const rawFact of facts) {
    if (!rawFact || typeof rawFact !== 'object') continue;
    const fact = rawFact as Record<string, unknown>;
    if (!attributeMatches(fact.attribute, attribute)) continue;
    if (fact.sourceType === 'conflict' || (fact.confidence !== 'high' && fact.confidence !== 'medium')) continue;
    const product = productForFact(input.products, fact);
    if (!product) continue;
    const web = fact.sourceType === 'web';
    const sourceDescriptor = web
      ? classifyProductResearchSource({
          sourceUrl: fact.sourceUrl,
          sourceTitle: fact.sourceTitle,
          product
        })
      : null;
    const authoritative = web && fact.confidence === 'high' && sourceDescriptor?.authority === 'manufacturer';
    candidates.push({
      productId: product.id,
      attribute: String(fact.attribute ?? attribute),
      rawValue: fact.value,
      rawUnit: fact.attribute,
      resultId: input.result.requestId,
      authority: authoritative ? 3 : web ? 2 : 1,
      sourceAuthority: authoritative ? 'authoritative_web' : web ? 'corroborated_web' : 'catalog'
    });
  }

  const coverage = payload.answerGuidance && Array.isArray(payload.answerGuidance.coverage)
    ? payload.answerGuidance.coverage
    : [];
  for (const rawCoverage of coverage) {
    if (!rawCoverage || typeof rawCoverage !== 'object') continue;
    const item = rawCoverage as Record<string, unknown>;
    if (item.status !== 'confirmed' || !attributeMatches(item.attribute, attribute)) continue;
    const product = productForFact(input.products, item);
    if (!product) continue;
    const sourceDescriptor = classifyProductResearchSource({
      sourceUrl: item.sourceUrl,
      sourceTitle: item.sourceTitle,
      product
    });
    const authoritative = sourceDescriptor?.authority === 'manufacturer';
    candidates.push({
      productId: product.id,
      attribute: String(item.attribute ?? attribute),
      rawValue: item.value,
      rawUnit: item.attribute,
      resultId: input.result.requestId,
      authority: authoritative ? 3 : 2,
      sourceAuthority: authoritative ? 'authoritative_web' : 'corroborated_web'
    });
  }

  const conflicts = Array.isArray(payload.conflicts) ? payload.conflicts : [];
  for (const rawConflict of conflicts) {
    if (!rawConflict || typeof rawConflict !== 'object') continue;
    const conflict = rawConflict as Record<string, unknown>;
    if (!attributeMatches(conflict.attribute, attribute) || conflict.catalogValue == null) continue;
    const product = productForFact(input.products, conflict);
    if (!product) continue;
    candidates.push({
      productId: product.id,
      attribute: String(conflict.attribute ?? attribute),
      rawValue: conflict.catalogValue,
      rawUnit: conflict.attribute,
      resultId: input.result.requestId,
      authority: 1,
      sourceAuthority: 'catalog',
      reportedConflict: true
    });
  }
  return candidates;
}

function comparableKey(value: NormalizedComparable, attribute: string) {
  // Source consistency must use the same nominal-voltage equivalence as the
  // requirement comparison, while keeping the actual measured value in the proof.
  if (attribute === 'voltage' && typeof value.value === 'number') {
    if ([220, 230].includes(value.value)) return 'voltage:220/230:v';
    if ([380, 400].includes(value.value)) return 'voltage:380/400:v';
  }
  return `${typeof value.value}:${String(value.value)}:${value.unit ?? ''}`;
}

function proofForProduct(input: {
  requirement: SelectionRequirement;
  product: Product;
  candidates: ProofCandidate[];
}): RequirementProof {
  const attribute = canonicalAttribute(requirementBindingAttribute(input.requirement));
  const expected = normalizeComparable({
    value: input.requirement.value,
    unit: input.requirement.unit,
    attribute,
    preferNumeric: typeof input.requirement.value === 'number'
  });
  const productCandidates = input.candidates.filter((candidate) => candidate.productId === input.product.id);
  const normalizedCandidates = productCandidates.map((candidate) => ({
    candidate,
    comparable: normalizeComparable({
      value: candidate.rawValue,
      unit: candidate.rawUnit,
      attribute,
      sourceAttribute: candidate.attribute,
      preferNumeric: typeof input.requirement.value === 'number'
    })
  })).filter((item) => (attribute !== 'voltage' && attribute !== 'phase') || item.comparable.value !== null);
  if (!normalizedCandidates.length) {
    return {
      requirementId: input.requirement.id,
      productId: input.product.id,
      status: 'unverified',
      eligibilityStatus: 'unknown',
      attribute,
      normalizedValue: null,
      normalizedUnit: null,
      normalizedRequirementValue: expected.value,
      sourceResultIds: [],
      sourceAuthority: 'none',
      caveats: []
    };
  }

  const topAuthority = Math.max(...normalizedCandidates.map((item) => item.candidate.authority));
  const top = normalizedCandidates.filter((item) => item.candidate.authority === topAuthority);
  const topValues = new Map(top.map((item) => [comparableKey(item.comparable, attribute), item]));
  const sourceResultIds = [...new Set(normalizedCandidates.map((item) => item.candidate.resultId))];
  const topSourceAuthority = top[0]?.candidate.sourceAuthority ?? 'none';
  if (topValues.size !== 1) {
    return {
      requirementId: input.requirement.id,
      productId: input.product.id,
      status: 'conflicted',
      eligibilityStatus: 'unknown',
      attribute,
      normalizedValue: null,
      normalizedUnit: null,
      normalizedRequirementValue: expected.value,
      sourceResultIds,
      sourceAuthority: topSourceAuthority,
      caveats: [`Проверенные источники расходятся по характеристике «${attribute}», поэтому соответствие требованию не подтверждено.`]
    };
  }

  const selected = [...topValues.values()][0]!;
  const selectedKey = comparableKey(selected.comparable, attribute);
  const lowerConflict = normalizedCandidates.some((item) =>
    item.candidate.authority < topAuthority && comparableKey(item.comparable, attribute) !== selectedKey
  ) || productCandidates.some((candidate) => candidate.reportedConflict && candidate.authority < topAuthority &&
    normalizeComparable({ value: candidate.rawValue, unit: candidate.rawUnit, attribute,
      sourceAttribute: candidate.attribute, preferNumeric: typeof input.requirement.value === 'number' }).value === null);
  if (lowerConflict && topAuthority < 3) {
    return {
      requirementId: input.requirement.id,
      productId: input.product.id,
      status: 'conflicted',
      eligibilityStatus: 'unknown',
      attribute,
      normalizedValue: selected.comparable.value,
      normalizedUnit: selected.comparable.unit,
      normalizedRequirementValue: expected.value,
      sourceResultIds,
      sourceAuthority: topSourceAuthority,
      caveats: [`Источники расходятся по характеристике «${attribute}»; данных недостаточно для безопасного окончательного вывода.`]
    };
  }

  const comparison = compareRequirement(input.requirement, selected.comparable);
  return {
    requirementId: input.requirement.id,
    productId: input.product.id,
    status: comparison.status,
    eligibilityStatus: comparison.status === 'satisfied' || comparison.status === 'violated'
      ? comparison.status
      : 'unknown',
    attribute,
    normalizedValue: selected.comparable.value,
    normalizedUnit: selected.comparable.unit,
    normalizedRequirementValue: comparison.expected.value,
    sourceResultIds,
    sourceAuthority: topSourceAuthority,
    caveats: lowerConflict
      ? [`Проверенный внешний источник подтверждает характеристику «${attribute}», но в каталоге есть противоречащее значение; для отбора использованы более авторитетные данные.`]
      : []
  };
}

export function buildRequirementProofs(input: {
  intent: AgentIntentContract;
  products: Product[];
  toolResults: ToolResult[];
}) {
  const requirements = (input.intent.selectionPolicy?.requirements ?? []).filter((requirement) =>
    requirement.role === 'hard_constraint' && requirement.strictness === 'strict'
  );
  return requirements.flatMap((requirement) => {
    const results = eligibleResults({ requirement, intent: input.intent, toolResults: input.toolResults });
    const candidates = results.flatMap((result) =>
      result.tool === 'web.researchProductFacts'
        ? webCandidates({ result, requirement, products: input.products })
        : result.tool === 'catalog.search' || result.tool === 'catalog.getProductDetails'
          ? catalogCandidates({ result, requirement, products: input.products })
          : []
    );
    return input.products.map((product) => proofForProduct({ requirement, product, candidates }));
  });
}

export function requirementProofsFor(
  proofs: RequirementProof[],
  productId: string,
  requirementIds: string[]
) {
  const ids = new Set(requirementIds);
  return proofs.filter((proof) => proof.productId === productId && ids.has(proof.requirementId));
}

export function combinedRequirementProofStatus(proofs: RequirementProof[]): RequirementProofStatus | undefined {
  if (!proofs.length) return undefined;
  if (proofs.some((proof) => proof.status === 'conflicted')) return 'conflicted';
  if (proofs.some((proof) => proof.status === 'violated')) return 'violated';
  if (proofs.every((proof) => proof.status === 'satisfied')) return 'satisfied';
  return 'unverified';
}

export function authoritativeRequirementProofStatus(proofs: RequirementProof[]): RequirementProofStatus | undefined {
  return combinedRequirementProofStatus(proofs.filter((proof) => proof.sourceAuthority === 'authoritative_web'));
}

export function combinedRequirementEligibilityStatus(
  proofs: RequirementProof[]
): RequirementEligibilityStatus | undefined {
  if (!proofs.length) return undefined;
  if (proofs.some((proof) => proof.eligibilityStatus === 'violated')) return 'violated';
  if (proofs.every((proof) => proof.eligibilityStatus === 'satisfied')) return 'satisfied';
  return 'unknown';
}

export function authoritativeRequirementEligibilityStatus(
  proofs: RequirementProof[]
): RequirementEligibilityStatus | undefined {
  return combinedRequirementEligibilityStatus(
    proofs.filter((proof) => proof.sourceAuthority === 'authoritative_web')
  );
}

export function resolvedRequirementEligibilityStatus(
  proofs: RequirementProof[]
): RequirementEligibilityStatus | undefined {
  if (!proofs.length) return undefined;
  const byRequirementId = new Map<string, RequirementProof[]>();
  for (const proof of proofs) {
    byRequirementId.set(proof.requirementId, [
      ...(byRequirementId.get(proof.requirementId) ?? []),
      proof
    ]);
  }
  const statuses = [...byRequirementId.values()].map((requirementProofs) =>
    authoritativeRequirementEligibilityStatus(requirementProofs) ??
    combinedRequirementEligibilityStatus(requirementProofs) ??
    'unknown'
  );
  if (statuses.some((status) => status === 'violated')) return 'violated';
  if (statuses.every((status) => status === 'satisfied')) return 'satisfied';
  return 'unknown';
}

export function productRequirementProofCaveats(proofs: RequirementProof[]) {
  const caveatsByProductId: Record<string, string[]> = {};
  for (const proof of proofs) {
    if (!proof.caveats.length) continue;
    caveatsByProductId[proof.productId] = [...new Set([
      ...(caveatsByProductId[proof.productId] ?? []),
      ...proof.caveats
    ])];
  }
  return caveatsByProductId;
}
