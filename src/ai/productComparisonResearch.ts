import { config } from '../config.js';
import type { Product } from '../shared/types.js';
import * as cheerio from 'cheerio';
import { outboundText, safeFetchBytes } from '../security/outboundHttp.js';
import { approvedAnswerStyleExamplesPromptBlock } from './answerStyleExamples.js';
import {
  compactModelText,
  exactProductIdentity,
  textMatchesOnlyTargetNames,
  textMatchesTargetName
} from './modelTextMatching.js';
import { createStructuredJsonResponse } from './openaiStructured.js';
import { extractPdfText, PdfTextExtractionError } from './pdfTextExtraction.js';

export interface ProductComparisonResearchFact {
  productName: string;
  attribute: string;
  value: string;
  sourceType: 'catalog' | 'web' | 'conflict';
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
  sourceUrl?: string;
  sourceTitle?: string;
  sourceTier?: Exclude<ProductResearchSourceTier, 'catalog'>;
  sourceAuthority?: 'manufacturer' | 'secondary';
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
    sourceTier?: Exclude<ProductResearchSourceTier, 'catalog'>;
    sourceAuthority?: 'manufacturer' | 'secondary';
  }>;
}

export type ProductResearchSearchDisposition =
  | 'completed'
  | 'memory_hit'
  | 'not_needed'
  | 'skipped_budget'
  | 'timed_out'
  | 'failed'
  | 'aborted';

export type ProductResearchSourceTier =
  | 'catalog'
  | 'official_page'
  | 'official_manual'
  | 'reliable_secondary';

export interface ProductResearchSourceAttempt {
  tier: ProductResearchSourceTier;
  outcome: 'confirmed' | 'not_found' | 'unreadable' | 'skipped_budget';
  query?: string;
  sources?: ProductResearchSourceDescriptor[];
}

export interface ProductResearchSourceDescriptor {
  url: string;
  host: string;
  documentKind: 'product_page' | 'manual_or_specification' | 'other';
  tier: Exclude<ProductResearchSourceTier, 'catalog'>;
  authority: 'manufacturer' | 'secondary';
}

export interface ProductComparisonResearchResult {
  usedWebSearch: boolean;
  searchDisposition: ProductResearchSearchDisposition;
  sourcesExhausted: boolean;
  sourceAttempts?: ProductResearchSourceAttempt[];
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
  const semanticResearchIntents = [
    'specification',
    'manual pdf',
    'instruction',
    'start system',
    'starter control mechanism',
    'electric starter actuation',
    'operator controls',
    'buyer requested attribute in source language',
    'electric starter',
    'manual starter'
  ];
  return targetProductNames.flatMap((target) => {
    const aliases = exactTargetAliases(target);
    const queryAttributes = uniqueStrings([...usefulAttributes, ...semanticResearchIntents]).slice(0, 18);
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
const practicalStartControlKinds: SourceBackedStartKind[] = ['key_start', 'button_start', 'switch_start'];

const keyStartClaimNeedles = [
  'key start',
  'ignition key',
  'key switch',
  'turn the key',
  'turned by key',
  'starts with a key',
  'starts with key',
  'start by key',
  'ключ зажигания',
  'ключ электростартера',
  'ключом электростартера',
  'поворот ключ',
  'поворотом ключ',
  'поверните ключ',
  'запуск ключом',
  'замок зажигания'
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
  return [...exactProductIdentity(target).searchAliases];
}

function factMatchesTarget(fact: ProductComparisonResearchFact, targetName: string) {
  if (fact.sourceType === 'web' && !sourceUrlIsHttp(fact.sourceUrl)) return false;
  const identity = exactProductIdentity(targetName);
  const provenanceText = [fact.sourceUrl, fact.sourceTitle, fact.evidence].filter(Boolean).join(' ');
  return identity.matches(fact.productName) && identity.matches(provenanceText);
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
  if (!targetProductNames.length || !hasConfirmedAnswerCoverage(result)) return false;
  return targetProductNames.every((targetName) =>
    result.facts.some((fact) =>
      sourceTypes.includes(fact.sourceType) &&
      ['high', 'medium'].includes(fact.confidence) &&
      factMatchesTarget(fact, targetName)
    )
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
        .slice(0, 12)
    : [];
  return {
    directAnswer: typeof raw.directAnswer === 'string' ? raw.directAnswer : '',
    completeness,
    coverage
  };
}

function responseUsedWebSearch(response: unknown) {
  const output = (response as { output?: unknown })?.output;
  return Array.isArray(output) && output.some((item) =>
    Boolean(
      item &&
      typeof item === 'object' &&
      (item as { type?: unknown }).type === 'web_search_call' &&
      (item as { status?: unknown }).status === 'completed'
    )
  );
}

function responseWebSearchQueries(response: unknown) {
  const output = (response as { output?: unknown })?.output;
  if (!Array.isArray(output)) return [];
  const queries: string[] = [];
  for (const item of output) {
    if (
      !item ||
      typeof item !== 'object' ||
      (item as { type?: unknown }).type !== 'web_search_call' ||
      (item as { status?: unknown }).status !== 'completed'
    ) continue;
    const action = (item as { action?: unknown }).action;
    if (!action || typeof action !== 'object') continue;
    const query = (action as { query?: unknown }).query;
    if (typeof query === 'string' && query.trim()) queries.push(query.trim());
    const actionQueries = (action as { queries?: unknown }).queries;
    if (Array.isArray(actionQueries)) {
      queries.push(...actionQueries.filter((value): value is string => typeof value === 'string' && value.trim().length > 0));
    }
  }
  return uniqueStrings(queries);
}

type CompletedWebSearchCall = {
  queries: string[];
  sourcesProvided: boolean;
  sources: Array<{ url: string; title?: string }>;
};

function responseCompletedWebSearchCalls(response: unknown): CompletedWebSearchCall[] {
  const output = (response as { output?: unknown })?.output;
  if (!Array.isArray(output)) return [];
  const calls: CompletedWebSearchCall[] = [];
  for (const item of output) {
    if (
      !item ||
      typeof item !== 'object' ||
      (item as { type?: unknown }).type !== 'web_search_call' ||
      (item as { status?: unknown }).status !== 'completed'
    ) continue;
    const action = (item as { action?: unknown }).action;
    if (!action || typeof action !== 'object') continue;
    const actionRecord = action as Record<string, unknown>;
    const queries = uniqueStrings([
      typeof actionRecord.query === 'string' ? actionRecord.query : '',
      ...(Array.isArray(actionRecord.queries)
        ? actionRecord.queries.filter((value): value is string => typeof value === 'string')
        : [])
    ]);
    const sourcesProvided = Object.prototype.hasOwnProperty.call(actionRecord, 'sources');
    const sources = Array.isArray(actionRecord.sources)
      ? actionRecord.sources.flatMap((source) => {
          if (typeof source === 'string' && sourceUrlIsHttp(source)) return [{ url: source }];
          if (!source || typeof source !== 'object') return [];
          const sourceRecord = source as Record<string, unknown>;
          const url = typeof sourceRecord.url === 'string'
            ? sourceRecord.url
            : typeof sourceRecord.link === 'string'
              ? sourceRecord.link
              : '';
          if (!sourceUrlIsHttp(url)) return [];
          return [{
            url,
            ...(typeof sourceRecord.title === 'string' && sourceRecord.title.trim()
              ? { title: sourceRecord.title.trim() }
              : {})
          }];
        })
      : [];
    calls.push({ queries, sourcesProvided, sources });
  }
  return calls;
}

const approvedManufacturerDomainsByBrand = new Map<string, readonly string[]>([
  ['firman', ['firman.biz']],
  ['honda', ['honda.com', 'honda.co.jp', 'honda.ca']],
  ['husqvarna', ['husqvarna.com', 'husqvarnaconstruction.com']],
  ['stihl', ['stihl.com', 'stihlusa.com', 'stihl.co.uk', 'stihl.de']]
]);

function hostMatchesApprovedDomain(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`);
}

function sourceDocumentKind(sourceUrl: string, sourceTitle?: string) {
  const text = compactModelText([sourceUrl, sourceTitle].filter(Boolean).join(' '));
  const path = new URL(sourceUrl).pathname.toLocaleLowerCase('en-US');
  if (
    path.endsWith('.pdf') ||
    ['manual', 'instruction', 'instructions', 'specification', 'datasheet', 'руководство', 'инструкция', 'паспорт']
      .some((token) => text.includes(token))
  ) return 'manual_or_specification' as const;
  if (['product', 'catalog', 'model', 'модель', 'товар'].some((token) => text.includes(token))) {
    return 'product_page' as const;
  }
  return 'other' as const;
}

export function classifyProductResearchSource(input: {
  sourceUrl?: unknown;
  sourceTitle?: unknown;
  product?: Pick<Product, 'brand' | 'name'> | null;
}): ProductResearchSourceDescriptor | null {
  if (!sourceUrlIsHttp(input.sourceUrl)) return null;
  const parsed = new URL(input.sourceUrl);
  const normalizedHost = parsed.hostname.toLocaleLowerCase('en-US');
  const host = normalizedHost.startsWith('www.') ? normalizedHost.slice(4) : normalizedHost;
  const brandKey = compactModelText(input.product?.brand ?? '');
  const approvedDomains = approvedManufacturerDomainsByBrand.get(brandKey) ?? [];
  const reservedTestManufacturerHost = host === 'manufacturer.example' || host.endsWith('.manufacturer.example');
  const manufacturerBound = reservedTestManufacturerHost || approvedDomains.some((domain) =>
    hostMatchesApprovedDomain(host, domain)
  );
  const documentKind = sourceDocumentKind(
    input.sourceUrl,
    typeof input.sourceTitle === 'string' ? input.sourceTitle : undefined
  );
  return {
    url: parsed.href,
    host,
    documentKind,
    tier: manufacturerBound
      ? documentKind === 'manual_or_specification' ? 'official_manual' : 'official_page'
      : 'reliable_secondary',
    authority: manufacturerBound ? 'manufacturer' : 'secondary'
  };
}

const webSourceTiers = new Set<ProductResearchSourceTier>([
  'official_page',
  'official_manual',
  'reliable_secondary'
]);

function validatedWebSourceAttempts(
  parsed: Record<string, unknown>,
  response: unknown,
  products: Product[]
) {
  const actualQueries = new Set(responseWebSearchQueries(response).map((query) => compactModelText(query)));
  const actualCalls = responseCompletedWebSearchCalls(response);
  const rawAttempts = parsed.sourceAttempts;
  if (!Array.isArray(rawAttempts) || !actualQueries.size) return [] as ProductResearchSourceAttempt[];
  const allowedOutcomes = new Set<ProductResearchSourceAttempt['outcome']>([
    'confirmed',
    'not_found',
    'unreadable'
  ]);
  const byTier = new Map<ProductResearchSourceTier, ProductResearchSourceAttempt>();
  for (const rawAttempt of rawAttempts) {
    if (!rawAttempt || typeof rawAttempt !== 'object') continue;
    const tier = (rawAttempt as { tier?: unknown }).tier;
    const outcome = (rawAttempt as { outcome?: unknown }).outcome;
    const query = (rawAttempt as { query?: unknown }).query;
    if (
      typeof tier !== 'string' ||
      !webSourceTiers.has(tier as ProductResearchSourceTier) ||
      typeof outcome !== 'string' ||
      !allowedOutcomes.has(outcome as ProductResearchSourceAttempt['outcome']) ||
      typeof query !== 'string' ||
      !actualQueries.has(compactModelText(query)) ||
      byTier.has(tier as ProductResearchSourceTier)
    ) continue;
    const actualCall = actualCalls.find((call) => call.queries.some((actualQuery) =>
      compactModelText(actualQuery) === compactModelText(query)
    ));
    if (!actualCall?.sourcesProvided) continue;
    const descriptors = actualCall?.sources.map((source) => {
      const matchingProduct = products.find((product) => {
        const sourceText = [source.url, source.title].filter(Boolean).join(' ');
        return textMatchesTargetName(sourceText, product.name);
      }) ?? (products.length === 1 ? products[0] : null);
      return classifyProductResearchSource({
        sourceUrl: source.url,
        sourceTitle: source.title,
        product: matchingProduct
      });
    }).filter((descriptor): descriptor is ProductResearchSourceDescriptor => Boolean(descriptor)) ?? [];
    const tierWasActuallyReached = descriptors.some((descriptor) => descriptor.tier === tier);
    const explicitNoResults = descriptors.length === 0 && outcome === 'not_found';
    if (!tierWasActuallyReached && !explicitNoResults) continue;
    byTier.set(tier as ProductResearchSourceTier, {
      tier: tier as ProductResearchSourceTier,
      outcome: outcome as ProductResearchSourceAttempt['outcome'],
      query: query.trim(),
      ...(descriptors.length ? { sources: descriptors } : {})
    });
  }
  return [...byTier.values()];
}

function mergeSourceAttempts(...groups: Array<ProductResearchSourceAttempt[] | undefined>) {
  const byTier = new Map<ProductResearchSourceTier, ProductResearchSourceAttempt>();
  for (const attempt of groups.flatMap((group) => group ?? [])) {
    const existing = byTier.get(attempt.tier);
    if (!existing || attempt.outcome !== 'skipped_budget' || existing.outcome === 'skipped_budget') {
      byTier.set(attempt.tier, attempt);
    }
  }
  return [...byTier.values()];
}

function sourceTierAttemptsComplete(attempts: ProductResearchSourceAttempt[] | undefined) {
  if (!attempts) return false;
  const requiredTiers: ProductResearchSourceTier[] = [
    'catalog',
    'official_page',
    'official_manual',
    'reliable_secondary'
  ];
  const byTier = new Map(attempts.map((attempt) => [attempt.tier, attempt]));
  const webQueries = requiredTiers.slice(1).map((tier) => byTier.get(tier)?.query?.trim() ?? '');
  return requiredTiers.every((tier) => {
    const attempt = byTier.get(tier);
    return Boolean(attempt && (attempt.outcome === 'confirmed' || attempt.outcome === 'not_found'));
  }) && webQueries.every(Boolean) && new Set(webQueries.map(compactModelText)).size === webQueries.length;
}

export const unreadSourceEvidenceWarnings = new Set([
  'source_evidence_fetch_failed',
  'source_evidence_empty',
  'source_evidence_unsupported_binary',
  'source_evidence_pdf_parse_failed',
  'source_evidence_pdf_parse_timed_out',
  'source_evidence_pdf_parser_busy',
  'source_evidence_pdf_too_large',
  'source_evidence_pdf_text_empty',
  'source_evidence_pdf_truncated_to_safe_page_limit',
  'source_evidence_pdf_source_cap_reached',
  'source_evidence_text_truncated_to_safe_limit',
  'source_evidence_semantic_text_truncated_to_safe_limit'
]);

export function hasUnreadSourceEvidence(warnings: string[]) {
  return warnings.some((warning) => unreadSourceEvidenceWarnings.has(warning));
}

export function researchWarningsPreventSourceExhaustion(warnings: string[]) {
  return hasUnreadSourceEvidence(warnings) || warnings.some((warning) =>
    warning.includes('skipped_insufficient_budget') ||
    warning.startsWith('tool_not_executed:') ||
    warning.startsWith('web_research_skipped:') ||
    warning.startsWith('web_research_not_needed:') ||
    warning === 'tool_execution_error' ||
    warning === 'tool_result_rejected_by_local_bounds' ||
    warning === 'tool_not_implemented' ||
    warning === 'source_tier_attempts_incomplete_after_retry'
  );
}

function normalizeResearchParsed(
  parsed: Record<string, unknown>,
  execution: Pick<ProductComparisonResearchResult, 'usedWebSearch' | 'searchDisposition' | 'sourcesExhausted'> = {
    usedWebSearch: false,
    searchDisposition: 'not_needed',
    sourcesExhausted: false
  }
): ProductComparisonResearchResult {
  return {
    ...execution,
    facts: Array.isArray(parsed.facts)
      ? (parsed.facts as Array<ProductComparisonResearchFact & { sourceUrl?: string | null; sourceTitle?: string | null }>).map((fact) => ({
          ...fact,
          sourceUrl: typeof fact.sourceUrl === 'string' ? fact.sourceUrl : undefined,
          sourceTitle: typeof fact.sourceTitle === 'string' ? fact.sourceTitle : undefined
        })).slice(0, 12)
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
const semanticSourceTextLimit = 18000;
const sourceHtmlMaxBytes = 2 * 1024 * 1024;
const sourcePdfMaxBytes = 8 * 1024 * 1024;
const sourcePdfMaxPages = 80;
const sourcePdfMaxSources = 4;
const sourceEvidenceMaxFacts = 12;
const sourceEvidenceMaxCoverage = 12;
const sourceEvidenceMaxSources = 12;
const sourceEvidenceValidationConcurrency = 4;
const sourceEvidenceFetchTimeoutMs = 4_000;

type SourceDocument = {
  ok: boolean;
  text: string;
  warning?: string;
  sourceTitle?: string;
  sourceKind?: 'catalog' | 'web';
};

type SourceTextCache = {
  documents: Map<string, Promise<SourceDocument>>;
  pdfSourceUrls: Set<string>;
};

function canonicalSourceUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return value.trim();
  }
}

function createSourceTextCache(): SourceTextCache {
  return {
    documents: new Map(),
    pdfSourceUrls: new Set()
  };
}

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

function boundedSourceText(value: unknown) {
  const text = collapseWhitespace(value);
  return {
    text: text.length > sourceTextLimit ? text.slice(0, sourceTextLimit) : text,
    ...(text.length > sourceTextLimit
      ? { warning: 'source_evidence_text_truncated_to_safe_limit' }
      : {})
  };
}

function boundedSemanticSourceText(value: unknown) {
  const text = collapseWhitespace(value);
  return {
    text: text.length > semanticSourceTextLimit ? text.slice(0, semanticSourceTextLimit) : text,
    truncated: text.length > semanticSourceTextLimit
  };
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

function sourceTitleFromHtml($: cheerio.CheerioAPI) {
  return collapseWhitespace($('title').first().text() || $('h1').first().text());
}

function htmlToSourceDocument(html: string): SourceDocument {
  const $ = cheerio.load(html);
  const sourceTitle = sourceTitleFromHtml($);
  $('script, style, noscript, svg').remove();
  const bounded = boundedSourceText($('body').text() || $.root().text() || html);
  return {
    ok: true,
    ...bounded,
    sourceTitle: sourceTitle || undefined
  };
}

function textToSourceDocument(text: string): SourceDocument {
  return {
    ok: true,
    ...boundedSourceText(text)
  };
}

async function pdfToSourceDocument(bytes: Uint8Array, signal?: AbortSignal): Promise<SourceDocument> {
  try {
    const parsed = await extractPdfText(bytes, {
      signal,
      maxPages: sourcePdfMaxPages,
      maxTextChars: sourceTextLimit
    });
    const text = limitSourceText(parsed.text);
    if (!text) {
      return { ok: false, text: '', warning: 'source_evidence_pdf_text_empty', sourceKind: 'web' };
    }
    return {
      ok: true,
      text,
      sourceKind: 'web',
      ...(parsed.truncated
        ? { warning: 'source_evidence_pdf_truncated_to_safe_page_limit' }
        : {})
    };
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
    const warning = error instanceof PdfTextExtractionError
      ? error.code === 'timed_out'
        ? 'source_evidence_pdf_parse_timed_out'
        : error.code === 'busy'
          ? 'source_evidence_pdf_parser_busy'
          : error.code === 'too_large'
            ? 'source_evidence_pdf_too_large'
            : 'source_evidence_pdf_parse_failed'
      : 'source_evidence_pdf_parse_failed';
    return {
      ok: false,
      text: '',
      warning,
      sourceKind: 'web'
    };
  }
}

function sourceBytesLookLikePdf(bytes: Uint8Array) {
  let prefix = '';
  const limit = Math.min(bytes.byteLength, 1024);
  for (let index = 0; index < limit; index += 1) {
    prefix += String.fromCharCode(bytes[index]);
  }
  return prefix.includes('%PDF-');
}

function sourceEvidenceResponseMaxBytes(input: {
  url: string;
  headers: Headers;
  prefix: Uint8Array;
}) {
  const contentType = input.headers.get('content-type') ?? '';
  return sourceLooksLikePdf(input.url, contentType) || sourceBytesLookLikePdf(input.prefix)
    ? sourcePdfMaxBytes
    : sourceHtmlMaxBytes;
}

function sourceContentKind(contentType: string): 'html' | 'text' | 'binary' {
  const normalized = normalizedText(contentType).split(';')[0].trim();
  if (normalized === 'text/html' || normalized === 'application/xhtml+xml') return 'html';
  if (normalized.startsWith('text/') || normalized.includes('json') || normalized.includes('xml')) return 'text';
  return 'binary';
}

async function fetchSourceText(sourceUrl: string, cache: SourceTextCache, signal?: AbortSignal) {
  const cacheKey = canonicalSourceUrl(sourceUrl);
  const cached = cache.documents.get(cacheKey);
  if (cached) return cached;
  if (cache.documents.size >= sourceEvidenceMaxSources) {
    return {
      ok: false,
      text: '',
      warning: 'source_evidence_source_cap_reached',
      sourceKind: 'web' as const
    };
  }
  const promise = (async () => {
    try {
      const sourceUrlLooksLikePdf = sourceLooksLikePdf(sourceUrl, '');
      if (sourceUrlLooksLikePdf && !cache.pdfSourceUrls.has(cacheKey)) {
        if (cache.pdfSourceUrls.size >= sourcePdfMaxSources) {
          return {
            ok: false,
            text: '',
            warning: 'source_evidence_pdf_source_cap_reached',
            sourceKind: 'web' as const
          };
        }
        cache.pdfSourceUrls.add(cacheKey);
      }
      const preview = await safeFetchBytes(sourceUrl, {
        maxBytes: sourcePdfMaxBytes,
        responseMaxBytes: sourceEvidenceResponseMaxBytes,
        timeoutMs: sourceEvidenceFetchTimeoutMs,
        maxRedirects: 3,
        signal,
        headers: {
          'user-agent': 'Mozilla/5.0 BAKAUT source evidence verifier'
        }
      });
      if (preview.status < 200 || preview.status >= 300) {
        return { ok: false, text: '', warning: 'source_evidence_fetch_failed', sourceKind: 'web' as const };
      }
      const contentType = preview.headers.get('content-type') ?? '';
      if (sourceLooksLikePdf(preview.url, contentType) || sourceBytesLookLikePdf(preview.bytes)) {
        if (!cache.pdfSourceUrls.has(cacheKey)) {
          if (cache.pdfSourceUrls.size >= sourcePdfMaxSources) {
            return {
              ok: false,
              text: '',
              warning: 'source_evidence_pdf_source_cap_reached',
              sourceKind: 'web' as const
            };
          }
          cache.pdfSourceUrls.add(cacheKey);
        }
        return pdfToSourceDocument(preview.bytes, signal);
      }
      const contentKind = sourceContentKind(contentType);
      if (contentKind === 'binary') {
        return {
          ok: false,
          text: '',
          warning: 'source_evidence_unsupported_binary',
          sourceKind: 'web' as const
        };
      }
      const source = contentKind === 'html'
        ? htmlToSourceDocument(outboundText(preview))
        : textToSourceDocument(outboundText(preview));
      return source.text
        ? { ...source, sourceKind: 'web' as const }
        : { ok: false, text: '', sourceTitle: source.sourceTitle, warning: 'source_evidence_empty', sourceKind: 'web' as const };
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      return { ok: false, text: '', warning: 'source_evidence_fetch_failed', sourceKind: 'web' as const };
    }
  })();
  cache.documents.set(cacheKey, promise);
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
  const sourceUrl = normalizedUrlForCompare(input.item.sourceUrl);
  const sourceUrlMatchesCatalog = Boolean(catalogProduct && sourceUrl &&
    normalizedUrlForCompare(catalogProduct.sourceUrl) === sourceUrl);
  if (input.item.sourceType === 'web') {
    if (!sourceUrlIsHttp(input.item.sourceUrl)) {
      return { ok: false, text: '', warning: 'source_evidence_source_url_missing', sourceKind: 'web' as const };
    }
    return fetchSourceText(input.item.sourceUrl, input.cache, input.signal);
  }
  if (input.item.sourceType === 'catalog' || (catalogProduct && sourceUrlMatchesCatalog && !input.item.sourceType)) {
    if (!catalogProduct) return { ok: false, text: '', warning: 'source_evidence_catalog_source_missing', sourceKind: 'catalog' as const };
    return { ok: true, text: productSourceText(catalogProduct), sourceKind: 'catalog' as const };
  }
  if (sourceUrlIsHttp(input.item.sourceUrl)) {
    return fetchSourceText(input.item.sourceUrl, input.cache, input.signal);
  }
  return { ok: false, text: '', warning: 'source_evidence_source_url_missing' };
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

function sourceEvidenceExactQuoteValidation(
  item: SourceEvidenceItem,
  sourceText: string,
  minimumEvidenceLength = 24
) {
  const evidence = collapseWhitespace(item.evidence);
  const value = collapseWhitespace(item.value);
  if (evidence.length < minimumEvidenceLength || value.length < 1) return null;
  const normalizedEvidence = normalizedText(evidence);
  if (!normalizedText(sourceText).includes(normalizedEvidence)) return null;
  if (!normalizedEvidence.includes(normalizedText(value))) return null;

  const claimKinds = startClaimKindsFromText([
    item.attribute,
    item.value,
    item.evidence
  ].join(' '));
  if (!claimKinds.length) {
    return {
      valid: true,
      invalidKinds: [] as SourceBackedStartKind[],
      warnings: ['source_evidence_exact_quote_verified']
    };
  }
  const supportedKinds = startClaimKindsFromText(sourceText);
  const invalidKinds = claimKinds.filter((kind) => !supportedKinds.includes(kind));
  return {
    valid: invalidKinds.length === 0,
    invalidKinds,
    warnings: uniqueStrings([
      'source_evidence_exact_quote_verified',
      ...invalidKinds.map((kind) => `source_evidence_validation_failed:${kind}`)
    ])
  };
}

function sourceUrlIsDedicatedToExactTarget(sourceUrl: string | undefined, targetProductNames: string[]) {
  return Boolean(sourceUrl && textMatchesOnlyTargetNames(sourceUrl, targetProductNames));
}

function exactQuoteIsBoundToTarget(input: {
  item: SourceEvidenceItem;
  sourceKind?: 'catalog' | 'web';
  targetProductNames: string[];
}) {
  if (!input.sourceKind) return false;
  if (!input.targetProductNames.length || input.sourceKind === 'catalog') return true;
  return textMatchesOnlyTargetNames(input.item.evidence, input.targetProductNames) ||
    sourceUrlIsDedicatedToExactTarget(input.item.sourceUrl, input.targetProductNames);
}

function sourceTextMatchesTarget(input: {
  sourceText: string;
  sourceTitle?: string;
  item: SourceEvidenceItem;
  targetProductNames: string[];
}) {
  if (!input.targetProductNames.length) return true;
  const haystack = [
    input.item.sourceUrl,
    input.sourceTitle,
    input.sourceText
  ].filter(Boolean).join(' ');
  return input.targetProductNames.some((targetName) => textMatchesTargetName(haystack, targetName));
}

function sourceEvidenceValidationJsonFormat() {
  return {
    format: {
      type: 'json_schema',
      name: 'source_evidence_semantic_validation',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          claimSupported: { type: 'boolean' },
          claimStartKinds: {
            type: 'array',
            items: { type: 'string', enum: [...sourceBackedStartKinds] }
          },
          supportedStartKinds: {
            type: 'array',
            items: { type: 'string', enum: [...sourceBackedStartKinds] }
          },
          evidence: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } }
        },
        required: ['claimSupported', 'claimStartKinds', 'supportedStartKinds', 'evidence', 'warnings']
      }
    }
  } as const;
}

function normalizeSourceEvidenceValidation(parsed: Record<string, unknown>) {
  const claimStartKinds = Array.isArray(parsed.claimStartKinds)
    ? parsed.claimStartKinds.filter((kind): kind is SourceBackedStartKind =>
        sourceBackedStartKinds.includes(kind as SourceBackedStartKind)
      )
    : [];
  const supportedStartKinds = Array.isArray(parsed.supportedStartKinds)
    ? parsed.supportedStartKinds.filter((kind): kind is SourceBackedStartKind =>
        sourceBackedStartKinds.includes(kind as SourceBackedStartKind)
      )
    : [];
  return {
    claimSupported: parsed.claimSupported === true,
    claimStartKinds: sourceBackedStartKinds.filter((kind) => claimStartKinds.includes(kind)),
    supportedStartKinds: sourceBackedStartKinds.filter((kind) => supportedStartKinds.includes(kind)),
    evidence: typeof parsed.evidence === 'string' ? compactEvidence(parsed.evidence, 320) : '',
    warnings: Array.isArray(parsed.warnings)
      ? parsed.warnings.filter((item): item is string => typeof item === 'string')
      : []
  };
}

async function validateSourceEvidenceSemantically(input: {
  item: SourceEvidenceItem;
  sourceText: string;
  targetProductNames: string[];
  signal?: AbortSignal;
  deadlineAtMs?: number;
}) {
  const boundedSource = boundedSemanticSourceText(input.sourceText);
  const { parsed } = await createStructuredJsonResponse({
    request: {
      model: config.OPENAI_FACT_MODEL,
      reasoning: { effort: config.OPENAI_FACT_REASONING_EFFORT },
      input: [
        {
          role: 'system',
          content: [
            'You are a strict semantic source validator for equipment/product facts.',
            'Use only the provided sourceText. Do not search the web and do not answer the buyer.',
            'Your first job is to decide whether the sourceText supports the exact claim: same product/model, same attribute, same value/meaning.',
            'Do not require exact wording. Interpret source text semantically across languages, tables, descriptions, manuals, listings, and specs.',
            'If the source mentions related but broader information, mark claimSupported=false. Example: electric starter exists does not by itself support key start or push-button start.',
            'If the claim is about a start/control mechanism, also classify canonical start kinds claimed and supported:',
            '- key_start: the electric starter is actuated by a physical ignition key, keyed switch, or turning a key.',
            '- button_start: the electric starter is actuated by a push button.',
            '- switch_start: the electric starter is actuated by a non-key switch, starter switch, engine switch, or START position.',
            '- electric_start: the source confirms an electric starter/electric start exists, without necessarily naming the control.',
            '- manual_starter: the source confirms manual/recoil/hand starter exists.',
            'Do not count a tool or accessory key, such as a spark-plug wrench or kit wrench, as key_start.',
            'For non-start claims, claimStartKinds and supportedStartKinds should be empty arrays.',
            'Return JSON only.'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            targetProductNames: input.targetProductNames,
            claim: {
              productName: input.item.productName ?? null,
              attribute: input.item.attribute,
              value: input.item.value,
              evidence: input.item.evidence,
              sourceUrl: input.item.sourceUrl ?? null,
              sourceTitle: input.item.sourceTitle ?? null
            },
            sourceText: boundedSource.text
          })
        }
      ],
      max_output_tokens: Math.min(config.OPENAI_FACT_MAX_OUTPUT_TOKENS, 900),
      text: sourceEvidenceValidationJsonFormat()
    },
    stage: 'source_evidence_semantic_validation',
    signal: input.signal,
    deadlineAtMs: input.deadlineAtMs,
    minRetryRemainingMs: WEB_RESEARCH_MIN_RETRY_REMAINING_MS,
    transportMaxRetries: 0
  });
  const normalized = normalizeSourceEvidenceValidation(parsed);
  return {
    ...normalized,
    warnings: uniqueStrings([
      ...normalized.warnings,
      boundedSource.truncated ? 'source_evidence_semantic_text_truncated_to_safe_limit' : ''
    ])
  };
}

async function validateEvidenceItem(input: {
  item: SourceEvidenceItem;
  products: Product[];
  targetProductNames: string[];
  cache: SourceTextCache;
  semanticValidation: boolean;
  signal?: AbortSignal;
  deadlineAtMs?: number;
}) {
  const source = await evidenceItemSourceText(input);
  const warnings: string[] = [];
  if (source.warning) warnings.push(source.warning);
  if (!source.ok) {
    const claimKinds = startClaimKindsFromText([
      input.item.attribute,
      input.item.value,
      input.item.evidence
    ].join(' '));
    return {
      valid: false,
      invalidKinds: claimKinds,
      warnings: uniqueStrings([
        ...warnings,
        'source_evidence_validation_failed:semantic',
        ...claimKinds.map((kind) => `source_evidence_validation_failed:${kind}`)
      ])
    };
  }

  if (!input.semanticValidation) {
    return { valid: true, invalidKinds: [] as SourceBackedStartKind[], warnings };
  }

  if (!sourceTextMatchesTarget({
    sourceText: source.text,
    sourceTitle: source.sourceTitle,
    item: input.item,
    targetProductNames: input.targetProductNames
  })) {
    const claimKinds = startClaimKindsFromText([
      input.item.attribute,
      input.item.value,
      input.item.evidence
    ].join(' '));
    return {
      valid: false,
      invalidKinds: claimKinds,
      warnings: uniqueStrings([
        ...warnings,
        'source_evidence_exact_target_not_found',
        'source_evidence_validation_failed:semantic',
        ...claimKinds.map((kind) => `source_evidence_validation_failed:${kind}`)
      ])
    };
  }

  const exactQuoteValidation = exactQuoteIsBoundToTarget({
    item: input.item,
    sourceKind: source.sourceKind,
    targetProductNames: input.targetProductNames
  })
    ? sourceEvidenceExactQuoteValidation(
        input.item,
        source.text,
        source.sourceKind === 'catalog' ? 4 : 24
      )
    : null;
  if (exactQuoteValidation) {
    return {
      ...exactQuoteValidation,
      warnings: uniqueStrings([...warnings, ...exactQuoteValidation.warnings])
    };
  }

  const semanticValidation = await validateSourceEvidenceSemantically({
    item: input.item,
    sourceText: source.text,
    targetProductNames: input.targetProductNames,
    signal: input.signal,
    deadlineAtMs: input.deadlineAtMs
  });
  const claimKinds = semanticValidation.claimStartKinds.length
    ? semanticValidation.claimStartKinds
    : startClaimKindsFromText([
        input.item.attribute,
        input.item.value,
        input.item.evidence
      ].join(' '));
  if (semanticValidation.claimSupported && !claimKinds.length) {
    return {
      valid: true,
      invalidKinds: [] as SourceBackedStartKind[],
      warnings: uniqueStrings([...warnings, ...semanticValidation.warnings])
    };
  }

  const invalidKinds = claimKinds.filter((kind) => !semanticValidation.supportedStartKinds.includes(kind));
  const valid = semanticValidation.claimSupported && invalidKinds.length === 0;
  return {
    valid,
    invalidKinds,
    warnings: uniqueStrings([
      ...warnings,
      ...semanticValidation.warnings,
      ...invalidKinds.map((kind) => `source_evidence_validation_failed:${kind}`),
      !valid && !invalidKinds.length ? 'source_evidence_validation_failed:semantic' : ''
    ])
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

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

async function validateSourceBackedResult(input: {
  result: ProductComparisonResearchResult;
  products: Product[];
  targetProductNames: string[];
  userMessage: string;
  comparisonAttributes: string[];
  cache?: SourceTextCache;
  signal?: AbortSignal;
  deadlineAtMs?: number;
}) {
  const cache = input.cache ?? createSourceTextCache();
  const warnings = [...input.result.warnings];
  const factsToValidate = input.result.facts.slice(0, sourceEvidenceMaxFacts);
  const coverageToValidate = input.result.answerGuidance.coverage.slice(0, sourceEvidenceMaxCoverage);
  if (
    input.result.facts.length > factsToValidate.length ||
    input.result.answerGuidance.coverage.length > coverageToValidate.length
  ) {
    warnings.push('source_evidence_item_cap_reached');
  }
  const invalidKinds = new Set<SourceBackedStartKind>();
  const facts: ProductComparisonResearchFact[] = [];
  const semanticValidation = true;
  let invalidatedEvidence = false;

  const factValidations = await mapWithConcurrency(
    factsToValidate,
    sourceEvidenceValidationConcurrency,
    async (fact) => {
    if (fact.sourceType === 'conflict') {
      return { fact, accepted: true, warnings: [] as string[], invalidKinds: [] as SourceBackedStartKind[] };
    }
    if (fact.confidence === 'low') {
      return {
        fact,
        accepted: false,
        warnings: ['source_evidence_low_confidence_rejected'],
        invalidKinds: [] as SourceBackedStartKind[]
      };
    }
    const validation = await validateEvidenceItem({
      item: fact,
      products: input.products,
      targetProductNames: input.targetProductNames,
      cache,
      semanticValidation,
      signal: input.signal,
      deadlineAtMs: input.deadlineAtMs
    });
    return {
      fact,
      accepted: validation.valid,
      warnings: validation.warnings,
      invalidKinds: validation.invalidKinds
    };
  });
  for (const validation of factValidations) {
    warnings.push(...validation.warnings);
    if (!validation.accepted) {
      invalidatedEvidence = true;
      for (const kind of validation.invalidKinds) invalidKinds.add(kind);
      continue;
    }
    if (validation.fact.sourceType === 'web') {
      const product = input.products.find((candidate) =>
        textMatchesTargetName(validation.fact.productName, candidate.name)
      ) ?? (input.products.length === 1 ? input.products[0] : null);
      const descriptor = classifyProductResearchSource({
        sourceUrl: validation.fact.sourceUrl,
        sourceTitle: validation.fact.sourceTitle,
        product
      });
      facts.push({
        ...validation.fact,
        ...(descriptor ? {
          sourceTier: descriptor.tier,
          sourceAuthority: descriptor.authority
        } : {})
      });
    } else {
      facts.push(validation.fact);
    }
  }

  const coverage: ResearchCoverageItem[] = [];
  const coverageValidations = await mapWithConcurrency(
    coverageToValidate,
    sourceEvidenceValidationConcurrency,
    async (item) => {
    if (item.status !== 'confirmed') return { item, validation: null };
    const validation = await validateEvidenceItem({
      item,
      products: input.products,
      targetProductNames: input.targetProductNames,
      cache,
      semanticValidation,
      signal: input.signal,
      deadlineAtMs: input.deadlineAtMs
    });
    return { item, validation };
  });
  for (const { item, validation } of coverageValidations) {
    if (!validation) {
      coverage.push(item);
      continue;
    }
    warnings.push(...validation.warnings);
    if (!validation.valid) {
      invalidatedEvidence = true;
      for (const kind of validation.invalidKinds) invalidKinds.add(kind);
      coverage.push({
        ...item,
        status: 'not_confirmed',
        value: '',
        evidence: validation.invalidKinds.length
          ? `source validation did not confirm ${validation.invalidKinds.join(', ')}`
          : 'source validation did not confirm this claim'
      });
      continue;
    }
    const product = input.products.find((candidate) =>
      textMatchesTargetName([item.sourceTitle, item.evidence].filter(Boolean).join(' '), candidate.name)
    ) ?? (input.products.length === 1 ? input.products[0] : null);
    const descriptor = classifyProductResearchSource({
      sourceUrl: item.sourceUrl,
      sourceTitle: item.sourceTitle,
      product
    });
    coverage.push({
      ...item,
      ...(descriptor ? {
        sourceTier: descriptor.tier,
        sourceAuthority: descriptor.authority
      } : {})
    });
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

  if (invalidatedEvidence) {
    adjusted.summaryForAnswer = '';
  }

  const hasValidatedGenericSupport = adjusted.facts.some((fact) =>
    fact.sourceType !== 'conflict' && (fact.confidence === 'high' || fact.confidence === 'medium')
  ) || adjusted.answerGuidance.coverage.some((item) => item.status === 'confirmed');

  if (startControlMechanismQuestionRelevant(input.userMessage, input.comparisonAttributes)) {
    const directAnswerKinds = startClaimKindsFromText(adjusted.answerGuidance.directAnswer);
    const directAnswerClaimsInvalidFact = [...invalidKinds].some((kind) => directAnswerKinds.includes(kind));
    const confirmedKindsSet = confirmedStartKinds(adjusted);
    const hasConfirmedStarterFact = confirmedKindsSet.has('electric_start') || confirmedKindsSet.has('manual_starter');
    const lacksConfirmedPracticalControl = !resultConfirmsPracticalStartControl(adjusted);
    const confirmedPracticalKinds = practicalStartControlKinds.filter((kind) => confirmedKindsSet.has(kind));
    const directAnswerMissingConfirmedPractical = confirmedPracticalKinds.length > 0 &&
      !confirmedPracticalKinds.some((kind) => directAnswerKinds.includes(kind));
    if (
      directAnswerClaimsInvalidFact ||
      directAnswerMissingConfirmedPractical ||
      (lacksConfirmedPracticalControl && hasConfirmedStarterFact) ||
      invalidatedEvidence
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
  } else {
    const hasValidatedCatalogSupportForEveryTarget = Boolean(
      adjusted.answerGuidance.directAnswer.trim() &&
      adjusted.facts.length &&
      adjusted.facts.every((fact) => fact.sourceType === 'catalog') &&
      hasConfirmedExactTargetFacts(adjusted, input.targetProductNames, ['catalog']) &&
      !resultHasUnresolvedCatalogConflict(adjusted)
    );
    if (!invalidatedEvidence && hasValidatedCatalogSupportForEveryTarget) {
      adjusted.warnings = uniqueStrings([
        ...adjusted.warnings,
        'answer_guidance_preserved_from_validated_catalog_facts'
      ]);
    } else {
      adjusted.answerGuidance = {
        ...adjusted.answerGuidance,
        directAnswer: '',
        completeness: hasValidatedGenericSupport ? 'partially_answered' : 'not_answered'
      };
      adjusted.summaryForAnswer = '';
      adjusted.warnings = uniqueStrings([
        ...adjusted.warnings,
        invalidatedEvidence
          ? 'answer_guidance_invalidated_after_source_validation'
          : hasValidatedGenericSupport
            ? 'answer_guidance_direct_answer_removed_for_evidence_coupling'
            : 'answer_guidance_invalidated_without_validated_support'
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
            maxItems: sourceEvidenceMaxFacts,
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
                maxItems: sourceEvidenceMaxCoverage,
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

interface CompactCatalogFactExtraction {
  facts: Array<{
    productName: string;
    attribute: string;
    value: string;
    evidence: string;
  }>;
  conflicts: Array<{
    productName: string;
    attribute: string;
    catalogValue: string | null;
    conflictingValues: string[];
    resolution: string;
  }>;
  missing: Array<{
    productName: string;
    attribute: string;
    reason: string;
  }>;
  directAnswer: string;
  completeness: ProductComparisonResearchAnswerGuidance['completeness'];
}

function compactCatalogFactExtractionJsonText(input: {
  targetProductNames: string[];
  comparisonAttributes: string[];
}) {
  const productNameSchema = {
    type: 'string',
    enum: uniqueStrings(input.targetProductNames)
  } as const;
  const attributeSchema = input.comparisonAttributes.length
    ? {
        type: 'string',
        enum: uniqueStrings(input.comparisonAttributes)
      } as const
    : { type: 'string' } as const;
  return {
    verbosity: 'low',
    format: {
      type: 'json_schema',
      name: 'catalog_product_fact_extraction_compact',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          facts: {
            type: 'array',
            maxItems: sourceEvidenceMaxFacts,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                productName: productNameSchema,
                attribute: attributeSchema,
                value: { type: 'string' },
                evidence: { type: 'string' }
              },
              required: ['productName', 'attribute', 'value', 'evidence']
            }
          },
          conflicts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                productName: productNameSchema,
                attribute: attributeSchema,
                catalogValue: { type: ['string', 'null'] },
                conflictingValues: { type: 'array', items: { type: 'string' } },
                resolution: { type: 'string' }
              },
              required: ['productName', 'attribute', 'catalogValue', 'conflictingValues', 'resolution']
            }
          },
          missing: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                productName: productNameSchema,
                attribute: attributeSchema,
                reason: { type: 'string' }
              },
              required: ['productName', 'attribute', 'reason']
            }
          },
          directAnswer: { type: 'string' },
          completeness: { type: 'string', enum: ['answered', 'partially_answered', 'not_answered'] }
        },
        required: ['facts', 'conflicts', 'missing', 'directAnswer', 'completeness']
      }
    }
  } as const;
}

function productMatchesExactTarget(product: Product, targetName: string) {
  return textMatchesTargetName([
    product.name,
    product.brand,
    product.externalId,
    product.slug,
    product.sourceUrl,
  ].filter(Boolean).join(' '), targetName);
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

function resultHasUnresolvedCoverage(result: ProductComparisonResearchResult) {
  return result.answerGuidance.coverage.some((item) => item.status === 'ambiguous' || item.status === 'contradicted');
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

function needsDeepMissingFactSearch(input: {
  result: ProductComparisonResearchResult;
  userMessage: string;
  comparisonAttributes: string[];
}) {
  if (needsElectricStarterControlSearch(input)) return true;
  if (input.result.conflicts.length > 0 && !input.result.warnings.includes('source_conflict_adjudicated')) return true;
  if (resultHasUnresolvedCoverage(input.result)) return true;
  if (input.result.answerGuidance.completeness !== 'answered') return true;
  if (!input.result.answerGuidance.directAnswer.trim()) return true;
  return input.result.warnings.some((warning) =>
    warning === 'exact_target_external_fact_not_found' ||
    warning.startsWith('source_evidence_validation_failed:')
  );
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
    searchDisposition: webResult.searchDisposition,
    sourcesExhausted: webResult.sourcesExhausted,
    sourceAttempts: mergeSourceAttempts(catalogResult.sourceAttempts, webResult.sourceAttempts),
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

function mergeWebResearchPasses(
  primary: ProductComparisonResearchResult,
  retry: ProductComparisonResearchResult
): ProductComparisonResearchResult {
  const preferredGuidance = resultHasUsableGuidance(retry) ? retry.answerGuidance : primary.answerGuidance;
  return {
    usedWebSearch: primary.usedWebSearch || retry.usedWebSearch,
    searchDisposition: retry.searchDisposition,
    sourcesExhausted: false,
    sourceAttempts: mergeSourceAttempts(primary.sourceAttempts, retry.sourceAttempts),
    facts: uniqueFacts([...primary.facts, ...retry.facts]),
    conflicts: [...primary.conflicts, ...retry.conflicts],
    answerGuidance: {
      ...preferredGuidance,
      coverage: uniqueCoverage([
        ...primary.answerGuidance.coverage,
        ...retry.answerGuidance.coverage
      ])
    },
    summaryForAnswer: uniqueStrings([primary.summaryForAnswer, retry.summaryForAnswer]).join('\n'),
    warnings: uniqueStrings([...primary.warnings, ...retry.warnings])
  };
}

function webResearchTimedOut(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return true;
  if (!error || typeof error !== 'object') return false;
  const value = error as {
    name?: unknown;
    code?: unknown;
    retryReason?: unknown;
  };
  return value.name === 'AbortError' ||
    value.name === 'TimeoutError' ||
    value.code === 'ABORT_ERR' ||
    value.code === 'ERR_ABORTED' ||
    value.code === 'timed_out' ||
    (value.code === 'structured_json_retry_skipped' &&
      (value.retryReason === 'signal_aborted' || value.retryReason === 'insufficient_time_budget'));
}

function catalogFactConfirmsRequestedTargetAttribute(
  result: ProductComparisonResearchResult | null,
  targetProductName: string,
  comparisonAttribute: string
) {
  const normalizedAttribute = normalizedText(comparisonAttribute);
  if (!result || !normalizedAttribute) return false;
  const identity = exactProductIdentity(targetProductName);
  const hasConflict = result.conflicts.some((conflict) =>
    identity.matches(conflict.productName) &&
    normalizedText(conflict.attribute) === normalizedAttribute
  );
  if (hasConflict) return false;
  return result.facts.some((fact) =>
    fact.sourceType === 'catalog' &&
    (fact.confidence === 'high' || fact.confidence === 'medium') &&
    normalizedText(fact.attribute) === normalizedAttribute &&
    factMatchesTarget(fact, targetProductName)
  );
}

function timedOutResearchCoverage(
  catalogResult: ProductComparisonResearchResult | null,
  targetProductNames: string[],
  comparisonAttributes: string[]
): ResearchCoverageItem[] {
  const attributes = comparisonAttributes.length
    ? comparisonAttributes
    : ['requested technical facts'];
  if (!targetProductNames.length) {
    return attributes.map((attribute) => ({
      attribute,
      status: 'not_confirmed',
      value: '',
      evidence: `External verification timed out before ${attribute} was confirmed.`
    }));
  }
  return attributes.flatMap((attribute) => {
    const unresolvedTargets = targetProductNames.filter((targetProductName) =>
      !catalogFactConfirmsRequestedTargetAttribute(catalogResult, targetProductName, attribute)
    );
    if (!unresolvedTargets.length) return [];
    const exactTargets = unresolvedTargets.join(', ');
    return [{
      attribute,
      status: 'not_confirmed' as const,
      value: '',
      evidence: `${exactTargets}: external verification timed out before ${attribute} was confirmed.`,
      sourceTitle: unresolvedTargets.join(' / ')
    }];
  });
}

function timedOutResearchPartial(input: {
  catalogResult: ProductComparisonResearchResult | null;
  catalogSourceAttempts: ProductResearchSourceAttempt[];
  targetProductNames: string[];
  comparisonAttributes: string[];
}): ProductComparisonResearchResult {
  const catalogGuidance = input.catalogResult?.answerGuidance ?? defaultAnswerGuidance();
  const catalogExtractionRan = Boolean(input.catalogResult);
  const hasCatalogEvidence = Boolean(
    input.catalogResult && (
      input.catalogResult.facts.length ||
      input.catalogResult.conflicts.length ||
      input.catalogResult.answerGuidance.coverage.some((item) =>
        item.status === 'confirmed' || item.status === 'ambiguous' || item.status === 'contradicted'
      )
    )
  );
  const missingCoverage = timedOutResearchCoverage(
    input.catalogResult,
    input.targetProductNames,
    input.comparisonAttributes
  );
  const preservedCatalogCoverage = catalogGuidance.coverage.filter((item) =>
    item.status !== 'not_confirmed' && item.status !== 'not_found'
  );
  return {
    usedWebSearch: false,
    searchDisposition: 'timed_out',
    sourcesExhausted: false,
    sourceAttempts: mergeSourceAttempts(
      input.catalogSourceAttempts,
      input.catalogResult?.sourceAttempts
    ),
    facts: input.catalogResult?.facts ?? [],
    conflicts: input.catalogResult?.conflicts ?? [],
    answerGuidance: {
      directAnswer: input.catalogResult?.answerGuidance.directAnswer ?? '',
      completeness: hasCatalogEvidence ? 'partially_answered' : 'not_answered',
      coverage: uniqueCoverage([
        ...missingCoverage,
        ...preservedCatalogCoverage
      ]).slice(0, sourceEvidenceMaxCoverage)
    },
    summaryForAnswer: input.catalogResult?.summaryForAnswer ?? '',
    warnings: uniqueStrings([
      ...(input.catalogResult?.warnings ?? []),
      catalogExtractionRan ? 'catalog_fact_extraction_used' : '',
      catalogExtractionRan ? 'catalog_fact_extraction_needed_web_research' : '',
      hasCatalogEvidence
        ? 'web_research_timed_out_after_catalog_extraction'
        : 'web_research_timed_out_without_catalog_evidence'
    ])
  };
}

const PRODUCT_COMPARISON_MIN_OUTPUT_TOKENS = 1800;
const COMPACT_CATALOG_EXTRACTION_MAX_OUTPUT_TOKENS = 1500;
const WEB_RESEARCH_MIN_RETRY_REMAINING_MS = 6_000;

function webResearchRemainingMs(deadlineAtMs: number | undefined) {
  return deadlineAtMs === undefined ? Number.POSITIVE_INFINITY : Math.max(0, deadlineAtMs - Date.now());
}

function productComparisonMaxOutputTokens(targetProductNames: string[]) {
  return targetProductNames.length
    ? Math.max(config.OPENAI_FACT_MAX_OUTPUT_TOKENS, 2600)
    : Math.max(config.OPENAI_FACT_MAX_OUTPUT_TOKENS, PRODUCT_COMPARISON_MIN_OUTPUT_TOKENS);
}

function compactCatalogProductForFact(products: Product[], productName: string) {
  return products.find((product) => productMatchesExactTarget(product, productName)) ??
    products.find((product) => normalizedText(product.name) === normalizedText(productName));
}

function compactCatalogExtractionToResearchResult(
  parsed: CompactCatalogFactExtraction,
  products: Product[]
): ProductComparisonResearchResult {
  const facts = parsed.facts.map((fact): ProductComparisonResearchFact => {
    const product = compactCatalogProductForFact(products, fact.productName);
    return {
      productName: product?.name ?? fact.productName,
      attribute: fact.attribute,
      value: fact.value,
      sourceType: 'catalog',
      confidence: 'high',
      evidence: fact.evidence,
      sourceUrl: product?.sourceUrl ?? undefined,
      sourceTitle: product?.name ?? fact.productName
    };
  });
  const conflicts = parsed.conflicts.map((conflict): ProductComparisonResearchConflict => ({
    productName: conflict.productName,
    attribute: conflict.attribute,
    catalogValue: conflict.catalogValue ?? undefined,
    webValues: conflict.conflictingValues,
    resolution: conflict.resolution
  }));
  const confirmedCoverage = facts.map((fact): ResearchCoverageItem => ({
    attribute: fact.attribute,
    status: 'confirmed',
    value: fact.value,
    evidence: fact.evidence,
    sourceUrl: fact.sourceUrl,
    sourceTitle: fact.sourceTitle
  }));
  const conflictCoverage = parsed.conflicts.map((conflict): ResearchCoverageItem => ({
    attribute: conflict.attribute,
    status: 'ambiguous',
    value: conflict.catalogValue ?? conflict.conflictingValues.join(' / '),
    evidence: conflict.resolution,
    sourceTitle: conflict.productName
  }));
  const missingCoverage = parsed.missing.map((missing): ResearchCoverageItem => ({
    attribute: missing.attribute,
    status: 'not_confirmed',
    value: '',
    evidence: `${missing.productName}: ${missing.reason}`,
    sourceTitle: missing.productName
  }));

  return {
    usedWebSearch: false,
    searchDisposition: 'not_needed',
    sourcesExhausted: false,
    facts,
    conflicts,
    answerGuidance: {
      directAnswer: parsed.directAnswer,
      completeness: parsed.completeness,
      coverage: uniqueCoverage([...confirmedCoverage, ...conflictCoverage, ...missingCoverage])
    },
    summaryForAnswer: parsed.directAnswer,
    warnings: parsed.missing.length
      ? ['catalog_fact_missing_needs_web_research']
      : []
  };
}

async function extractCompactExactCatalogProductFacts(input: {
  userMessage: string;
  products: Product[];
  targetProductNames: string[];
  comparisonAttributes: string[];
  cache?: SourceTextCache;
  signal?: AbortSignal;
  deadlineAtMs?: number;
}): Promise<ProductComparisonResearchResult> {
  const request: Record<string, unknown> = {
    model: config.OPENAI_FACT_MODEL,
    reasoning: { effort: config.OPENAI_FACT_REASONING_EFFORT },
    input: [
      {
        role: 'system',
        content: [
          'You extract buyer-relevant facts from exact BAKAUT catalog cards.',
          'Use only the supplied product names, specs, descriptions, and source URLs. Do not use web search.',
          'Interpret the buyer question and requested attributes semantically; do not depend on literal keyword matching.',
          'In every fact, conflict, and missing item, copy productName and attribute exactly from the supplied targetProductNames and comparisonAttributes arrays; never paraphrase either field.',
          'For every target product, extract each requested fact that the card actually supports. Evidence must be a short exact fragment from the supplied card.',
          'If the card is silent, add the unresolved product and attribute to missing. Silence is not proof that a feature is absent.',
          'If specs and description disagree, add a conflict. Do not hide or guess through the conflict.',
          'Set completeness to answered only when the extracted facts fully support a practical comparison for every target product and requested attribute.',
          'Write directAnswer as a short, natural Russian answer containing only supported conclusions. Return only JSON.'
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
    max_output_tokens: COMPACT_CATALOG_EXTRACTION_MAX_OUTPUT_TOKENS,
    text: compactCatalogFactExtractionJsonText({
      targetProductNames: input.targetProductNames,
      comparisonAttributes: input.comparisonAttributes
    })
  };
  const { parsed } = await createStructuredJsonResponse({
    request,
    stage: 'catalog_product_fact_extraction_compact',
    signal: input.signal,
    deadlineAtMs: input.deadlineAtMs,
    minRetryRemainingMs: WEB_RESEARCH_MIN_RETRY_REMAINING_MS,
    transportMaxRetries: 0
  });
  const extracted = augmentCatalogStarterFacts({
    result: compactCatalogExtractionToResearchResult(parsed as unknown as CompactCatalogFactExtraction, input.products),
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
    cache: input.cache,
    signal: input.signal,
    deadlineAtMs: input.deadlineAtMs
  });
}

async function extractExactCatalogProductFacts(input: {
  userMessage: string;
  products: Product[];
  targetProductNames: string[];
  comparisonAttributes: string[];
  cache?: SourceTextCache;
  signal?: AbortSignal;
  deadlineAtMs?: number;
}): Promise<ProductComparisonResearchResult> {
  if (!input.products.length || !input.targetProductNames.length) {
    return {
      usedWebSearch: false,
      searchDisposition: 'not_needed',
      sourcesExhausted: false,
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
    reasoning: { effort: config.OPENAI_FACT_REASONING_EFFORT },
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
    max_output_tokens: Math.max(config.OPENAI_FACT_MAX_OUTPUT_TOKENS, PRODUCT_COMPARISON_MIN_OUTPUT_TOKENS),
    text: productComparisonResearchJsonFormat('catalog_product_fact_extraction')
  };
  const { parsed } = await createStructuredJsonResponse({
    request,
    stage: 'catalog_product_fact_extraction',
    signal: input.signal,
    deadlineAtMs: input.deadlineAtMs,
    minRetryRemainingMs: WEB_RESEARCH_MIN_RETRY_REMAINING_MS,
    transportMaxRetries: 0
  });
  const extracted = augmentCatalogStarterFacts({
    result: {
      ...normalizeResearchParsed(parsed)
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
    cache: input.cache,
    signal: input.signal,
    deadlineAtMs: input.deadlineAtMs
  });
}

export async function researchProductComparisonFacts(input: {
  userMessage: string;
  products: Product[];
  targetProductNames?: string[];
  comparisonAttributes?: string[];
  allowCatalogOnlyAnswer?: boolean;
  catalogSearchAttempted?: boolean;
  catalogProductsFound?: boolean;
  signal?: AbortSignal;
  deadlineAtMs?: number;
}): Promise<ProductComparisonResearchResult> {
  const sourceTextCache = createSourceTextCache();
  const targetProductNames = (input.targetProductNames ?? [])
    .map((name) => name.trim())
    .filter(Boolean);
  const comparisonAttributes = (input.comparisonAttributes ?? [])
    .map((name) => name.trim())
    .filter(Boolean);
  const styleExamples = approvedAnswerStyleExamplesPromptBlock();
  const catalogSourceAttempts: ProductResearchSourceAttempt[] = input.catalogSearchAttempted === true
    ? [{
        tier: 'catalog',
        outcome: (input.catalogProductsFound ?? input.products.length > 0) ? 'confirmed' : 'not_found'
      }]
    : [];

  const exactCatalogProducts = exactCatalogProductsForTargets(input.products, targetProductNames);
  const compactCatalogFirstResearch = exactCatalogProducts.length > 0 && (
    input.allowCatalogOnlyAnswer === true || input.deadlineAtMs !== undefined
  );
  const catalogResult = exactCatalogProducts.length
    ? await (compactCatalogFirstResearch
      ? extractCompactExactCatalogProductFacts({
          userMessage: input.userMessage,
          products: exactCatalogProducts,
          targetProductNames,
          comparisonAttributes,
          cache: sourceTextCache,
          signal: input.signal,
          deadlineAtMs: input.deadlineAtMs
        })
      : extractExactCatalogProductFacts({
        userMessage: input.userMessage,
        products: exactCatalogProducts,
        targetProductNames,
        comparisonAttributes,
        cache: sourceTextCache,
        signal: input.signal,
        deadlineAtMs: input.deadlineAtMs
      }))
    : null;
  const catalogExtractionAnswered = Boolean(
    catalogResult && catalogExtractionAnswersQuestion(catalogResult, targetProductNames)
  );
  const catalogResultForResearch = catalogResult && catalogExtractionAnswered
    ? {
        ...catalogResult,
        warnings: uniqueStrings([
          ...catalogResult.warnings,
          'catalog_fact_extraction_used',
          'exact_catalog_description_extracted',
          ...(input.allowCatalogOnlyAnswer === true
            ? []
            : ['exact_catalog_description_requires_external_adjudication'])
        ])
      }
    : catalogResult;

  if (input.allowCatalogOnlyAnswer === true && catalogResultForResearch && catalogExtractionAnswered) {
    return {
      ...catalogResultForResearch,
      usedWebSearch: false,
      searchDisposition: 'not_needed',
      sourcesExhausted: false,
      sourceAttempts: mergeSourceAttempts(catalogSourceAttempts, catalogResultForResearch.sourceAttempts),
      warnings: uniqueStrings([
        ...catalogResultForResearch.warnings,
        'web_research_not_needed:catalog_extraction_answered'
      ])
    };
  }

  const exactTargetResearchInstructions = compactCatalogFirstResearch
    ? [
        'catalogExtraction already contains a compact semantic reading of the exact current catalog cards and identifies the unresolved facts.',
        'Use web_search now and search only for missing, ambiguous, or contradicted exact-target facts. Preserve the supported catalog facts.',
        'A missing catalog attribute is not proof that a feature is absent. If web search cannot confirm it, keep it not_confirmed.'
      ]
    : [
        'If buyerQuestion asks about targetProductNames and the exact model is absent from products, search the web for that exact target model. Do not infer exact target facts from nearby models.',
        'If buyerQuestion asks about targetProductNames and catalogExtraction already answered, still run exact-target external research. The catalog answer is evidence to verify/adjudicate, not a terminal answer for this tool.',
        'When targetProductNames is present, search exact quoted target names on the public web with the requested attributes before using nearby catalog products.'
      ];

  const request: Record<string, unknown> = {
    model: config.OPENAI_FACT_MODEL,
    reasoning: { effort: config.OPENAI_FACT_REASONING_EFFORT },
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
          ...exactTargetResearchInstructions,
          'A web fact for a target model is valid only with a non-null absolute HTTP(S) sourceUrl and exact source/title/evidence that names the same complete model identity. Same brand, same family, a partial multi-part code, or a nearby modification is not proof about the target model.',
          'When catalog evidence and public exact-target evidence disagree on a decision-blocking attribute, adjudicate sources instead of defaulting to catalog or saying only that it must be checked later.',
          'For a source conflict, keep searching until at least two additional independent exact-target public sources confirm or refute the disputed value, or until deeper search is exhausted. Manufacturer/manual evidence is strongest, but independent exact-target corroboration should close the buyer need when sources agree.',
          'When a conflict is resolved by this corroboration, keep the conflict object for audit and add warning source_conflict_adjudicated.',
          'Do not cite bakautprof.ru or provided product.sourceUrl pages as web facts for an absent exact target unless that page is specifically about the exact target model.',
          'If exact external sources state key start, ignition key, electric starter, push button, manual recoil, battery, power, engine, or other requested attributes for the target, return those facts with high or medium confidence.',
          'A non-official listing, cached listing, marketplace page, or forum/classified page can be used as medium-confidence evidence when it names the exact target model and the exact text answers the buyer question. Do not upgrade it to high confidence unless the source is official/manufacturer/manual/distributor.',
          'For binary buyer choices such as key vs push-button, manual vs electric, gasoline vs diesel, continue exact-target web search until each choice is confirmed, contradicted, or explicitly not found in exact-target sources. Do not stop at a broad fact like "electric starter" when the buyer asked about the more specific mechanism.',
          'For key vs push-button generator questions, inspect the practical start-control mechanism. If exact-target sources show an ignition key, ignition switch, engine switch, starter switch, or a switch turned/held in START, return that as the practical control evidence. If only broad electric starter is found, mark key/button control as not_confirmed instead of saying it is not key or not button.',
          'When electric starter is confirmed, actively look for text that explains how that electric starter is actuated: official pages, manuals, distributor listings, cached listings, product descriptions, instruction text, ignition key/switch, starter switch, push button, START switch, and Russian equivalents. Electric starter alone is not a complete answer to key vs button.',
          'Fill answerGuidance.directAnswer with the shortest practical buyer-facing answer supported by exact-target evidence. Keep it to the requested technical/specification fact only: do not include catalog presence, price, availability, delivery, lead handoff, or nearby model alternatives. The orchestrator may add catalog context later only when it is relevant to the buyer request.',
          'The directAnswer must sound like one familiar person answering another in simple Russian: no third-person catalog/report wording, no "В каталоге БАКАУТ", no "по деталям запуска"; say uncertainty plainly, e.g. "кнопочный запуск в данных не вижу".',
          styleExamples,
          'Use nearby catalog products only as catalog alternatives/orientation in summaryForAnswer; never as the technical fact for an absent exact target.',
          'If exact target facts cannot be found externally, return no target fact and add warning exact_target_external_fact_not_found instead of returning nearby-model facts.',
          'For every web fact and confirmed coverage item, fill sourceUrl with a non-null absolute HTTP(S) URL, fill sourceTitle, and put a short verbatim excerpt from that exact source in evidence. Keep value in the source wording and make sure the complete value appears inside evidence. Do not paraphrase evidence or prefix it with report wording. This exact quote is required for the fast local source verifier.',
          'If the exact quote is unavailable, return not_confirmed instead of inventing evidence.',
          'For every actual web search query, add sourceAttempts with tier=official_page, official_manual, or reliable_secondary, the exact query sent to web search, and outcome. Never report a query that was not actually executed.'
        ].join('\n')
      },
      {
        role: 'user',
        content: JSON.stringify({
          buyerQuestion: input.userMessage,
          targetProductNames,
          comparisonAttributes,
          catalogExtraction: catalogResultForResearch,
          exactTargetSearchQueries: exactTargetSearchQueries(targetProductNames, comparisonAttributes),
          products: compactCatalogFirstResearch
            ? []
            : targetProductNames.length
              ? productResearchContext(exactCatalogProducts)
              : productResearchContext(input.products)
        })
      }
    ],
    tools: [{
      type: 'web_search',
      search_context_size: 'low',
      return_token_budget: 'default'
    }],
    tool_choice: { type: 'web_search' },
    include: ['web_search_call.action.sources'],
    max_output_tokens: productComparisonMaxOutputTokens(targetProductNames),
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
              maxItems: sourceEvidenceMaxFacts,
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
                  maxItems: sourceEvidenceMaxCoverage,
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
            sourceAttempts: {
              type: 'array',
              maxItems: 12,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  tier: { type: 'string', enum: ['official_page', 'official_manual', 'reliable_secondary'] },
                  query: { type: 'string' },
                  outcome: { type: 'string', enum: ['confirmed', 'not_found', 'unreadable'] }
                },
                required: ['tier', 'query', 'outcome']
              }
            },
            summaryForAnswer: { type: 'string' },
            warnings: { type: 'array', items: { type: 'string' } }
          },
          required: ['usedWebSearch', 'facts', 'conflicts', 'answerGuidance', 'sourceAttempts', 'summaryForAnswer', 'warnings']
        }
      }
    }
  };

  let primaryResponse: Awaited<ReturnType<typeof createStructuredJsonResponse>>;
  try {
    primaryResponse = await createStructuredJsonResponse({
      request,
      stage: 'product_comparison_research',
      signal: input.signal,
      deadlineAtMs: input.deadlineAtMs,
      minRetryRemainingMs: WEB_RESEARCH_MIN_RETRY_REMAINING_MS,
      transportMaxRetries: 0
    });
  } catch (error) {
    if (!webResearchTimedOut(error, input.signal)) throw error;
    return timedOutResearchPartial({
      catalogResult: catalogResultForResearch,
      catalogSourceAttempts,
      targetProductNames,
      comparisonAttributes
    });
  }
  const { parsed, response } = primaryResponse;
  const primaryUsedWebSearch = responseUsedWebSearch(response);
  const normalizedPrimaryResult = normalizeResearchParsed(parsed, {
      usedWebSearch: primaryUsedWebSearch,
      searchDisposition: primaryUsedWebSearch
        ? 'completed'
        : 'failed',
      sourcesExhausted: false
    });
  normalizedPrimaryResult.sourceAttempts = mergeSourceAttempts(
    catalogSourceAttempts,
    validatedWebSourceAttempts(parsed, response, exactCatalogProducts)
  );
  const primaryResult = await validateSourceBackedResult({
    result: normalizedPrimaryResult,
    products: exactCatalogProducts,
    targetProductNames,
    userMessage: input.userMessage,
    comparisonAttributes,
    cache: sourceTextCache,
    signal: input.signal,
    deadlineAtMs: input.deadlineAtMs
  });
  const mergedPrimaryResult = mergeCatalogAndWebResearch(catalogResultForResearch, primaryResult);
  const combinedPrimaryResult = mergedPrimaryResult;
  const deepMissingFactRetryRequired = needsDeepMissingFactSearch({
    result: combinedPrimaryResult,
    userMessage: input.userMessage,
    comparisonAttributes
  });
  const electricControlRetryRequired = needsElectricStarterControlSearch({
    result: combinedPrimaryResult,
    userMessage: input.userMessage,
    comparisonAttributes
  });

  const exactTargetRetryRequired = (
    targetProductNames.length &&
    (
      !hasConfirmedExactTargetFacts(combinedPrimaryResult, targetProductNames, ['catalog', 'web']) ||
      deepMissingFactRetryRequired
    )
  );
  if (exactTargetRetryRequired && webResearchRemainingMs(input.deadlineAtMs) < WEB_RESEARCH_MIN_RETRY_REMAINING_MS) {
    return {
      ...combinedPrimaryResult,
      searchDisposition: 'skipped_budget',
      sourcesExhausted: false,
      warnings: uniqueStrings([
        ...combinedPrimaryResult.warnings,
        'exact_target_external_retry_skipped_insufficient_budget'
      ])
    };
  }

  if (exactTargetRetryRequired) {
    const retryRequest: Record<string, unknown> = {
      ...request,
      max_output_tokens: productComparisonMaxOutputTokens(targetProductNames),
      input: [
        {
          role: 'system',
          content: [
            'You are a second-pass exact-model web research module for a sales assistant.',
            'The first pass did not fully answer the exact-target question. Treat every missing, not_confirmed, ambiguous, or contradicted coverage item as a semantic missing-fact slot.',
            'For each missing-fact slot, reason about what information would make the buyer answer useful, then search deeper exact-model sources for that information. Do not reduce the task to a fixed phrase list.',
            'Search public HTML pages, official manufacturer pages, distributor pages, official PDF or HTML manuals/specification pages, text-only marketplace listings, cached listings, forums, and classified/product-description pages that mention the exact model/code. Prefer manufacturer/manual evidence; the runtime validates bounded PDF text as well as HTML source text.',
            'Execute three distinct search queries before declaring exhaustion: one aimed at an official manufacturer product page, one aimed at an official manual/specification PDF or HTML document, and one aimed at another reliable exact-model source. Report each actually executed query in sourceAttempts with the matching tier. If any tier was not searched, do not imply exhaustion.',
            'Use exactTargetSearchQueries only as starting hints. Generate additional source-language search wording from the buyer question, the missing-fact slot, and what the current sources failed to answer.',
            'Extract useful facts from the deeper sources, then decide which facts are needed in answerGuidance.directAnswer and which are only supporting context for summaryForAnswer.',
            'Use non-official pages as medium-confidence evidence only when they name the exact model/code and semantically answer the missing-fact slot.',
            'Accept a web fact only with a non-null absolute HTTP(S) sourceUrl and exact source/title/evidence that names the complete target model/code.',
            'If catalogExtraction conflicts with exact-target public evidence, do not preserve catalog by default. Run source adjudication: seek at least two additional independent exact-target public sources and resolve toward the value supported by manufacturer/manual evidence plus independent corroboration, or by the strongest corroborated source set.',
            'Only leave a conflict unresolved when deeper exact-target sources remain split or insufficient after that corroboration attempt.',
            'When the conflict is resolved by corroboration, keep the conflict object for audit and add warning source_conflict_adjudicated.',
            'If a source only answers a broader fact, keep that broader fact but do not use it as proof of the narrower missing slot.',
            'Do not use nearby model pages as facts for the target. Return no fact if the exact target still cannot be verified.',
            'For every web fact and confirmed coverage item, include a non-null absolute HTTP(S) sourceUrl, use a short verbatim source excerpt as evidence, and keep value in the exact source wording inside that excerpt. If the URL or quote is unavailable, return not_confirmed.',
            'Return only JSON.'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            buyerQuestion: input.userMessage,
            targetProductNames,
            comparisonAttributes,
            catalogExtraction: catalogResultForResearch,
            catalogProducts: productResearchContext(exactCatalogProducts),
            exactTargetSearchQueries: exactTargetSearchQueries(targetProductNames, comparisonAttributes)
          })
        }
      ],
      tools: [{ type: 'web_search', search_context_size: 'medium', return_token_budget: 'default' }],
      tool_choice: { type: 'web_search' }
    };
    const retry = await createStructuredJsonResponse({
      request: retryRequest,
      stage: 'product_comparison_research_exact_retry',
      signal: input.signal,
      deadlineAtMs: input.deadlineAtMs,
      minRetryRemainingMs: WEB_RESEARCH_MIN_RETRY_REMAINING_MS,
      transportMaxRetries: 0
    });
    const retryUsedWebSearch = responseUsedWebSearch(retry.response);
    const normalizedRetryResult = normalizeResearchParsed(retry.parsed, {
        usedWebSearch: retryUsedWebSearch,
        searchDisposition: retryUsedWebSearch ? 'completed' : 'failed',
        sourcesExhausted: false
      });
    normalizedRetryResult.sourceAttempts = mergeSourceAttempts(
      combinedPrimaryResult.sourceAttempts,
      validatedWebSourceAttempts(retry.parsed, retry.response, exactCatalogProducts)
    );
    const retryResult = await validateSourceBackedResult({
      result: normalizedRetryResult,
      products: exactCatalogProducts,
      targetProductNames,
      userMessage: input.userMessage,
      comparisonAttributes,
      cache: sourceTextCache,
      signal: input.signal,
      deadlineAtMs: input.deadlineAtMs
    });
    const combinedRetryResult = mergeCatalogAndWebResearch(catalogResultForResearch, retryResult);
    const electricControlStillUnresolved = electricControlRetryRequired && needsElectricStarterControlSearch({
      result: combinedRetryResult,
      userMessage: input.userMessage,
      comparisonAttributes
    });
    const deepMissingFactStillUnresolved = deepMissingFactRetryRequired && needsDeepMissingFactSearch({
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
        searchDisposition: retryUsedWebSearch ? 'completed' : 'failed',
        sourcesExhausted: false,
        sourceAttempts: combinedRetryResult.sourceAttempts,
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
          deepMissingFactRetryRequired ? 'missing_fact_deep_search_retry_used' : '',
          electricControlRetryRequired ? 'electric_start_control_retry_used' : '',
          electricControlStillUnresolved ? 'electric_start_control_not_confirmed_after_retry' : '',
          deepMissingFactStillUnresolved ? 'missing_fact_deep_search_still_unresolved' : ''
        ])
      };
    }
    return {
      ...combinedPrimaryResult,
      usedWebSearch: combinedPrimaryResult.usedWebSearch || combinedRetryResult.usedWebSearch,
      searchDisposition: retryUsedWebSearch ? 'completed' : 'failed',
      sourcesExhausted: retryUsedWebSearch &&
        sourceTierAttemptsComplete(combinedRetryResult.sourceAttempts) &&
        !researchWarningsPreventSourceExhaustion([
          ...combinedPrimaryResult.warnings,
          ...combinedRetryResult.warnings
        ]),
      sourceAttempts: combinedRetryResult.sourceAttempts,
      warnings: uniqueStrings([
        ...combinedPrimaryResult.warnings.filter((warning) => warning !== 'exact_target_external_fact_not_found'),
        ...combinedRetryResult.warnings.filter((warning) => warning !== 'exact_target_external_fact_not_found'),
        'exact_target_external_retry_used',
        deepMissingFactRetryRequired ? 'missing_fact_deep_search_retry_used' : '',
        electricControlRetryRequired ? 'electric_start_control_retry_used' : '',
        electricControlRetryRequired ? 'electric_start_control_not_confirmed_after_retry' : '',
        deepMissingFactRetryRequired ? 'missing_fact_deep_search_still_unresolved' : '',
        !sourceTierAttemptsComplete(combinedRetryResult.sourceAttempts)
          ? 'source_tier_attempts_incomplete_after_retry'
          : ''
      ])
    };
  }

  const unresolvedAfterCompletedPrimary = needsDeepMissingFactSearch({
    result: combinedPrimaryResult,
    userMessage: input.userMessage,
    comparisonAttributes
  });
  const genericRetryRequired = targetProductNames.length === 0 && unresolvedAfterCompletedPrimary;
  if (genericRetryRequired && webResearchRemainingMs(input.deadlineAtMs) < WEB_RESEARCH_MIN_RETRY_REMAINING_MS) {
    const skippedAttempts: ProductResearchSourceAttempt[] = ([
      'official_page',
      'official_manual',
      'reliable_secondary'
    ] as ProductResearchSourceTier[]).map((tier) => ({ tier, outcome: 'skipped_budget' }));
    return {
      ...combinedPrimaryResult,
      searchDisposition: 'skipped_budget',
      sourcesExhausted: false,
      sourceAttempts: mergeSourceAttempts(combinedPrimaryResult.sourceAttempts, skippedAttempts),
      warnings: uniqueStrings([
        ...combinedPrimaryResult.warnings,
        'generic_source_tier_retry_skipped_insufficient_budget'
      ])
    };
  }

  if (genericRetryRequired) {
    const genericRetryRequest: Record<string, unknown> = {
      ...request,
      input: [
        {
          role: 'system',
          content: [
            'You are the final source-tier research pass for a technical sales assistant.',
            'The first pass did not confirm a decision-relevant technical fact. Do not hand the question to a specialist yet.',
            'Execute three distinct web search queries: first for an official manufacturer product/support page, second for an official manual/specification PDF or HTML document, and third for another reliable technical or distributor source.',
            'Each actual query must be reported in sourceAttempts with its matching tier: official_page, official_manual, reliable_secondary. Never report an unexecuted query and do not reuse one query for multiple tiers.',
            'Read the resulting sources and return only source-backed facts. If a source cannot be read, report outcome=unreadable and do not claim exhaustion.',
            'For every confirmed web fact, include a non-null absolute HTTP(S) sourceUrl, sourceTitle, and a short exact excerpt containing the value. If no tier confirms the fact after all three searches, return not_found/not_confirmed coverage and no invented value.',
            'Return only JSON.'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            buyerQuestion: input.userMessage,
            comparisonAttributes,
            firstPass: combinedPrimaryResult,
            catalogProducts: productResearchContext(input.products)
          })
        }
      ],
      tools: [{ type: 'web_search', search_context_size: 'medium', return_token_budget: 'default' }],
      tool_choice: { type: 'web_search' }
    };
    const genericRetry = await createStructuredJsonResponse({
      request: genericRetryRequest,
      stage: 'product_comparison_research_generic_source_tier_retry',
      signal: input.signal,
      deadlineAtMs: input.deadlineAtMs,
      minRetryRemainingMs: WEB_RESEARCH_MIN_RETRY_REMAINING_MS,
      transportMaxRetries: 0
    });
    const retryUsedWebSearch = responseUsedWebSearch(genericRetry.response);
    const normalizedGenericRetry = normalizeResearchParsed(genericRetry.parsed, {
      usedWebSearch: retryUsedWebSearch,
      searchDisposition: retryUsedWebSearch ? 'completed' : 'failed',
      sourcesExhausted: false
    });
    normalizedGenericRetry.sourceAttempts = mergeSourceAttempts(
      combinedPrimaryResult.sourceAttempts,
      validatedWebSourceAttempts(genericRetry.parsed, genericRetry.response, exactCatalogProducts)
    );
    const validatedGenericRetry = await validateSourceBackedResult({
      result: normalizedGenericRetry,
      products: input.products,
      targetProductNames,
      userMessage: input.userMessage,
      comparisonAttributes,
      cache: sourceTextCache,
      signal: input.signal,
      deadlineAtMs: input.deadlineAtMs
    });
    const combinedGenericResult = mergeWebResearchPasses(combinedPrimaryResult, validatedGenericRetry);
    const unresolvedAfterGenericRetry = needsDeepMissingFactSearch({
      result: combinedGenericResult,
      userMessage: input.userMessage,
      comparisonAttributes
    });
    const completeTierAttempts = sourceTierAttemptsComplete(combinedGenericResult.sourceAttempts);
    return {
      ...combinedGenericResult,
      searchDisposition: retryUsedWebSearch ? 'completed' : 'failed',
      sourcesExhausted: retryUsedWebSearch &&
        unresolvedAfterGenericRetry &&
        completeTierAttempts &&
        !researchWarningsPreventSourceExhaustion(combinedGenericResult.warnings),
      warnings: uniqueStrings([
        ...combinedGenericResult.warnings,
        'generic_source_tier_retry_used',
        !completeTierAttempts ? 'source_tier_attempts_incomplete_after_retry' : ''
      ])
    };
  }

  return {
    ...combinedPrimaryResult,
    sourcesExhausted: false
  };
}
