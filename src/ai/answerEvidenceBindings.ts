import type { AnswerContract, ToolResult } from './agentManagerContracts.js';
import { compactModelText } from './modelTextMatching.js';
import { canonicalFactAttribute, normalizedFactText, normalizedFactValue } from './verifiedFactNormalization.js';

export type AnswerEvidenceClaimKind = 'confirmed_value' | 'source_label' | 'absence_or_unknown';

export interface AnswerEvidenceItem {
  id: string;
  sourceEventId: string;
  path: string;
  productName: string | null;
  attribute: string;
  value: unknown;
  evidence: string;
  exactEvidence: boolean;
  status: 'confirmed' | 'not_confirmed' | 'contradicted' | 'ambiguous' | 'not_found' | 'observed';
  verifiedFactId?: string;
}

export interface AnswerEvidenceBinding {
  factKey: string;
  sourceEventId: string;
  evidenceItemId: string;
  evidencePath: string;
  status: AnswerEvidenceItem['status'];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function itemText(value: unknown) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch { return String(value ?? ''); }
}

function boundedText(value: unknown, maxLength: number) {
  const text = itemText(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function safeStatus(value: unknown): AnswerEvidenceItem['status'] {
  return ['confirmed', 'not_confirmed', 'contradicted', 'ambiguous', 'not_found'].includes(String(value))
    ? value as AnswerEvidenceItem['status']
    : 'observed';
}

function productItems(result: ToolResult, products: unknown, basePath: string) {
  if (!Array.isArray(products)) return [] as AnswerEvidenceItem[];
  const items: AnswerEvidenceItem[] = [];
  products.forEach((candidate, productIndex) => {
    const product = record(candidate);
    if (!product) return;
    const productName = typeof product.name === 'string' ? product.name : null;
    const productId = typeof product.id === 'string' ? product.id : String(productIndex);
    const specs = record(product.specs);
    for (const [attribute, value] of Object.entries(specs ?? {})) {
      if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
      items.push({
        id: `${result.requestId}:product:${productId}:spec:${attribute}`,
        sourceEventId: result.requestId,
        path: `${basePath}[${productIndex}].specs.${attribute}`,
        productName,
        attribute,
        value,
        evidence: itemText(value),
        exactEvidence: true,
        status: 'observed'
      });
    }
    for (const attribute of ['price', 'oldPrice', 'name', 'brand', 'article', 'externalId', 'description']) {
      const value = product[attribute];
      if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
      items.push({
        id: `${result.requestId}:product:${productId}:field:${attribute}`,
        sourceEventId: result.requestId,
        path: `${basePath}[${productIndex}].${attribute}`,
        productName,
        attribute,
        value,
        evidence: itemText(value),
        exactEvidence: true,
        status: 'observed'
      });
    }
  });
  return items;
}

/**
 * Produces stable, addressable evidence units. For web research, nested catalog
 * products are intentionally excluded: only validated facts and explicit
 * coverage may ground a claim from that request.
 */
export function toolResultEvidenceItems(result: ToolResult): AnswerEvidenceItem[] {
  if (result.status !== 'ok') return [];
  const payload = record(result.payload) ?? {};
  if (result.tool === 'web.researchProductFacts') {
    const facts = Array.isArray(payload.facts) ? payload.facts : [];
    const guidance = record(payload.answerGuidance);
    const coverage = Array.isArray(guidance?.coverage) ? guidance.coverage : [];
    return [...facts.map((raw, index) => ({ raw, index, kind: 'fact' as const })),
      ...coverage.map((raw, index) => ({ raw, index, kind: 'coverage' as const }))]
      .flatMap(({ raw, index, kind }) => {
        const entry = record(raw);
        if (!entry) return [];
        // A web fact is fact-bearing only after exact excerpt validation. Catalog
        // facts merged into the research result retain their deterministic source.
        if (kind === 'fact' && entry.sourceType !== 'catalog' && entry.evidenceVerifiedExact !== true) return [];
        if (kind === 'coverage' && entry.status === 'confirmed' && entry.evidenceVerifiedExact !== true) return [];
        const value = entry.value;
        const evidence = typeof entry.evidence === 'string' ? entry.evidence : itemText(value);
        const attribute = typeof entry.attribute === 'string' && entry.attribute.trim()
          ? entry.attribute.trim()
          : 'unknown';
        const verifiedFactId = kind === 'fact' && typeof entry.verifiedFactId === 'string' && entry.verifiedFactId.trim()
          ? entry.verifiedFactId.trim()
          : undefined;
        return [{
          id: verifiedFactId
            ? `${result.requestId}:verified_fact:${verifiedFactId}:${encodeURIComponent(canonicalFactAttribute(attribute))}`
            : `${result.requestId}:${kind}:${index}`,
          sourceEventId: result.requestId,
          path: `payload.${kind === 'fact' ? 'facts' : 'answerGuidance.coverage'}[${index}]`,
          productName: typeof entry.productName === 'string' ? entry.productName : null,
          attribute,
          value,
          evidence,
          exactEvidence: kind === 'fact' ? entry.sourceType === 'catalog' || entry.evidenceVerifiedExact === true
            : entry.evidenceVerifiedExact === true,
          status: kind === 'fact' ? 'confirmed' as const : safeStatus(entry.status),
          verifiedFactId
        }];
      });
  }
  if (result.tool === 'catalog.search' || result.tool === 'catalog.getProductDetails') {
    return productItems(result, payload.products, 'payload.products');
  }
  if (result.tool === 'site.readFirstPartyPage') {
    const text = typeof payload.text === 'string' ? payload.text : '';
    if (!text) return [];
    const chunkSize = 900;
    const chunks = Array.from({ length: Math.min(20, Math.ceil(text.length / chunkSize)) }, (_, index) =>
      text.slice(index * chunkSize, (index + 1) * chunkSize));
    const productIdentity = record(payload.productIdentity);
    return chunks.map((chunk, index) => ({
      id: `${result.requestId}:page:text:${index}`, sourceEventId: result.requestId,
      path: `payload.text[${index * chunkSize}:${(index + 1) * chunkSize}]`,
      productName: typeof productIdentity?.title === 'string' && productIdentity.title.trim()
        ? productIdentity.title
        : typeof payload.title === 'string' && payload.title.trim() ? payload.title : null,
      attribute: 'page_text', value: chunk, evidence: chunk, exactEvidence: true, status: 'observed'
    }));
  }
  const primitiveItems: AnswerEvidenceItem[] = [];
  const visit = (value: unknown, path: string, idPath: string, attribute: string, depth: number) => {
    if (primitiveItems.length >= 80 || depth > 4) return;
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      primitiveItems.push({
        id: `${result.requestId}:${idPath}`, sourceEventId: result.requestId,
        path, productName: null, attribute, value,
        evidence: itemText(value), exactEvidence: true, status: 'observed'
      });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`, `${idPath}:${index}`, attribute, depth + 1));
      return;
    }
    const object = record(value);
    if (!object) return;
    for (const [key, entry] of Object.entries(object)) {
      visit(entry, `${path}.${key}`, `${idPath}:${key}`, key, depth + 1);
    }
  };
  const payloadEntries = result.tool === 'calculator.generatorLoad' && Object.hasOwn(payload, 'profile')
    ? [['profile', payload.profile] as const,
      ...Object.entries(payload).filter(([attribute]) => attribute !== 'profile')]
    : Object.entries(payload);
  for (const [attribute, value] of payloadEntries) {
    visit(value, `payload.${attribute}`, `payload:${attribute}`, attribute, 0);
  }
  return primitiveItems;
}

export function answerEvidenceItems(toolResults: ToolResult[]) {
  return toolResults.flatMap(toolResultEvidenceItems);
}

/** Compact, priority-ordered items for the writer prompt. Validation still uses
 * the complete bounded item set above. Research facts must not be displaced by
 * a large catalog result, and raw page text must not be duplicated unboundedly.
 */
export function answerEvidenceItemsForModel(toolResults: ToolResult[], maxItems = 160) {
  const priority = (result: ToolResult) => result.tool === 'web.researchProductFacts'
    ? 0
    : result.tool === 'site.readFirstPartyPage'
      ? 1
      : result.tool.startsWith('catalog.')
        ? 3
        : 2;
  return [...toolResults]
    .sort((left, right) => priority(left) - priority(right))
    .flatMap(toolResultEvidenceItems)
    .slice(0, maxItems)
    .map((item) => ({
      ...item,
      value: boundedText(item.value, 320),
      evidence: boundedText(item.evidence, 640)
    }));
}

function numericTokens(value: unknown) {
  return [...new Set((itemText(value).match(/-?\d+(?:[.,]\d+)?/g) ?? [])
    .map((token) => {
      const normalized = token.replace(',', '.');
      if (!normalized.includes('.')) return normalized;
      const sign = normalized.startsWith('-') ? '-' : '';
      const [rawInteger, rawFraction = ''] = normalized.replace(/^-/, '').split('.');
      const integer = rawInteger.replace(/^0+(?=\d)/, '') || '0';
      const fraction = rawFraction.replace(/0+$/, '');
      return `${sign}${integer}${fraction ? `.${fraction}` : ''}`;
    }))];
}

function evidenceContainsNumbers(item: AnswerEvidenceItem, tokens: string[]) {
  const evidenceTokens = new Set(numericTokens(`${itemText(item.value)} ${item.evidence}`));
  return tokens.every((token) => evidenceTokens.has(token));
}

function sameProduct(expected: unknown, actual: string | null) {
  if (!actual) return expected === null || expected === undefined;
  if (typeof expected !== 'string' || !expected.trim()) return false;
  return compactModelText(expected) === compactModelText(actual);
}

function indexedPathValue(path: string, prefix: string, values: unknown) {
  if (!path.startsWith(prefix) || !Array.isArray(values)) return null;
  const closing = path.indexOf(']', prefix.length);
  if (closing < 0) return null;
  const index = Number(path.slice(prefix.length, closing));
  return Number.isInteger(index) && index >= 0 ? values[index] : null;
}

function calculatorEvidenceProductName(item: AnswerEvidenceItem, source: ToolResult | undefined): string | null {
  if (item.productName || source?.tool !== 'calculator.generatorLoad' || source.status !== 'ok') {
    return item.productName;
  }
  const payload = record(source.payload);
  const profile = record(payload?.profile);
  const entry = indexedPathValue(item.path, 'payload.profile.items[', profile?.items) ??
    indexedPathValue(item.path, 'payload.loads[', payload?.loads);
  const entryRecord = record(entry);
  if (typeof entryRecord?.name === 'string' && entryRecord.name.trim()) return entryRecord.name.trim();
  if (item.path.startsWith('payload.profile.missingStartingLoads[') && typeof item.value === 'string') {
    const separator = item.value.indexOf(':');
    if (separator >= 0 && separator < item.value.length - 1) {
      return item.value.slice(separator + 1).replaceAll('_', ' ').trim() || null;
    }
  }
  return null;
}

function evidenceProductNameForFact(input: {
  factProductName: string | null | undefined;
  item: AnswerEvidenceItem;
  toolResultById: Map<string, ToolResult>;
}): string | null {
  // Null remains valid for legacy aggregate/load claims. When the writer names
  // the concrete consumer, resolve that scope from the calculator's canonical
  // load item instead of treating every calculator scalar as productless.
  if (!input.factProductName) return input.item.productName;
  return input.item.productName ?? calculatorEvidenceProductName(
    input.item,
    input.toolResultById.get(input.item.sourceEventId)
  );
}

function scalarValueKey(value: unknown) {
  return JSON.stringify(normalizedFactValue(itemText(value)));
}

function factValueMatchesItem(
  fact: AnswerContract['factsUsed'][number],
  item: AnswerEvidenceItem
) {
  if (scalarValueKey(fact.value) === scalarValueKey(item.value)) return true;
  if (fact.claimKind !== 'source_label' || !item.exactEvidence) return false;
  const factText = normalizedFactText(itemText(fact.value));
  if (!factText) return false;
  return normalizedFactText(itemText(item.value)).includes(factText) ||
    normalizedFactText(item.evidence).includes(factText);
}

function factAttributeMatchesItem(fact: AnswerContract['factsUsed'][number], item: AnswerEvidenceItem) {
  if (!fact.attribute) return false;
  return canonicalFactAttribute(fact.attribute) === canonicalFactAttribute(item.attribute);
}

function factStatusMatchesItem(fact: AnswerContract['factsUsed'][number], item: AnswerEvidenceItem) {
  if ((fact.claimKind ?? 'confirmed_value') === 'confirmed_value') {
    return item.status === 'confirmed' || item.status === 'observed';
  }
  if (fact.claimKind === 'absence_or_unknown') {
    return item.status !== 'confirmed';
  }
  return item.exactEvidence;
}

/**
 * Fills a missing item id only when the current tool artifacts contain one
 * unambiguous scalar proof. The writer still owns semantic claims; this only
 * restores an address that the model omitted.
 */
export function bindUniqueMissingAnswerEvidenceItems(input: {
  answer: AnswerContract;
  toolResults: ToolResult[];
}): AnswerContract {
  const items = answerEvidenceItems(input.toolResults);
  const toolIds = new Set(input.toolResults.map((result) => result.requestId));
  const toolResultById = new Map(input.toolResults.map((result) => [result.requestId, result]));
  return {
    ...input.answer,
    factsUsed: input.answer.factsUsed.map((fact) => {
      if ((fact.evidenceItemIds?.length ?? 0) > 0) return fact;
      const sourceIds = fact.sourceEventIds.filter((id) => toolIds.has(id));
      if (!sourceIds.length) return fact;
      const candidates = items.filter((item) =>
        sourceIds.includes(item.sourceEventId) &&
        sameProduct(fact.productName, evidenceProductNameForFact({
          factProductName: fact.productName,
          item,
          toolResultById
        })) &&
        factAttributeMatchesItem(fact, item) &&
        factStatusMatchesItem(fact, item) &&
        factValueMatchesItem(fact, item)
      );
      const durableCandidates = candidates.filter((item) => item.verifiedFactId);
      // Verified-memory results deliberately repeat the same row in facts and
      // coverage. Remove only that proven projection duplicate. A separate fresh
      // fact without a durable id remains a competing candidate and therefore
      // keeps auto-binding fail-closed.
      const unambiguousCandidates = candidates.filter((candidate) =>
        candidate.verifiedFactId ||
        !candidate.path.startsWith('payload.answerGuidance.coverage[') ||
        !durableCandidates.some((durable) =>
          durable.sourceEventId === candidate.sourceEventId &&
          durable.status === candidate.status &&
          durable.exactEvidence === candidate.exactEvidence &&
          sameProduct(durable.productName, candidate.productName) &&
          canonicalFactAttribute(durable.attribute) === canonicalFactAttribute(candidate.attribute) &&
          scalarValueKey(durable.value) === scalarValueKey(candidate.value) &&
          normalizedFactText(durable.evidence) === normalizedFactText(candidate.evidence)
        )
      );
      return unambiguousCandidates.length === 1
        ? { ...fact, evidenceItemIds: [unambiguousCandidates[0]!.id] }
        : fact;
    })
  };
}

function calculatorRunningTotalBinding(input: {
  fact: AnswerContract['factsUsed'][number];
  requestedIds: string[];
  itemById: Map<string, AnswerEvidenceItem>;
  toolResultById: Map<string, ToolResult>;
}): AnswerEvidenceBinding | null {
  if (input.fact.attribute !== 'totalRunningKw' || input.fact.claimKind !== 'confirmed_value' ||
    input.fact.productName !== null || typeof input.fact.value !== 'number' || !Number.isFinite(input.fact.value) ||
    input.fact.sourceEventIds.length !== 1 || input.requestedIds.length === 0 ||
    new Set(input.requestedIds).size !== input.requestedIds.length) return null;
  const sourceEventId = input.fact.sourceEventIds[0]!;
  const source = input.toolResultById.get(sourceEventId);
  if (source?.tool !== 'calculator.generatorLoad' || source.status !== 'ok') return null;
  const items = input.requestedIds.map((id) => input.itemById.get(id));
  if (items.some((item) => !item || item.sourceEventId !== sourceEventId || item.attribute !== 'runningKw' ||
    !item.path.startsWith('payload.loads[') || !item.path.endsWith('].runningKw') || item.productName !== null ||
    !item.exactEvidence || !['confirmed', 'observed'].includes(item.status))) return null;

  // The calculator owns aggregation semantics (counts, co-running groups,
  // scenarios and rounding). Components only identify the intended aggregate;
  // the claim is grounded in the calculator's canonical result.
  const canonical = input.itemById.get(`${sourceEventId}:payload:profile:totalRunningKw`);
  if (!canonical || canonical.sourceEventId !== sourceEventId || canonical.path !== 'payload.profile.totalRunningKw' ||
    canonical.attribute !== 'totalRunningKw' || canonical.productName !== null || !canonical.exactEvidence ||
    !['confirmed', 'observed'].includes(canonical.status) || typeof canonical.value !== 'number' ||
    !Number.isFinite(canonical.value) || canonical.value !== input.fact.value) return null;
  return {
    factKey: input.fact.factKey,
    sourceEventId,
    evidenceItemId: canonical.id,
    evidencePath: canonical.path,
    status: canonical.status
  };
}

function normalizedCalculatorProfileAddress(value: string) {
  let normalized = '';
  for (const character of value) {
    if (character === '.' || character === ':' || character === '[') {
      if (normalized && !normalized.endsWith(':')) normalized += ':';
      continue;
    }
    if (character === ']') continue;
    normalized += character;
  }
  return normalized.endsWith(':') ? normalized.slice(0, -1) : normalized;
}

/**
 * The model occasionally copies the exact calculator evidence path while
 * mixing display-path separators (`payload.profile.items[1]`) with stable
 * item-id separators (`payload:profile:items:1`). Resolve only that notation
 * difference inside one successful calculator profile. The caller still
 * validates product, attribute, status, exactness and value against the
 * canonical item.
 */
function calculatorProfileEvidenceAlias(input: {
  requestedId: string;
  toolSourceIds: string[];
  items: AnswerEvidenceItem[];
  toolResultById: Map<string, ToolResult>;
}) {
  const candidates = input.toolSourceIds.flatMap((sourceEventId) => {
    const source = input.toolResultById.get(sourceEventId);
    if (source?.tool !== 'calculator.generatorLoad' || source.status !== 'ok') return [];
    const prefix = `${sourceEventId}:`;
    if (!input.requestedId.startsWith(prefix)) return [];
    const requestedAddress = normalizedCalculatorProfileAddress(input.requestedId.slice(prefix.length));
    if (!requestedAddress.startsWith('payload:profile:')) return [];
    return input.items.filter((item) =>
      item.sourceEventId === sourceEventId &&
      item.path.startsWith('payload.profile.') &&
      normalizedCalculatorProfileAddress(item.path) === requestedAddress
    );
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

export type AnswerEvidenceBindingIssue = {
  code: 'numeric_fact_evidence_binding_missing' | 'fact_evidence_binding_missing' |
    'numeric_fact_evidence_binding_unknown' | 'fact_evidence_binding_unknown' |
    'numeric_fact_value_not_in_bound_evidence' | 'fact_value_not_in_bound_evidence' | 'fact_evidence_product_mismatch' |
    'fact_evidence_attribute_mismatch' | 'unconfirmed_evidence_used_as_confirmed_value' |
    'numeric_source_label_evidence_unverified' | 'source_label_evidence_unverified';
  factKey: string;
  evidence: string;
};

export function resolveAnswerEvidenceBindings(input: {
  answer: AnswerContract;
  toolResults: ToolResult[];
}) {
  const items = answerEvidenceItems(input.toolResults);
  const itemById = new Map(items.map((item) => [item.id, item]));
  const toolIds = new Set(input.toolResults.map((result) => result.requestId));
  const toolResultById = new Map(input.toolResults.map((result) => [result.requestId, result]));
  const issues: AnswerEvidenceBindingIssue[] = [];
  const bindings: AnswerEvidenceBinding[] = [];
  for (const fact of input.answer.factsUsed) {
    const toolSourceIds = fact.sourceEventIds.filter((id) => toolIds.has(id));
    const tokens = numericTokens(fact.value);
    if (!toolSourceIds.length) continue;
    const requestedIds = fact.evidenceItemIds ?? [];
    if (requestedIds.length === 0) {
      issues.push({ code: tokens.length > 0 ? 'numeric_fact_evidence_binding_missing' : 'fact_evidence_binding_missing',
        factKey: fact.factKey, evidence: `${fact.factKey}:${tokens.length ? tokens.join(',') : itemText(fact.value)}` });
      continue;
    }
    const runningTotalBinding = calculatorRunningTotalBinding({
      fact, requestedIds, itemById, toolResultById
    });
    if (runningTotalBinding) {
      bindings.push(runningTotalBinding);
      continue;
    }
    for (const evidenceItemId of requestedIds) {
      const item = itemById.get(evidenceItemId) ?? calculatorProfileEvidenceAlias({
        requestedId: evidenceItemId,
        toolSourceIds,
        items,
        toolResultById
      });
      if (!item || !toolSourceIds.includes(item.sourceEventId)) {
        issues.push({ code: tokens.length > 0 ? 'numeric_fact_evidence_binding_unknown' : 'fact_evidence_binding_unknown',
          factKey: fact.factKey, evidence: evidenceItemId });
        continue;
      }
      const evidenceProductName = evidenceProductNameForFact({
        factProductName: fact.productName,
        item,
        toolResultById
      });
      if (!sameProduct(fact.productName, evidenceProductName)) {
        issues.push({ code: 'fact_evidence_product_mismatch', factKey: fact.factKey,
          evidence: `${evidenceItemId}:${evidenceProductName ?? 'unknown'}` });
        continue;
      }
      if (fact.attribute && item.attribute !== 'page_text' &&
        canonicalFactAttribute(fact.attribute) !== canonicalFactAttribute(item.attribute)) {
        issues.push({ code: 'fact_evidence_attribute_mismatch', factKey: fact.factKey,
          evidence: `${evidenceItemId}:${item.attribute}` });
        continue;
      }
      if (item.attribute === 'page_text' && fact.claimKind === 'confirmed_value') {
        issues.push({ code: 'unconfirmed_evidence_used_as_confirmed_value', factKey: fact.factKey,
          evidence: `${evidenceItemId}:page_text_requires_source_label` });
        continue;
      }
      if (fact.claimKind === 'confirmed_value' && item.status !== 'confirmed' && item.status !== 'observed') {
        issues.push({ code: 'unconfirmed_evidence_used_as_confirmed_value', factKey: fact.factKey,
          evidence: `${evidenceItemId}:${item.status}` });
        continue;
      }
      if (fact.claimKind === 'source_label' && !item.exactEvidence) {
        issues.push({ code: tokens.length > 0 ? 'numeric_source_label_evidence_unverified' : 'source_label_evidence_unverified', factKey: fact.factKey,
          evidence: `${evidenceItemId}:exact_evidence_required` });
        continue;
      }
      const valueMatches = factValueMatchesItem(fact, item);
      if (tokens.length > 0 && !valueMatches && !evidenceContainsNumbers(item, tokens)) {
        issues.push({ code: 'numeric_fact_value_not_in_bound_evidence', factKey: fact.factKey,
          evidence: `${evidenceItemId}:${tokens.join(',')}` });
        continue;
      }
      if (!valueMatches) {
        issues.push({ code: tokens.length > 0 ? 'numeric_fact_value_not_in_bound_evidence' : 'fact_value_not_in_bound_evidence',
          factKey: fact.factKey, evidence: `${evidenceItemId}:${itemText(fact.value)}!=${itemText(item.value)}` });
        continue;
      }
      bindings.push({
        factKey: fact.factKey,
        sourceEventId: item.sourceEventId,
        evidenceItemId: item.id,
        evidencePath: item.path,
        status: item.status
      });
    }
  }
  return { items, bindings, issues };
}
