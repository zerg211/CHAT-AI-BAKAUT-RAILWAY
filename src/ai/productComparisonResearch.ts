import { config } from '../config.js';
import type { Product } from '../shared/types.js';
import * as cheerio from 'cheerio';
import { fetch } from 'undici';
import { approvedAnswerStyleExamplesPromptBlock } from './answerStyleExamples.js';
import { createStructuredJsonResponse } from './openaiStructured.js';
import { safeError } from './responseUtils.js';

export interface ProductComparisonResearchFact {
  productName: string;
  attribute: string;
  value: string;
  sourceType: 'catalog' | 'web' | 'conflict';
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
  sourceUrl?: string;
  sourceTitle?: string;
}

export interface ProductComparisonResearchConflict {
  productName: string;
  attribute: string;
  catalogValue?: string;
  webValues: string[];
  resolution: string;
}

export interface ProductComparisonResearchAnswerGuidance {
  directAnswer: string;
  completeness: 'answered' | 'partially_answered' | 'not_answered';
  coverage: Array<{
    attribute: string;
    status: 'confirmed' | 'not_confirmed' | 'contradicted' | 'ambiguous' | 'not_found';
    value: string;
    evidence: string;
    sourceUrl?: string;
    sourceTitle?: string;
  }>;
}

export interface ProductComparisonResearchResult {
  usedWebSearch: boolean;
  facts: ProductComparisonResearchFact[];
  conflicts: ProductComparisonResearchConflict[];
  answerGuidance: ProductComparisonResearchAnswerGuidance;
  summaryForAnswer: string;
  warnings: string[];
}

type ResearchCoverageItem = ProductComparisonResearchAnswerGuidance['coverage'][number];

function productResearchContext(products: Product[]) {
  return products.map((product) => ({
    id: product.id,
    name: product.name,
    brand: product.brand,
    category: product.category,
    price: product.price,
    currency: product.currency,
    sourceUrl: product.sourceUrl,
    specs: product.specs,
    description: product.description
  }));
}

function exactTargetSearchQueries(targetProductNames: string[], attributes: string[]) {
  const usefulAttributes = attributes.length
    ? attributes
    : ['specification', 'manual', 'starter', 'start method'];
  const controlAttributes = [
    'control panel photo',
    'control panel image',
    'starter switch photo',
    'ignition switch photo',
    'ignition key photo',
    'push button photo',
    'front panel',
    'operator panel',
    'панель управления фото',
    'фото панели',
    'ключ зажигания фото',
    'кнопка запуска фото'
  ];
  const defaultAttributes = [
    'specification',
    'manual pdf',
    'instruction',
    'ignition key',
    'key start',
    'push button start',
    'engine switch START',
    'ignition switch START',
    'starter switch START',
    'electric starter',
    'recoil starter',
    'ключ зажигания',
    'кнопка запуска',
    'электростартер',
    'ручной стартер'
  ];
  return targetProductNames.flatMap((target) => {
    const aliases = exactTargetAliases(target);
    const queryAttributes = uniqueStrings([...usefulAttributes, ...controlAttributes, ...defaultAttributes]).slice(0, 24);
    return aliases.flatMap((alias) => queryAttributes.map((attribute) => `${alias} ${attribute}`));
  });
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizedText(value: unknown) {
  return String(value ?? '').normalize('NFKD').toLocaleLowerCase('ru-RU');
}

function textIncludesAny(value: unknown, fragments: string[]) {
  const text = normalizedText(value);
  return fragments.some((fragment) => {
    const normalizedFragment = normalizedText(fragment);
    return normalizedFragment.length > 0 && text.includes(normalizedFragment);
  });
}

const startControlNeedles = [
  'starter',
  'start',
  'ignition',
  'key',
  'button',
  'manual',
  'recoil',
  'стартер',
  'запуск',
  'пуск',
  'ключ',
  'кноп',
  'ручн',
  'электростартер'
];

const manualStarterNeedles = ['manual starter', 'recoil starter', 'manual recoil', 'ручной стартер', 'ручной запуск', 'ручн'];
const starterFieldNeedles = ['starter', 'start', 'пуск', 'запуск', 'стартер'];

function startControlQuestionRelevant(userMessage: string, comparisonAttributes: string[]) {
  return textIncludesAny([userMessage, ...comparisonAttributes].join(' '), startControlNeedles);
}

const electricStarterNeedles = [
  'electric starter',
  'electric start',
  'electrostarter',
  'manual/electric',
  'manual / electric',
  'электростартер',
  'электро стартер',
  'электропуск',
  'электрический стартер',
  'электрический запуск',
  'ручной/электро',
  'ручной / электро'
];
const practicalStartControlNeedles = [
  'key start',
  'ignition key',
  'ignition switch',
  'engine switch',
  'starter switch',
  'start switch',
  'push button',
  'button start',
  'ключ',
  'зажиган',
  'замок',
  'выключател',
  'тумблер',
  'кноп'
];
const controlSearchQuestionNeedles = [
  'key',
  'button',
  'push button',
  'ignition',
  'switch',
  'control',
  'ключ',
  'кноп',
  'зажиган',
  'замок',
  'выключател',
  'тумблер'
];

const sourceBackedStartKinds = ['key_start', 'button_start', 'switch_start', 'electric_start', 'manual_starter'] as const;
type SourceBackedStartKind = typeof sourceBackedStartKinds[number];

const keyStartClaimNeedles = [
  'key start',
  'ignition key',
  'key switch',
  'turn the key',
  'turned by key',
  'starts with a key',
  'с ключа',
  'ключ зажигания',
  'ключ электростартера',
  'ключом электростартера',
  'поворот ключ',
  'поворотом ключ',
  'поверните ключ',
  'запуск ключом',
  'замок зажигания'
];

const keyStartSourceNeedles = [
  'ignition key',
  'key switch',
  'turn the key',
  'turned by key',
  'starts with a key',
  'ключ зажигания',
  'ключ электростартера',
  'ключом электростартера',
  'поворот ключ',
  'поворотом ключ',
  'поверните ключ',
  'запуск ключом',
  'замок зажигания'
];

const sparkPlugWrenchNeedles = [
  'spark plug wrench',
  'plug wrench',
  'свечной ключ',
  'свечного ключа',
  'свечным ключом'
];

const buttonStartNeedles = [
  'push button',
  'button start',
  'start button',
  'electric start button',
  'кнопка запуска',
  'кнопочный запуск',
  'запуск кнопкой',
  'кнопкой запуска',
  'нажатием кнопки'
];

const switchStartNeedles = [
  'engine switch',
  'ignition switch',
  'starter switch',
  'start switch',
  'switch to start',
  'switch turned',
  'switch held in start',
  'выключатель зажигания',
  'выключатель двигателя',
  'переключатель start',
  'положение start',
  'положение старт',
  'тумблер запуска',
  'тумблер'
];

function startControlMechanismQuestionRelevant(userMessage: string, comparisonAttributes: string[]) {
  return textIncludesAny([userMessage, ...comparisonAttributes].join(' '), controlSearchQuestionNeedles);
}

function coverageItemText(item: ResearchCoverageItem) {
  return [item.attribute, item.value, item.evidence].join(' ');
}

function resultConfirmsElectricStarter(result: ProductComparisonResearchResult) {
  return result.answerGuidance.coverage.some((item) =>
    item.status === 'confirmed' &&
    textIncludesAny(coverageItemText(item), electricStarterNeedles)
  ) || result.facts.some((fact) =>
    ['high', 'medium'].includes(fact.confidence) &&
    textIncludesAny([fact.attribute, fact.value, fact.evidence].join(' '), electricStarterNeedles)
  );
}

function resultConfirmsPracticalStartControl(result: ProductComparisonResearchResult) {
  return result.answerGuidance.coverage.some((item) =>
    item.status === 'confirmed' &&
    textIncludesAny(coverageItemText(item), practicalStartControlNeedles)
  ) || result.facts.some((fact) =>
    ['high', 'medium'].includes(fact.confidence) &&
    textIncludesAny([fact.attribute, fact.value, fact.evidence].join(' '), practicalStartControlNeedles)
  );
}

function needsElectricStarterControlSearch(input: {
  result: ProductComparisonResearchResult;
  userMessage: string;
  comparisonAttributes: string[];
}) {
  return startControlMechanismQuestionRelevant(input.userMessage, input.comparisonAttributes) &&
    resultConfirmsElectricStarter(input.result) &&
    !resultConfirmsPracticalStartControl(input.result);
}

function compactEvidence(value: unknown, limit = 220) {
  const text = String(value ?? '').trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function scalarCatalogEntries(value: unknown, prefix: string): Array<{ path: string; value: string }> {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [{ path: prefix, value: String(value) }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => scalarCatalogEntries(item, `${prefix}[${index}]`));
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      scalarCatalogEntries(item, prefix ? `${prefix}.${key}` : key)
    );
  }
  return [];
}

function manualStarterEvidenceFromProduct(product: Product) {
  const evidence: string[] = [];
  for (const entry of scalarCatalogEntries(product.specs, 'specs')) {
    const combined = `${entry.path} ${entry.value}`;
    if (textIncludesAny(combined, starterFieldNeedles) && textIncludesAny(combined, manualStarterNeedles)) {
      evidence.push(`${entry.path}: ${compactEvidence(entry.value)}`);
    }
  }
  if (
    typeof product.description === 'string' &&
    textIncludesAny(product.description, starterFieldNeedles) &&
    textIncludesAny(product.description, manualStarterNeedles)
  ) {
    evidence.push(`description: ${compactEvidence(product.description)}`);
  }
  return uniqueStrings(evidence);
}

function resultAlreadyHasSeparateManualStarterFact(result: ProductComparisonResearchResult) {
  const factTexts = result.facts.map((fact) => [fact.attribute, fact.value].join(' '));
  const coverageTexts = result.answerGuidance.coverage
    .filter((item) => item.status === 'confirmed')
    .map((item) => [item.attribute, item.value].join(' '));
  return [...factTexts, ...coverageTexts].some((text) => textIncludesAny(text, manualStarterNeedles));
}

function factKey(fact: ProductComparisonResearchFact) {
  return [
    fact.productName,
    fact.attribute,
    fact.value,
    fact.sourceType,
    fact.evidence,
    fact.sourceUrl ?? ''
  ].join('|');
}

function coverageKey(item: ResearchCoverageItem) {
  return [
    item.attribute,
    item.status,
    item.value,
    item.evidence,
    item.sourceUrl ?? ''
  ].join('|');
}

function uniqueFacts(facts: ProductComparisonResearchFact[]) {
  const seen = new Set<string>();
  const output: ProductComparisonResearchFact[] = [];
  for (const fact of facts) {
    const key = factKey(fact);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(fact);
  }
  return output;
}

function uniqueCoverage(items: ResearchCoverageItem[]) {
  const seen = new Set<string>();
  const output: ResearchCoverageItem[] = [];
  for (const item of items) {
    const key = coverageKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function exactTargetAliases(target: string) {
  const tokens = exactTargetTokens(target);
  const modelTokens = tokens.filter((token) => tokenHasDigit(token) && tokenHasLetter(token));
  return uniqueStrings([
    `"${target}"`,
    target,
    ...modelTokens,
    ...modelTokens.map((token) => `"${token}"`)
  ]);
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

function isExactTargetTokenChar(char: string) {
  return isAsciiDigit(char) || isAsciiLetter(char) || isCyrillicLetter(char);
}

function tokenHasDigit(token: string) {
  for (const char of token) {
    if (isAsciiDigit(char)) return true;
  }
  return false;
}

function tokenHasLetter(token: string) {
  for (const char of token) {
    if (isAsciiLetter(char) || isCyrillicLetter(char)) return true;
  }
  return false;
}

function exactTargetTokens(value: unknown) {
  const tokens: string[] = [];
  let current = '';
  for (const char of String(value ?? '').normalize('NFKD').toLocaleLowerCase('ru-RU')) {
    if (isExactTargetTokenChar(char)) {
      current += char;
    } else if (current) {
      tokens.push(current);
      current = '';
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function compactExactTargetText(value: unknown) {
  let compact = '';
  for (const char of String(value ?? '').normalize('NFKD').toLocaleLowerCase('ru-RU')) {
    if (isExactTargetTokenChar(char)) compact += char;
  }
  return compact;
}

function factMatchesTarget(fact: ProductComparisonResearchFact, targetName: string) {
  const factText = compactExactTargetText([fact.productName, fact.sourceUrl, fact.sourceTitle, fact.evidence].filter(Boolean).join(' '));
  const targetText = compactExactTargetText(targetName);
  const targetTokens = exactTargetAliases(targetName)
    .map(compactExactTargetText)
    .filter((token) => token.length >= 4 && tokenHasDigit(token));
  if (targetTokens.length) return targetTokens.some((token) => factText.includes(token));
  return targetText.length >= 5 && factText.includes(targetText);
}

function hasConfirmedAnswerCoverage(result: ProductComparisonResearchResult) {
  return result.answerGuidance.coverage.some((item) =>
    item.status === 'confirmed' &&
    Boolean(item.value.trim() || item.evidence.trim())
  );
}

function hasConfirmedExactTargetFacts(
  result: ProductComparisonResearchResult,
  targetProductNames: string[],
  sourceTypes: Array<ProductComparisonResearchFact['sourceType']> = ['web']
) {
  if (!hasConfirmedAnswerCoverage(result)) return false;
  return result.facts.some((fact) =>
    sourceTypes.includes(fact.sourceType) &&
    ['high', 'medium'].includes(fact.confidence) &&
    targetProductNames.some((targetName) => factMatchesTarget(fact, targetName))
  );
}

function defaultAnswerGuidance(): ProductComparisonResearchAnswerGuidance {
  return {
    directAnswer: '',
    completeness: 'not_answered',
    coverage: []
  };
}

function normalizeAnswerGuidance(value: unknown): ProductComparisonResearchAnswerGuidance {
  if (!value || typeof value !== 'object') return defaultAnswerGuidance();
  const raw = value as Record<string, unknown>;
  const completeness = raw.completeness === 'answered' ||
    raw.completeness === 'partially_answered' ||
    raw.completeness === 'not_answered'
    ? raw.completeness
    : 'not_answered';
  const allowedStatuses = new Set(['confirmed', 'not_confirmed', 'contradicted', 'ambiguous', 'not_found']);
  const coverage = Array.isArray(raw.coverage)
    ? raw.coverage
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
        .map((item) => ({
          attribute: typeof item.attribute === 'string' ? item.attribute : '',
          status: allowedStatuses.has(String(item.status)) ? item.status as ProductComparisonResearchAnswerGuidance['coverage'][number]['status'] : 'not_found',
          value: typeof item.value === 'string' ? item.value : '',
          evidence: typeof item.evidence === 'string' ? item.evidence : '',
          sourceUrl: typeof item.sourceUrl === 'string' ? item.sourceUrl : undefined,
          sourceTitle: typeof item.sourceTitle === 'string' ? item.sourceTitle : undefined
        }))
        .filter((item) => item.attribute || item.value || item.evidence)
    : [];
  return {
    directAnswer: typeof raw.directAnswer === 'string' ? raw.directAnswer : '',
    completeness,
    coverage
  };
}

function normalizeResearchParsed(parsed: Record<string, unknown>): ProductComparisonResearchResult {
  return {
    usedWebSearch: parsed.usedWebSearch === true,
    facts: Array.isArray(parsed.facts)
      ? (parsed.facts as Array<ProductComparisonResearchFact & { sourceUrl?: string | null; sourceTitle?: string | null }>).map((fact) => ({
          ...fact,
          sourceUrl: typeof fact.sourceUrl === 'string' ? fact.sourceUrl : undefined,
          sourceTitle: typeof fact.sourceTitle === 'string' ? fact.sourceTitle : undefined
        }))
      : [],
    conflicts: Array.isArray(parsed.conflicts)
      ? (parsed.conflicts as Array<ProductComparisonResearchConflict & { catalogValue?: string | null }>).map((conflict) => ({
          ...conflict,
          catalogValue: typeof conflict.catalogValue === 'string' ? conflict.catalogValue : undefined
        }))
      : [],
    answerGuidance: normalizeAnswerGuidance(parsed.answerGuidance),
    summaryForAnswer: typeof parsed.summaryForAnswer === 'string' ? parsed.summaryForAnswer : '',
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((item): item is string => typeof item === 'string') : []
  };
}

const sourceTextLimit = 250000;
const sourceVisualCandidateLimit = 8;
const sourceVisualImageByteLimit = 5_000_000;

type SourceVisualCandidate = {
  imageUrl: string;
  sourceUrl: string;
  sourceTitle?: string;
  context: string;
  score: number;
};

type SourceDocument = {
  ok: boolean;
  text: string;
  warning?: string;
  media: SourceVisualCandidate[];
  sourceTitle?: string;
};

type SourceTextCache = Map<string, Promise<SourceDocument>>;
type SourceCheerioElement = ReturnType<cheerio.CheerioAPI>;

type SourceVisualInputCandidate = SourceVisualCandidate & {
  openAiImageUrl: string;
};

function isWhitespaceChar(char: string) {
  return char.trim() === '';
}

function collapseWhitespace(value: unknown) {
  let output = '';
  let pendingSpace = false;
  for (const char of String(value ?? '')) {
    if (isWhitespaceChar(char)) {
      pendingSpace = output.length > 0;
      continue;
    }
    if (pendingSpace) {
      output += ' ';
      pendingSpace = false;
    }
    output += char;
  }
  return output.trim();
}

function limitSourceText(value: unknown) {
  const text = collapseWhitespace(value);
  return text.length > sourceTextLimit ? text.slice(0, sourceTextLimit) : text;
}

function sourceUrlIsHttp(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function sourceLooksLikePdf(sourceUrl: string, contentType: string) {
  if (normalizedText(contentType).includes('pdf')) return true;
  try {
    return new URL(sourceUrl).pathname.toLocaleLowerCase('en-US').endsWith('.pdf');
  } catch {
    return sourceUrl.toLocaleLowerCase('en-US').includes('.pdf');
  }
}

const imageUrlAttributes = [
  'src',
  'data-src',
  'data-original',
  'data-lazy-src',
  'data-large_image',
  'href'
];

const sourceVisualContextNeedles = [
  ...practicalStartControlNeedles,
  ...electricStarterNeedles,
  ...starterFieldNeedles,
  'control panel',
  'front panel',
  'operator panel',
  'photo',
  'image',
  'picture',
  'battery',
  'панель управления',
  'фото',
  'изображение',
  'аккумулятор'
];

function sourceTitleFromHtml($: cheerio.CheerioAPI) {
  return collapseWhitespace($('title').first().text() || $('h1').first().text());
}

function resolveHttpUrl(value: unknown, baseUrl: string) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const trimmed = value.trim();
  if (trimmed.startsWith('data:')) return '';
  try {
    const url = new URL(trimmed, baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function firstSrcsetUrl(value: unknown) {
  if (typeof value !== 'string') return '';
  const first = value.split(',').map((item) => item.trim()).filter(Boolean)[0];
  return first ? first.split(' ').map((item) => item.trim()).filter(Boolean)[0] ?? '' : '';
}

function imageElementUrls($element: SourceCheerioElement, baseUrl: string) {
  const values: string[] = [];
  for (const attribute of imageUrlAttributes) {
    const value = $element.attr(attribute);
    if (attribute === 'href' && !$element.is('a')) continue;
    if (value) values.push(value);
  }
  const srcset = firstSrcsetUrl($element.attr('srcset') ?? $element.attr('data-srcset'));
  if (srcset) values.push(srcset);
  return uniqueStrings(values.map((value) => resolveHttpUrl(value, baseUrl)).filter(Boolean));
}

function sourceVisualCandidateScore(context: string) {
  let score = 0;
  if (textIncludesAny(context, practicalStartControlNeedles)) score += 6;
  if (textIncludesAny(context, electricStarterNeedles)) score += 5;
  if (textIncludesAny(context, starterFieldNeedles)) score += 3;
  if (textIncludesAny(context, sourceVisualContextNeedles)) score += 2;
  return score;
}

function imageContext($element: SourceCheerioElement, imageUrl: string, sourceTitle: string) {
  const parts = [
    sourceTitle,
    imageUrl,
    $element.attr('alt'),
    $element.attr('title'),
    $element.attr('aria-label')
  ];
  let parent = $element.parent();
  for (let depth = 0; depth < 4 && parent.length; depth += 1) {
    const text = collapseWhitespace(parent.text());
    if (text) parts.push(text);
    parent = parent.parent();
  }
  return compactEvidence(collapseWhitespace(parts.filter(Boolean).join(' ')), 1200);
}

function collectSourceVisualCandidates($: cheerio.CheerioAPI, sourceUrl: string, sourceTitle: string) {
  const seen = new Set<string>();
  const candidates: SourceVisualCandidate[] = [];
  $('img, source, a').each((_, element) => {
    const $element = $(element);
    const urls = imageElementUrls($element, sourceUrl);
    for (const imageUrl of urls) {
      if (seen.has(imageUrl)) continue;
      const context = imageContext($element, imageUrl, sourceTitle);
      const score = sourceVisualCandidateScore(context);
      seen.add(imageUrl);
      candidates.push({
        imageUrl,
        sourceUrl,
        sourceTitle: sourceTitle || undefined,
        context,
        score
      });
    }
  });
  return candidates
    .sort((left, right) => right.score - left.score)
    .slice(0, sourceVisualCandidateLimit);
}

function imageMimeTypeFromUrl(value: string) {
  try {
    const pathname = new URL(value).pathname.toLocaleLowerCase('en-US');
    if (pathname.endsWith('.png')) return 'image/png';
    if (pathname.endsWith('.webp')) return 'image/webp';
    if (pathname.endsWith('.gif')) return 'image/gif';
    if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  } catch {
    // Fall through to the default.
  }
  return 'image/jpeg';
}

function supportedImageMimeType(value: unknown, imageUrl: string) {
  const contentType = typeof value === 'string'
    ? value.split(';')[0]?.trim().toLocaleLowerCase('en-US') ?? ''
    : '';
  if (['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'].includes(contentType)) {
    return contentType === 'image/jpg' ? 'image/jpeg' : contentType;
  }
  return imageMimeTypeFromUrl(imageUrl);
}

async function sourceVisualInputCandidate(candidate: SourceVisualCandidate, signal?: AbortSignal): Promise<SourceVisualInputCandidate | null> {
  try {
    const response = await fetch(candidate.imageUrl, {
      signal,
      headers: {
        'user-agent': 'Mozilla/5.0 BAKAUT source visual evidence verifier'
      }
    });
    if (!response.ok) return null;
    const mimeType = supportedImageMimeType(response.headers.get('content-type'), candidate.imageUrl);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > sourceVisualImageByteLimit) return null;
    return {
      ...candidate,
      openAiImageUrl: `data:${mimeType};base64,${bytes.toString('base64')}`
    };
  } catch {
    return null;
  }
}

async function sourceVisualInputCandidates(candidates: SourceVisualCandidate[], signal?: AbortSignal) {
  const output: SourceVisualInputCandidate[] = [];
  for (const candidate of candidates) {
    const inputCandidate = await sourceVisualInputCandidate(candidate, signal);
    if (inputCandidate) output.push(inputCandidate);
  }
  return output;
}

function htmlToSourceDocument(html: string, sourceUrl: string): SourceDocument {
  const $ = cheerio.load(html);
  const sourceTitle = sourceTitleFromHtml($);
  const media = collectSourceVisualCandidates($, sourceUrl, sourceTitle);
  $('script, style, noscript, svg').remove();
  return {
    ok: true,
    text: limitSourceText($('body').text() || $.root().text() || html),
    media,
    sourceTitle: sourceTitle || undefined
  };
}

async function pdfToSourceText(data: ArrayBuffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = getDocument({
    data: new Uint8Array(data),
    disableFontFace: true,
    isEvalSupported: false,
    useWorkerFetch: false
  });
  const pdf = await loadingTask.promise;
  const parts: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (typeof item.str === 'string' && item.str.trim()) parts.push(item.str);
      }
      if (parts.join(' ').length > sourceTextLimit) break;
    }
  } finally {
    await pdf.destroy?.();
  }
  return limitSourceText(parts.join(' '));
}

async function fetchSourceText(sourceUrl: string, cache: SourceTextCache, signal?: AbortSignal) {
  const cached = cache.get(sourceUrl);
  if (cached) return cached;
  const promise = (async () => {
    try {
      const response = await fetch(sourceUrl, {
        signal,
        headers: {
          'user-agent': 'Mozilla/5.0 BAKAUT source evidence verifier'
        }
      });
      if (!response.ok) return { ok: false, text: '', media: [], warning: 'source_evidence_fetch_failed' };
      const contentType = response.headers.get('content-type') ?? '';
      const source = sourceLooksLikePdf(sourceUrl, contentType)
        ? { ok: true, text: await pdfToSourceText(await response.arrayBuffer()), media: [] }
        : htmlToSourceDocument(await response.text(), sourceUrl);
      return source.text
        ? source
        : { ok: false, text: '', media: source.media, sourceTitle: source.sourceTitle, warning: 'source_evidence_empty' };
    } catch {
      return { ok: false, text: '', media: [], warning: 'source_evidence_fetch_failed' };
    }
  })();
  cache.set(sourceUrl, promise);
  return promise;
}

function normalizedUrlForCompare(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    return new URL(value).href.toLocaleLowerCase('en-US');
  } catch {
    return normalizedText(value);
  }
}

function productSourceText(product: Product) {
  const specLines = scalarCatalogEntries(product.specs, 'specs')
    .map((entry) => `${entry.path}: ${entry.value}`);
  return limitSourceText([
    product.name,
    product.brand,
    product.category,
    product.sourceUrl,
    ...specLines,
    product.description
  ].filter(Boolean).join('\n'));
}

function catalogProductForEvidenceItem(input: {
  products: Product[];
  targetProductNames: string[];
  productName?: string;
  sourceUrl?: string;
  sourceTitle?: string;
}) {
  const sourceUrl = normalizedUrlForCompare(input.sourceUrl);
  if (sourceUrl) {
    const byUrl = input.products.find((product) =>
      normalizedUrlForCompare(product.sourceUrl) === sourceUrl
    );
    if (byUrl) return byUrl;
  }

  const sourceNames = [input.productName, input.sourceTitle].filter((value): value is string =>
    typeof value === 'string' && Boolean(value.trim())
  );
  for (const name of sourceNames) {
    const byName = input.products.find((product) => productMatchesExactTarget(product, name));
    if (byName) return byName;
  }

  if (input.products.length === 1 && input.targetProductNames.some((target) =>
    productMatchesExactTarget(input.products[0], target)
  )) {
    return input.products[0];
  }
  return null;
}

type SourceEvidenceItem = {
  productName?: string;
  attribute: string;
  value: string;
  evidence: string;
  sourceType?: ProductComparisonResearchFact['sourceType'];
  sourceUrl?: string;
  sourceTitle?: string;
};

async function evidenceItemSourceText(input: {
  item: SourceEvidenceItem;
  products: Product[];
  targetProductNames: string[];
  cache: SourceTextCache;
  signal?: AbortSignal;
}) {
  const catalogProduct = catalogProductForEvidenceItem({
    products: input.products,
    targetProductNames: input.targetProductNames,
    productName: input.item.productName,
    sourceUrl: input.item.sourceUrl,
    sourceTitle: input.item.sourceTitle
  });
  if (input.item.sourceType === 'catalog' || (catalogProduct && !input.item.sourceType)) {
    if (!catalogProduct) return { ok: false, text: '', media: [], warning: 'source_evidence_catalog_source_missing' };
    return { ok: true, text: productSourceText(catalogProduct), media: [] };
  }
  if (sourceUrlIsHttp(input.item.sourceUrl)) {
    return fetchSourceText(input.item.sourceUrl, input.cache, input.signal);
  }
  if (catalogProduct) return { ok: true, text: productSourceText(catalogProduct), media: [] };
  return { ok: false, text: '', media: [], warning: 'source_evidence_source_url_missing' };
}

function startClaimKindsFromText(value: unknown): SourceBackedStartKind[] {
  const text = String(value ?? '');
  const kinds: SourceBackedStartKind[] = [];
  if (textIncludesAny(text, keyStartClaimNeedles)) kinds.push('key_start');
  if (textIncludesAny(text, buttonStartNeedles)) kinds.push('button_start');
  if (textIncludesAny(text, switchStartNeedles)) kinds.push('switch_start');
  if (textIncludesAny(text, electricStarterNeedles)) kinds.push('electric_start');
  if (textIncludesAny(text, manualStarterNeedles)) kinds.push('manual_starter');
  return sourceBackedStartKinds.filter((kind) => kinds.includes(kind));
}

function sourceSupportsStartKind(sourceText: string, kind: SourceBackedStartKind) {
  if (kind === 'key_start') {
    const hasIgnitionKeyEvidence = textIncludesAny(sourceText, keyStartSourceNeedles);
    if (textIncludesAny(sourceText, sparkPlugWrenchNeedles) && !hasIgnitionKeyEvidence) return false;
    return hasIgnitionKeyEvidence;
  }
  if (kind === 'button_start') return textIncludesAny(sourceText, buttonStartNeedles);
  if (kind === 'switch_start') return textIncludesAny(sourceText, switchStartNeedles);
  if (kind === 'electric_start') return textIncludesAny(sourceText, electricStarterNeedles);
  return textIncludesAny(sourceText, manualStarterNeedles);
}

function sourceTextMatchesTarget(input: {
  sourceText: string;
  item: SourceEvidenceItem;
  targetProductNames: string[];
}) {
  if (!input.targetProductNames.length) return true;
  const haystack = compactExactTargetText([
    input.item.sourceUrl,
    input.item.sourceTitle,
    input.sourceText
  ].filter(Boolean).join(' '));
  return input.targetProductNames.some((targetName) => {
    const targetTokens = exactTargetAliases(targetName)
      .map(compactExactTargetText)
      .filter((token) => token.length >= 4 && tokenHasDigit(token));
    return targetTokens.length
      ? targetTokens.some((token) => haystack.includes(token))
      : haystack.includes(compactExactTargetText(targetName));
  });
}

async function validateStartEvidenceItem(input: {
  item: SourceEvidenceItem;
  products: Product[];
  targetProductNames: string[];
  cache: SourceTextCache;
  signal?: AbortSignal;
}) {
  const claimKinds = startClaimKindsFromText([
    input.item.attribute,
    input.item.value,
    input.item.evidence
  ].join(' '));
  if (!claimKinds.length) return { valid: true, invalidKinds: [] as SourceBackedStartKind[], warnings: [] as string[] };

  const source = await evidenceItemSourceText(input);
  const warnings: string[] = [];
  if (source.warning) warnings.push(source.warning);
  if (!source.ok) {
    return {
      valid: false,
      invalidKinds: claimKinds,
      warnings: uniqueStrings([
        ...warnings,
        ...claimKinds.map((kind) => `source_evidence_validation_failed:${kind}`)
      ])
    };
  }

  if (!sourceTextMatchesTarget({ sourceText: source.text, item: input.item, targetProductNames: input.targetProductNames })) {
    return {
      valid: false,
      invalidKinds: claimKinds,
      warnings: uniqueStrings([
        ...warnings,
        'source_evidence_exact_target_not_found',
        ...claimKinds.map((kind) => `source_evidence_validation_failed:${kind}`)
      ])
    };
  }

  const invalidKinds = claimKinds.filter((kind) => !sourceSupportsStartKind(source.text, kind));
  return {
    valid: invalidKinds.length === 0,
    invalidKinds,
    warnings: uniqueStrings([
      ...warnings,
      ...invalidKinds.map((kind) => `source_evidence_validation_failed:${kind}`)
    ])
  };
}

const visualStartControlKinds = ['key_start', 'button_start', 'switch_start'] as const;
type VisualStartControlKind = typeof visualStartControlKinds[number];

type VisualStartControlEvidence = {
  kind: VisualStartControlKind;
  confidence: 'high' | 'medium';
  evidence: string;
  imageUrl: string;
  sourceUrl: string;
  sourceTitle?: string;
};

function visualStartControlJsonFormat() {
  return {
    format: {
      type: 'json_schema',
      name: 'source_visual_start_control_validation',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          confirmedControls: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', enum: [...visualStartControlKinds] },
                confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                evidence: { type: 'string' },
                imageUrl: { type: 'string' },
                sourceUrl: { type: 'string' },
                sourceTitle: { type: ['string', 'null'] }
              },
              required: ['kind', 'confidence', 'evidence', 'imageUrl', 'sourceUrl', 'sourceTitle']
            }
          },
          warnings: { type: 'array', items: { type: 'string' } }
        },
        required: ['confirmedControls', 'warnings']
      }
    }
  } as const;
}

function visualStartControlAttribute(kind: VisualStartControlKind) {
  if (kind === 'key_start') return 'key start';
  if (kind === 'button_start') return 'button start';
  return 'start switch';
}

function visualStartControlValue(kind: VisualStartControlKind) {
  if (kind === 'key_start') return 'ignition key / key switch';
  if (kind === 'button_start') return 'push-button start';
  return 'START switch';
}

function sourceEvidenceItemsForVisualCheck(result: ProductComparisonResearchResult): SourceEvidenceItem[] {
  const items: SourceEvidenceItem[] = [];
  for (const fact of result.facts) {
    if (fact.sourceType === 'web' && sourceUrlIsHttp(fact.sourceUrl)) items.push(fact);
  }
  return items;
}

async function collectVisualStartControlCandidates(input: {
  result: ProductComparisonResearchResult;
  products: Product[];
  targetProductNames: string[];
  cache: SourceTextCache;
  signal?: AbortSignal;
}) {
  const seen = new Set<string>();
  const candidates: SourceVisualCandidate[] = [];
  for (const item of sourceEvidenceItemsForVisualCheck(input.result)) {
    const source = await evidenceItemSourceText({
      item,
      products: input.products,
      targetProductNames: input.targetProductNames,
      cache: input.cache,
      signal: input.signal
    });
    if (!source.ok || !source.media.length) continue;
    if (!sourceTextMatchesTarget({ sourceText: source.text, item, targetProductNames: input.targetProductNames })) continue;
    for (const candidate of source.media) {
      if (seen.has(candidate.imageUrl)) continue;
      seen.add(candidate.imageUrl);
      candidates.push(candidate);
    }
  }
  return candidates
    .sort((left, right) => right.score - left.score)
    .slice(0, sourceVisualCandidateLimit);
}

function normalizeVisualStartControlValidation(
  parsed: Record<string, unknown>,
  candidates: SourceVisualCandidate[]
): { controls: VisualStartControlEvidence[]; warnings: string[] } {
  const candidatesByImageUrl = new Map(candidates.map((candidate) => [
    normalizedUrlForCompare(candidate.imageUrl),
    candidate
  ]));
  const controls = Array.isArray(parsed.confirmedControls)
    ? parsed.confirmedControls
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
        .flatMap((item): VisualStartControlEvidence[] => {
          const kind = visualStartControlKinds.includes(item.kind as VisualStartControlKind)
            ? item.kind as VisualStartControlKind
            : null;
          const confidence = item.confidence === 'high' || item.confidence === 'medium'
            ? item.confidence
            : null;
          const imageUrl = typeof item.imageUrl === 'string' ? item.imageUrl : '';
          const candidate = candidatesByImageUrl.get(normalizedUrlForCompare(imageUrl));
          if (!kind || !confidence || !candidate) return [];
          return [{
            kind,
            confidence,
            evidence: typeof item.evidence === 'string' ? item.evidence : '',
            imageUrl: candidate.imageUrl,
            sourceUrl: candidate.sourceUrl,
            sourceTitle: candidate.sourceTitle
          }];
        })
    : [];
  return {
    controls,
    warnings: Array.isArray(parsed.warnings)
      ? parsed.warnings.filter((item): item is string => typeof item === 'string')
      : []
  };
}

function visualModelCandidates() {
  return uniqueStrings([
    config.OPENAI_VISION_MODEL,
    'gpt-4o-mini',
    'gpt-4.1-mini',
    config.OPENAI_FACT_MODEL
  ]);
}

function visualValidationErrorWarning(model: string, error: unknown) {
  const details = safeError(error);
  const reason = details.code ?? details.status ?? details.message ?? 'unknown';
  return `source_visual_start_control_validation_failed:${model}:${reason}`;
}

async function validateVisualStartControlEvidence(input: {
  result: ProductComparisonResearchResult;
  products: Product[];
  targetProductNames: string[];
  userMessage: string;
  comparisonAttributes: string[];
  cache: SourceTextCache;
  signal?: AbortSignal;
}): Promise<{
  facts: ProductComparisonResearchFact[];
  coverage: ResearchCoverageItem[];
  warnings: string[];
}> {
  if (!needsElectricStarterControlSearch(input)) return { facts: [], coverage: [], warnings: [] };
  const candidates = await collectVisualStartControlCandidates(input);
  if (!candidates.length) return { facts: [], coverage: [], warnings: [] };
  const imageCandidates = await sourceVisualInputCandidates(candidates, input.signal);
  if (!imageCandidates.length) return { facts: [], coverage: [], warnings: ['source_visual_start_control_image_fetch_failed'] };
  const content: Array<Record<string, unknown>> = [
    {
      type: 'input_text',
      text: JSON.stringify({
        buyerQuestion: input.userMessage,
        targetProductNames: input.targetProductNames,
        comparisonAttributes: input.comparisonAttributes,
        rule: [
          'Use only the attached images and their exact source-page context.',
          'Confirm key_start only when the image visibly shows a keyed ignition/key switch, key slot, or keyed START control.',
          'Confirm button_start only when the image visibly shows a push-button start control.',
          'Confirm switch_start only when the image visibly shows a non-key START/engine/starter switch.',
          'Electric starter, battery, starter text, or a generic feature icon alone is not key/button/switch proof.',
          'If the image is unclear, generic, or not tied to the exact model source page, return no confirmedControls.'
        ],
        candidates: imageCandidates.map((candidate, index) => ({
          index: index + 1,
          imageUrl: candidate.imageUrl,
          sourceUrl: candidate.sourceUrl,
          sourceTitle: candidate.sourceTitle ?? null,
          context: candidate.context
        }))
      })
    },
    ...imageCandidates.flatMap((candidate, index) => [
      { type: 'input_text', text: `Image ${index + 1}: ${candidate.imageUrl}` },
      { type: 'input_image', image_url: candidate.openAiImageUrl, detail: 'auto' }
    ])
  ];
  const modelErrors: string[] = [];
  for (const model of visualModelCandidates()) {
    try {
      const { parsed } = await createStructuredJsonResponse({
      request: {
        model,
        input: [
          {
            role: 'system',
            content: [
              'You are a strict multimodal source evidence validator for generator start controls.',
              'You do not answer the buyer. You only classify visible controls from exact-target source images.',
              'Never infer key/button/switch from electric starter alone.',
              'Return JSON only.'
            ].join('\n')
          },
          { role: 'user', content }
        ],
        max_output_tokens: Math.min(config.OPENAI_FACT_MAX_OUTPUT_TOKENS, 1200),
        text: visualStartControlJsonFormat()
      },
      stage: 'source_visual_start_control_validation',
      signal: input.signal
    });
      const normalized = normalizeVisualStartControlValidation(parsed, candidates);
      const facts = normalized.controls.map((control): ProductComparisonResearchFact => ({
        productName: input.targetProductNames[0] ?? control.sourceTitle ?? 'exact target product',
        attribute: visualStartControlAttribute(control.kind),
        value: visualStartControlValue(control.kind),
        sourceType: 'web',
        confidence: control.confidence,
        evidence: compactEvidence([control.evidence, `visual source image: ${control.imageUrl}`].filter(Boolean).join('; ')),
        sourceUrl: control.sourceUrl,
        sourceTitle: control.sourceTitle
      }));
      const coverage = normalized.controls.map((control): ResearchCoverageItem => ({
        attribute: visualStartControlAttribute(control.kind),
        status: 'confirmed',
        value: visualStartControlValue(control.kind),
        evidence: compactEvidence([control.evidence, `visual source image: ${control.imageUrl}`].filter(Boolean).join('; ')),
        sourceUrl: control.sourceUrl,
        sourceTitle: control.sourceTitle
      }));
      return {
        facts,
        coverage,
        warnings: uniqueStrings([
          ...modelErrors,
          ...normalized.warnings,
          normalized.controls.length ? 'source_visual_start_control_evidence_used' : 'source_visual_start_control_not_confirmed'
        ])
      };
    } catch (error) {
      modelErrors.push(visualValidationErrorWarning(model, error));
    }
  }
  return {
    facts: [],
    coverage: [],
    warnings: uniqueStrings(['source_visual_start_control_validation_failed', ...modelErrors])
  };
}

function confirmedStartKinds(result: ProductComparisonResearchResult) {
  const kinds: SourceBackedStartKind[] = [];
  for (const item of result.answerGuidance.coverage) {
    if (item.status === 'confirmed') kinds.push(...startClaimKindsFromText(coverageItemText(item)));
  }
  for (const fact of result.facts) {
    if (['high', 'medium'].includes(fact.confidence)) {
      kinds.push(...startClaimKindsFromText([fact.attribute, fact.value, fact.evidence].join(' ')));
    }
  }
  return new Set(sourceBackedStartKinds.filter((kind) => kinds.includes(kind)));
}

function sourceBackedStartDirectAnswer(result: ProductComparisonResearchResult) {
  const kinds = confirmedStartKinds(result);
  const hasElectric = kinds.has('electric_start');
  const hasManual = kinds.has('manual_starter');
  if (kinds.has('key_start')) {
    return hasManual
      ? 'Запускается с ключа, через электростартер. Ручной запуск тоже есть.'
      : 'Запускается с ключа, через электростартер.';
  }
  if (kinds.has('button_start')) {
    return hasManual
      ? 'Кнопочный запуск подтвержден. Ручной запуск тоже есть.'
      : 'Кнопочный запуск подтвержден.';
  }
  if (kinds.has('switch_start')) {
    return hasManual
      ? 'Электростартер включается через переключатель/выключатель START. Ручной запуск тоже есть.'
      : 'Электростартер включается через переключатель/выключатель START.';
  }
  if (hasElectric && hasManual) {
    return 'Электростартер есть, ручной запуск тоже есть. А вот чем включается электростартер — ключом, кнопкой или переключателем — источники не подтвердили.';
  }
  if (hasElectric) {
    return 'Электростартер есть. А вот чем он включается — ключом, кнопкой или переключателем — источники не подтвердили.';
  }
  if (hasManual) {
    return 'Ручной запуск есть. Электрозапуск и его управление источники не подтвердили.';
  }
  return 'По точному способу запуска источники не дали подтверждения.';
}

function sourceBackedStartCompleteness(result: ProductComparisonResearchResult) {
  const kinds = confirmedStartKinds(result);
  if (kinds.has('key_start') || kinds.has('button_start') || kinds.has('switch_start')) return 'answered';
  if (kinds.has('electric_start') || kinds.has('manual_starter')) return 'partially_answered';
  return 'not_answered';
}

async function validateSourceBackedResult(input: {
  result: ProductComparisonResearchResult;
  products: Product[];
  targetProductNames: string[];
  userMessage: string;
  comparisonAttributes: string[];
  signal?: AbortSignal;
}) {
  if (!startControlQuestionRelevant(input.userMessage, input.comparisonAttributes)) return input.result;

  const cache: SourceTextCache = new Map();
  const warnings = [...input.result.warnings];
  const invalidKinds = new Set<SourceBackedStartKind>();
  const facts: ProductComparisonResearchFact[] = [];

  for (const fact of input.result.facts) {
    if (fact.sourceType === 'conflict' || fact.confidence === 'low') {
      facts.push(fact);
      continue;
    }
    const validation = await validateStartEvidenceItem({
      item: fact,
      products: input.products,
      targetProductNames: input.targetProductNames,
      cache,
      signal: input.signal
    });
    warnings.push(...validation.warnings);
    if (!validation.valid) {
      for (const kind of validation.invalidKinds) invalidKinds.add(kind);
      continue;
    }
    facts.push(fact);
  }

  const coverage: ResearchCoverageItem[] = [];
  for (const item of input.result.answerGuidance.coverage) {
    if (item.status !== 'confirmed') {
      coverage.push(item);
      continue;
    }
    const validation = await validateStartEvidenceItem({
      item,
      products: input.products,
      targetProductNames: input.targetProductNames,
      cache,
      signal: input.signal
    });
    warnings.push(...validation.warnings);
    if (!validation.valid) {
      for (const kind of validation.invalidKinds) invalidKinds.add(kind);
      coverage.push({
        ...item,
        status: 'not_confirmed',
        value: '',
        evidence: `source validation did not confirm ${validation.invalidKinds.join(', ')}`
      });
      continue;
    }
    coverage.push(item);
  }

  let adjusted: ProductComparisonResearchResult = {
    ...input.result,
    facts: uniqueFacts(facts),
    answerGuidance: {
      ...input.result.answerGuidance,
      coverage: uniqueCoverage(coverage)
    },
    warnings: uniqueStrings(warnings)
  };

  if (startControlMechanismQuestionRelevant(input.userMessage, input.comparisonAttributes)) {
    const visualValidation = await validateVisualStartControlEvidence({
      result: adjusted,
      products: input.products,
      targetProductNames: input.targetProductNames,
      userMessage: input.userMessage,
      comparisonAttributes: input.comparisonAttributes,
      cache,
      signal: input.signal
    });
    if (visualValidation.facts.length || visualValidation.coverage.length || visualValidation.warnings.length) {
      adjusted = {
        ...adjusted,
        facts: uniqueFacts([...adjusted.facts, ...visualValidation.facts]),
        answerGuidance: {
          ...adjusted.answerGuidance,
          coverage: uniqueCoverage([...adjusted.answerGuidance.coverage, ...visualValidation.coverage])
        },
        warnings: uniqueStrings([...adjusted.warnings, ...visualValidation.warnings])
      };
    }

    const directAnswerKinds = startClaimKindsFromText(adjusted.answerGuidance.directAnswer);
    const directAnswerClaimsInvalidFact = [...invalidKinds].some((kind) => directAnswerKinds.includes(kind));
    const confirmedKindsSet = confirmedStartKinds(adjusted);
    const hasConfirmedStarterFact = confirmedKindsSet.has('electric_start') || confirmedKindsSet.has('manual_starter');
    const lacksConfirmedPracticalControl = !resultConfirmsPracticalStartControl(adjusted);
    const confirmedPracticalKinds = visualStartControlKinds.filter((kind) => confirmedKindsSet.has(kind));
    const directAnswerMissingConfirmedPractical = confirmedPracticalKinds.length > 0 &&
      !confirmedPracticalKinds.some((kind) => directAnswerKinds.includes(kind));
    if (
      directAnswerClaimsInvalidFact ||
      directAnswerMissingConfirmedPractical ||
      (lacksConfirmedPracticalControl && hasConfirmedStarterFact)
    ) {
      adjusted.answerGuidance = {
        ...adjusted.answerGuidance,
        directAnswer: sourceBackedStartDirectAnswer(adjusted),
        completeness: sourceBackedStartCompleteness(adjusted)
      };
      adjusted.warnings = uniqueStrings([
        ...adjusted.warnings,
        'answer_guidance_rewritten_after_source_validation'
      ]);
    }
  }

  return adjusted;
}

function augmentCatalogStarterFacts(input: {
  result: ProductComparisonResearchResult;
  products: Product[];
  userMessage: string;
  comparisonAttributes: string[];
}) {
  if (!startControlQuestionRelevant(input.userMessage, input.comparisonAttributes)) return input.result;
  if (resultAlreadyHasSeparateManualStarterFact(input.result)) return input.result;

  const additions = input.products.flatMap((product) =>
    manualStarterEvidenceFromProduct(product).map((evidence) => ({
      product,
      evidence
    }))
  );
  if (!additions.length) return input.result;

  const facts = additions.map(({ product, evidence }): ProductComparisonResearchFact => ({
    productName: product.name,
    attribute: 'manual starter',
    value: 'есть',
    sourceType: 'catalog',
    confidence: 'high',
    evidence,
    sourceUrl: product.sourceUrl ?? undefined,
    sourceTitle: product.name
  }));
  const coverage = additions.map(({ product, evidence }): ResearchCoverageItem => ({
    attribute: 'manual starter',
    status: 'confirmed',
    value: 'есть',
    evidence,
    sourceUrl: product.sourceUrl ?? undefined,
    sourceTitle: product.name
  }));

  return {
    ...input.result,
    facts: uniqueFacts([...input.result.facts, ...facts]),
    answerGuidance: {
      ...input.result.answerGuidance,
      coverage: uniqueCoverage([...input.result.answerGuidance.coverage, ...coverage])
    },
    warnings: uniqueStrings([...input.result.warnings, 'catalog_starter_specs_extracted'])
  };
}

function productComparisonResearchJsonFormat(name: string) {
  return {
    format: {
      type: 'json_schema',
      name,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          usedWebSearch: { type: 'boolean' },
          facts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                productName: { type: 'string' },
                attribute: { type: 'string' },
                value: { type: 'string' },
                sourceType: { type: 'string', enum: ['catalog', 'web', 'conflict'] },
                confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                evidence: { type: 'string' },
                sourceUrl: { type: ['string', 'null'] },
                sourceTitle: { type: ['string', 'null'] }
              },
              required: ['productName', 'attribute', 'value', 'sourceType', 'confidence', 'evidence', 'sourceUrl', 'sourceTitle']
            }
          },
          conflicts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                productName: { type: 'string' },
                attribute: { type: 'string' },
                catalogValue: { type: ['string', 'null'] },
                webValues: { type: 'array', items: { type: 'string' } },
                resolution: { type: 'string' }
              },
              required: ['productName', 'attribute', 'catalogValue', 'webValues', 'resolution']
            }
          },
          answerGuidance: {
            type: 'object',
            additionalProperties: false,
            properties: {
              directAnswer: { type: 'string' },
              completeness: { type: 'string', enum: ['answered', 'partially_answered', 'not_answered'] },
              coverage: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    attribute: { type: 'string' },
                    status: { type: 'string', enum: ['confirmed', 'not_confirmed', 'contradicted', 'ambiguous', 'not_found'] },
                    value: { type: 'string' },
                    evidence: { type: 'string' },
                    sourceUrl: { type: ['string', 'null'] },
                    sourceTitle: { type: ['string', 'null'] }
                  },
                  required: ['attribute', 'status', 'value', 'evidence', 'sourceUrl', 'sourceTitle']
                }
              }
            },
            required: ['directAnswer', 'completeness', 'coverage']
          },
          summaryForAnswer: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } }
        },
        required: ['usedWebSearch', 'facts', 'conflicts', 'answerGuidance', 'summaryForAnswer', 'warnings']
      }
    }
  } as const;
}

function productMatchesExactTarget(product: Product, targetName: string) {
  const targetTokens = exactTargetTokens(targetName).filter((token) =>
    token.length >= 4 && tokenHasDigit(token) && tokenHasLetter(token)
  );
  if (targetTokens.length) {
    const productTokens = new Set(exactTargetTokens([
      product.name,
      product.brand,
      product.category,
      product.sourceUrl,
      JSON.stringify(product.specs ?? {})
    ].filter(Boolean).join(' ')));
    return targetTokens.every((token) => productTokens.has(token));
  }
  const productText = compactExactTargetText([product.name, product.sourceUrl].filter(Boolean).join(' '));
  const targetText = compactExactTargetText(targetName);
  return targetText.length >= 5 && productText.includes(targetText);
}

function exactCatalogProductsForTargets(products: Product[], targetProductNames: string[]) {
  if (!targetProductNames.length) return [];
  return products.filter((product) =>
    targetProductNames.some((targetName) => productMatchesExactTarget(product, targetName))
  );
}

function resultHasUnresolvedCatalogConflict(result: ProductComparisonResearchResult) {
  return result.conflicts.length > 0 ||
    result.answerGuidance.coverage.some((item) => item.status === 'ambiguous' || item.status === 'contradicted');
}

function catalogExtractionAnswersQuestion(result: ProductComparisonResearchResult, targetProductNames: string[]) {
  return result.answerGuidance.completeness === 'answered' &&
    Boolean(result.answerGuidance.directAnswer.trim()) &&
    hasConfirmedExactTargetFacts(result, targetProductNames, ['catalog']) &&
    !resultHasUnresolvedCatalogConflict(result);
}

function resultHasUsableGuidance(result: ProductComparisonResearchResult) {
  return result.answerGuidance.completeness !== 'not_answered' &&
    Boolean(result.answerGuidance.directAnswer.trim());
}

function mergeCatalogAndWebResearch(
  catalogResult: ProductComparisonResearchResult | null,
  webResult: ProductComparisonResearchResult
): ProductComparisonResearchResult {
  if (!catalogResult) return webResult;
  const primaryAnswerGuidance = resultHasUsableGuidance(webResult)
    ? webResult.answerGuidance
    : catalogResult.answerGuidance;
  const answerGuidance = {
    ...primaryAnswerGuidance,
    coverage: uniqueCoverage([
      ...catalogResult.answerGuidance.coverage,
      ...primaryAnswerGuidance.coverage
    ])
  };
  return {
    usedWebSearch: webResult.usedWebSearch,
    facts: uniqueFacts([...catalogResult.facts, ...webResult.facts]),
    conflicts: [...catalogResult.conflicts, ...webResult.conflicts],
    answerGuidance,
    summaryForAnswer: uniqueStrings([
      catalogResult.summaryForAnswer,
      webResult.summaryForAnswer
    ]).join('\n'),
    warnings: uniqueStrings([
      ...catalogResult.warnings,
      ...webResult.warnings,
      'catalog_fact_extraction_used',
      'catalog_fact_extraction_needed_web_research'
    ])
  };
}

async function extractExactCatalogProductFacts(input: {
  userMessage: string;
  products: Product[];
  targetProductNames: string[];
  comparisonAttributes: string[];
  signal?: AbortSignal;
}): Promise<ProductComparisonResearchResult> {
  if (!input.products.length || !input.targetProductNames.length) {
    return {
      usedWebSearch: false,
      facts: [],
      conflicts: [],
      answerGuidance: defaultAnswerGuidance(),
      summaryForAnswer: '',
      warnings: ['catalog_exact_product_not_available_for_extraction']
    };
  }
  const styleExamples = approvedAnswerStyleExamplesPromptBlock();

  const request: Record<string, unknown> = {
    model: config.OPENAI_FACT_MODEL,
    input: [
      {
        role: 'system',
        content: [
          'Ты внутренний catalog fact extractor AI менеджера БАКАУТ.',
          'Используй только переданные точные карточки каталога БАКАУТ: name, specs, description, sourceUrl.',
          'description является обязательным источником каталожных фактов, а не справочным шумом. Просканируй его полностью вместе со specs.',
          'Извлекай только факты, которые отвечают на buyerQuestion и comparisonAttributes.',
          'Для вопросов key vs push-button/start control ищи практический механизм запуска: ключ, замок, выключатель, положение START, кнопка, электростартер, ручной стартер, аккумулятор.',
          'Если description подтверждает механизм запуска, верни отдельный fact с sourceType="catalog", confidence="high" и evidence с коротким фрагментом смысла из description.',
          'Если specs и description расходятся внутри карточки, добавь conflicts и пометь coverage как ambiguous или contradicted; не делай вывод об отсутствии функции только из молчания.',
          'Если нужного факта нет в карточке, верни not_found/not_confirmed в coverage и warning catalog_fact_missing_needs_web_research.',
          'answerGuidance.directAnswer должен быть коротким техническим ответом для покупателя без фраз "в нашей карточке не указано", без цены, доставки, наличия, формы или внутренних рассуждений.',
          'Пиши directAnswer простым разговорным русским, как знакомый знакомому: без третьего лица, без "В каталоге БАКАУТ", без "по деталям запуска"; если факт не подтвержден, скажи мягко и просто, например "кнопочный запуск в данных не вижу".',
          styleExamples,
          'Не используй web. Верни только JSON.'
        ].join('\n')
      },
      {
        role: 'user',
        content: JSON.stringify({
          buyerQuestion: input.userMessage,
          targetProductNames: input.targetProductNames,
          comparisonAttributes: input.comparisonAttributes,
          products: productResearchContext(input.products)
        })
      }
    ],
    max_output_tokens: config.OPENAI_FACT_MAX_OUTPUT_TOKENS,
    text: productComparisonResearchJsonFormat('catalog_product_fact_extraction')
  };
  const { parsed } = await createStructuredJsonResponse({
    request,
    stage: 'catalog_product_fact_extraction',
    signal: input.signal
  });
  const extracted = augmentCatalogStarterFacts({
    result: {
      ...normalizeResearchParsed(parsed),
      usedWebSearch: false
    },
    products: input.products,
    userMessage: input.userMessage,
    comparisonAttributes: input.comparisonAttributes
  });
  return validateSourceBackedResult({
    result: extracted,
    products: input.products,
    targetProductNames: input.targetProductNames,
    userMessage: input.userMessage,
    comparisonAttributes: input.comparisonAttributes,
    signal: input.signal
  });
}

export async function researchProductComparisonFacts(input: {
  userMessage: string;
  products: Product[];
  targetProductNames?: string[];
  comparisonAttributes?: string[];
  signal?: AbortSignal;
}): Promise<ProductComparisonResearchResult> {
  const targetProductNames = (input.targetProductNames ?? [])
    .map((name) => name.trim())
    .filter(Boolean);
  const comparisonAttributes = (input.comparisonAttributes ?? [])
    .map((name) => name.trim())
    .filter(Boolean);
  if (input.products.length < 2 && !targetProductNames.length) {
    return {
      usedWebSearch: false,
      facts: [],
      conflicts: [],
      answerGuidance: defaultAnswerGuidance(),
      summaryForAnswer: 'Недостаточно товаров для сравнения.',
      warnings: ['not_enough_products_for_comparison']
    };
  }
  const styleExamples = approvedAnswerStyleExamplesPromptBlock();

  const exactCatalogProducts = exactCatalogProductsForTargets(input.products, targetProductNames);
  const catalogResult = exactCatalogProducts.length
    ? await extractExactCatalogProductFacts({
        userMessage: input.userMessage,
        products: exactCatalogProducts,
        targetProductNames,
        comparisonAttributes,
        signal: input.signal
      })
    : null;
  if (catalogResult && catalogExtractionAnswersQuestion(catalogResult, targetProductNames)) {
    return {
      ...catalogResult,
      warnings: uniqueStrings([
        ...catalogResult.warnings,
        'catalog_fact_extraction_used',
        'exact_catalog_description_extracted'
      ])
    };
  }

  const request: Record<string, unknown> = {
    model: config.OPENAI_FACT_MODEL,
    input: [
      {
        role: 'system',
        content: [
          'Ты внутренний research-модуль AI менеджера БАКАУТ.',
          'Сравнивай товары только по проверенным фактам.',
          'Каталог является первым источником. Если важного факта нет или есть конфликт, используй web search.',
          'Если catalogExtraction уже содержит факты из точной карточки БАКАУТ, считай specs и description полноценным каталожным evidence; web нужен, чтобы добрать недостающие детали или проверить конфликт, а не игнорировать карточку.',
          'Если web и каталог конфликтуют по важному параметру, укажи конфликт и выбери значение только при подтверждении логикой источников.',
          'Не пиши ответ покупателю. Верни только JSON.',
          'If buyerQuestion asks about targetProductNames and the exact model is absent from products, search the web for that exact target model. Do not infer exact target facts from nearby models.',
          'When targetProductNames is present, search exact quoted target names on the public web with the requested attributes before using nearby catalog products.',
          'A web fact for a target model is valid only when sourceUrl, sourceTitle, or evidence names the same exact model identifier. Same brand, same family, or nearby model pages are not proof about the target model.',
          'Do not cite bakautprof.ru or provided product.sourceUrl pages as web facts for an absent exact target unless that page is specifically about the exact target model.',
          'If exact external sources state key start, ignition key, electric starter, push button, manual recoil, battery, power, engine, or other requested attributes for the target, return those facts with high or medium confidence.',
          'For binary buyer choices such as key vs push-button, manual vs electric, gasoline vs diesel, continue exact-target web search until each choice is confirmed, contradicted, or explicitly not found in exact-target sources. Do not stop at a broad fact like "electric starter" when the buyer asked about the more specific mechanism.',
          'For key vs push-button generator questions, inspect the practical start-control mechanism. If exact-target sources show an ignition key, ignition switch, engine switch, starter switch, or a switch turned/held in START, return that as the practical control evidence. If only broad electric starter is found, mark key/button control as not_confirmed instead of saying it is not key or not button.',
          'When electric starter is confirmed, actively look for how that electric starter is actuated: official product photos, control-panel images, manuals, image captions, ignition key/switch, starter switch, push button, or START switch. Electric starter alone is not a complete answer to key vs button.',
          'Fill answerGuidance.directAnswer with the shortest practical buyer-facing answer supported by exact-target evidence. Keep it to the requested technical/specification fact only: do not include catalog presence, price, availability, delivery, lead handoff, or nearby model alternatives because the orchestrator adds catalog context from structured data.',
          'The directAnswer must sound like one familiar person answering another in simple Russian: no third-person catalog/report wording, no "В каталоге БАКАУТ", no "по деталям запуска"; say uncertainty plainly, e.g. "кнопочный запуск в данных не вижу".',
          styleExamples,
          'Use nearby catalog products only as catalog alternatives/orientation in summaryForAnswer; never as the technical fact for an absent exact target.',
          'If exact target facts cannot be found externally, return no target fact and add warning exact_target_external_fact_not_found instead of returning nearby-model facts.',
          'For web facts, fill sourceUrl/sourceTitle when the source is available.'
        ].join('\n')
      },
      {
        role: 'user',
        content: JSON.stringify({
          buyerQuestion: input.userMessage,
          targetProductNames,
          comparisonAttributes,
          catalogExtraction: catalogResult,
          exactTargetSearchQueries: exactTargetSearchQueries(targetProductNames, comparisonAttributes),
          products: productResearchContext(input.products)
        })
      }
    ],
    tools: [{ type: 'web_search_preview', search_context_size: targetProductNames.length ? 'high' : 'medium' }],
    max_output_tokens: config.OPENAI_FACT_MAX_OUTPUT_TOKENS,
    text: {
      format: {
        type: 'json_schema',
        name: 'product_comparison_research',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            usedWebSearch: { type: 'boolean' },
            facts: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  productName: { type: 'string' },
                  attribute: { type: 'string' },
                  value: { type: 'string' },
                  sourceType: { type: 'string', enum: ['catalog', 'web', 'conflict'] },
                  confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                  evidence: { type: 'string' },
                  sourceUrl: { type: ['string', 'null'] },
                  sourceTitle: { type: ['string', 'null'] }
                },
                required: ['productName', 'attribute', 'value', 'sourceType', 'confidence', 'evidence', 'sourceUrl', 'sourceTitle']
              }
            },
            conflicts: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  productName: { type: 'string' },
                  attribute: { type: 'string' },
                  catalogValue: { type: ['string', 'null'] },
                  webValues: { type: 'array', items: { type: 'string' } },
                  resolution: { type: 'string' }
                },
                required: ['productName', 'attribute', 'catalogValue', 'webValues', 'resolution']
              }
            },
            answerGuidance: {
              type: 'object',
              additionalProperties: false,
              properties: {
                directAnswer: { type: 'string' },
                completeness: { type: 'string', enum: ['answered', 'partially_answered', 'not_answered'] },
                coverage: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      attribute: { type: 'string' },
                      status: { type: 'string', enum: ['confirmed', 'not_confirmed', 'contradicted', 'ambiguous', 'not_found'] },
                      value: { type: 'string' },
                      evidence: { type: 'string' },
                      sourceUrl: { type: ['string', 'null'] },
                      sourceTitle: { type: ['string', 'null'] }
                    },
                    required: ['attribute', 'status', 'value', 'evidence', 'sourceUrl', 'sourceTitle']
                  }
                }
              },
              required: ['directAnswer', 'completeness', 'coverage']
            },
            summaryForAnswer: { type: 'string' },
            warnings: { type: 'array', items: { type: 'string' } }
          },
          required: ['usedWebSearch', 'facts', 'conflicts', 'answerGuidance', 'summaryForAnswer', 'warnings']
        }
      }
    }
  };

  if (targetProductNames.length) {
    request.tool_choice = { type: 'web_search_preview' };
  }

  const { parsed } = await createStructuredJsonResponse({
    request,
    stage: 'product_comparison_research',
    signal: input.signal
  });
  const primaryResult = await validateSourceBackedResult({
    result: normalizeResearchParsed(parsed),
    products: exactCatalogProducts,
    targetProductNames,
    userMessage: input.userMessage,
    comparisonAttributes,
    signal: input.signal
  });
  const combinedPrimaryResult = mergeCatalogAndWebResearch(catalogResult, primaryResult);
  const electricControlRetryRequired = needsElectricStarterControlSearch({
    result: combinedPrimaryResult,
    userMessage: input.userMessage,
    comparisonAttributes
  });

  if (
    targetProductNames.length &&
    (
      !hasConfirmedExactTargetFacts(combinedPrimaryResult, targetProductNames, ['catalog', 'web']) ||
      combinedPrimaryResult.answerGuidance.completeness !== 'answered' ||
      electricControlRetryRequired
    )
  ) {
    const retryRequest: Record<string, unknown> = {
      ...request,
      input: [
        {
          role: 'system',
          content: [
            'You are a second-pass exact-model web research module for a sales assistant.',
            'The first pass did not fully answer the exact-target question. Search again without nearby catalog product context, but keep catalogExtraction as first-party evidence if it exists.',
            'Use exactTargetSearchQueries and search public web pages, official manufacturer pages, distributor pages, PDFs, manuals, and specification sheets that mention the exact model/code.',
            'Accept a fact only when sourceUrl, sourceTitle, or evidence names the exact target model/code.',
            'If catalogExtraction confirms one option and web does not refute it with stronger exact-target evidence, preserve the catalog fact instead of downgrading it to unknown.',
            'For key vs push-button questions, only explicit ignition/start key wording supports key start. A spark plug wrench or a generic kit wrench is not ignition-key evidence.',
            'If exact-target instructions show an ignition switch, engine switch, starter switch, or a switch turned/held in START, return that practical mechanism in answerGuidance.directAnswer. Do not collapse it to only "electric starter".',
            'If the first pass found an electric starter but did not confirm how it is actuated, perform a dedicated control search: product photos, control-panel photos/images, official image galleries, manuals, PDF diagrams, ignition key, ignition switch, starter switch, push button, START switch, and Russian equivalents.',
            'If photos or manuals clearly show/label a key, ignition switch, push button, or START switch for the exact model, return that control as confirmed with the source. If they only show electric starter without the control, say the electric starter is confirmed but the control type is still not confirmed after exact-target source checks.',
            'Do not use nearby model pages as facts for the target. Return no fact if the exact target still cannot be verified.',
            'Return only JSON.'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            buyerQuestion: input.userMessage,
            targetProductNames,
            comparisonAttributes,
            catalogExtraction: catalogResult,
            exactTargetSearchQueries: exactTargetSearchQueries(targetProductNames, comparisonAttributes)
          })
        }
      ],
      tools: [{ type: 'web_search_preview', search_context_size: 'high' }],
      tool_choice: { type: 'web_search_preview' }
    };
    const retry = await createStructuredJsonResponse({
      request: retryRequest,
      stage: 'product_comparison_research_exact_retry',
      signal: input.signal
    });
    const retryResult = await validateSourceBackedResult({
      result: normalizeResearchParsed(retry.parsed),
      products: exactCatalogProducts,
      targetProductNames,
      userMessage: input.userMessage,
      comparisonAttributes,
      signal: input.signal
    });
    const combinedRetryResult = mergeCatalogAndWebResearch(catalogResult, retryResult);
    const electricControlStillUnresolved = electricControlRetryRequired && needsElectricStarterControlSearch({
      result: combinedRetryResult,
      userMessage: input.userMessage,
      comparisonAttributes
    });
    if (
      hasConfirmedExactTargetFacts(combinedRetryResult, targetProductNames, ['catalog', 'web']) ||
      combinedRetryResult.answerGuidance.completeness === 'answered'
    ) {
      return {
        usedWebSearch: combinedPrimaryResult.usedWebSearch || combinedRetryResult.usedWebSearch,
        facts: combinedRetryResult.facts,
        conflicts: combinedRetryResult.conflicts.length ? combinedRetryResult.conflicts : combinedPrimaryResult.conflicts,
        answerGuidance: resultHasUsableGuidance(combinedRetryResult)
          ? combinedRetryResult.answerGuidance
          : combinedPrimaryResult.answerGuidance,
        summaryForAnswer: combinedRetryResult.summaryForAnswer || combinedPrimaryResult.summaryForAnswer,
        warnings: uniqueStrings([
          ...combinedPrimaryResult.warnings.filter((warning) => warning !== 'exact_target_external_fact_not_found'),
          ...combinedRetryResult.warnings.filter((warning) => warning !== 'exact_target_external_fact_not_found'),
          'exact_target_external_retry_used',
          electricControlRetryRequired ? 'electric_start_control_retry_used' : '',
          electricControlStillUnresolved ? 'electric_start_control_not_confirmed_after_retry' : ''
        ])
      };
    }
    return {
      ...combinedPrimaryResult,
      usedWebSearch: combinedPrimaryResult.usedWebSearch || combinedRetryResult.usedWebSearch,
      warnings: uniqueStrings([
        ...combinedPrimaryResult.warnings.filter((warning) => warning !== 'exact_target_external_fact_not_found'),
        ...combinedRetryResult.warnings.filter((warning) => warning !== 'exact_target_external_fact_not_found'),
        'exact_target_external_retry_used',
        electricControlRetryRequired ? 'electric_start_control_retry_used' : '',
        electricControlRetryRequired ? 'electric_start_control_not_confirmed_after_retry' : ''
      ])
    };
  }

  return combinedPrimaryResult;
}
