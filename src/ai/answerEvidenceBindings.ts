import type { AnswerContract, ToolResult } from './agentManagerContracts.js';
import { compactModelText } from './modelTextMatching.js';

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
    for (const attribute of ['price', 'oldPrice', 'name', 'brand', 'article', 'externalId']) {
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
        return [{
          id: `${result.requestId}:${kind}:${index}`,
          sourceEventId: result.requestId,
          path: `payload.${kind === 'fact' ? 'facts' : 'answerGuidance.coverage'}[${index}]`,
          productName: typeof entry.productName === 'string' ? entry.productName : null,
          attribute,
          value,
          evidence,
          exactEvidence: kind === 'fact' ? entry.sourceType === 'catalog' || entry.evidenceVerifiedExact === true
            : entry.evidenceVerifiedExact === true,
          status: kind === 'fact' ? 'confirmed' as const : safeStatus(entry.status)
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
  for (const [attribute, value] of Object.entries(payload)) {
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

export type AnswerEvidenceBindingIssue = {
  code: 'numeric_fact_evidence_binding_missing' | 'numeric_fact_evidence_binding_unknown' |
    'numeric_fact_value_not_in_bound_evidence' | 'fact_evidence_product_mismatch' |
    'fact_evidence_attribute_mismatch' | 'unconfirmed_evidence_used_as_confirmed_value' |
    'numeric_source_label_evidence_unverified';
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
  const issues: AnswerEvidenceBindingIssue[] = [];
  const bindings: AnswerEvidenceBinding[] = [];
  for (const fact of input.answer.factsUsed) {
    const toolSourceIds = fact.sourceEventIds.filter((id) => toolIds.has(id));
    const tokens = numericTokens(fact.value);
    if (!toolSourceIds.length) continue;
    const requestedIds = fact.evidenceItemIds ?? [];
    if (tokens.length > 0 && requestedIds.length === 0) {
      issues.push({ code: 'numeric_fact_evidence_binding_missing', factKey: fact.factKey,
        evidence: `${fact.factKey}:${tokens.join(',')}` });
      continue;
    }
    for (const evidenceItemId of requestedIds) {
      const item = itemById.get(evidenceItemId);
      if (!item || !toolSourceIds.includes(item.sourceEventId)) {
        issues.push({ code: 'numeric_fact_evidence_binding_unknown', factKey: fact.factKey, evidence: evidenceItemId });
        continue;
      }
      if (!sameProduct(fact.productName, item.productName)) {
        issues.push({ code: 'fact_evidence_product_mismatch', factKey: fact.factKey,
          evidence: `${evidenceItemId}:${item.productName ?? 'unknown'}` });
        continue;
      }
      if (fact.attribute && item.attribute !== 'page_text' && compactModelText(fact.attribute) !== compactModelText(item.attribute)) {
        issues.push({ code: 'fact_evidence_attribute_mismatch', factKey: fact.factKey,
          evidence: `${evidenceItemId}:${item.attribute}` });
        continue;
      }
      if (item.attribute === 'page_text' && fact.claimKind === 'confirmed_value') {
        issues.push({ code: 'unconfirmed_evidence_used_as_confirmed_value', factKey: fact.factKey,
          evidence: `${evidenceItemId}:page_text_requires_source_label` });
        continue;
      }
      if (tokens.length > 0 && !evidenceContainsNumbers(item, tokens)) {
        issues.push({ code: 'numeric_fact_value_not_in_bound_evidence', factKey: fact.factKey,
          evidence: `${evidenceItemId}:${tokens.join(',')}` });
        continue;
      }
      if (tokens.length > 0 && fact.claimKind === 'source_label' && !item.exactEvidence) {
        issues.push({ code: 'numeric_source_label_evidence_unverified', factKey: fact.factKey,
          evidence: `${evidenceItemId}:exact_evidence_required` });
        continue;
      }
      if (fact.claimKind === 'confirmed_value' && item.status !== 'confirmed' && item.status !== 'observed') {
        issues.push({ code: 'unconfirmed_evidence_used_as_confirmed_value', factKey: fact.factKey,
          evidence: `${evidenceItemId}:${item.status}` });
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
