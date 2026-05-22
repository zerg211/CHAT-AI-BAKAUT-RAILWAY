import type {
  BotCommitment,
  MentionedProductMemory,
  SemanticMemory,
  SemanticMemorySource,
  SemanticRequirement,
  SemanticRequirementKind,
  SemanticRequirementStatus,
  SemanticRequirementStrictness,
  SemanticSelectionPolicy
} from '../shared/types.js';
import { compactModelText } from './productClassifier.js';

function shortText(value: unknown, limit: number) {
  return String(value ?? '').trim().slice(0, limit);
}

function stringList(value: unknown, limit = 12) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean).slice(0, limit);
}

export function coerceSemanticRequirementKind(value: unknown): SemanticRequirementKind | undefined {
  const allowed: SemanticRequirementKind[] = ['productClass', 'task', 'weightKg', 'budgetRub', 'powerKw', 'diameterMm', 'brand', 'fuel', 'startType', 'phase'];
  return allowed.includes(value as SemanticRequirementKind) ? value as SemanticRequirementKind : undefined;
}

export function coerceSemanticRequirementStatus(value: unknown): SemanticRequirementStatus {
  const allowed: SemanticRequirementStatus[] = ['active', 'superseded', 'rejected', 'paused'];
  return allowed.includes(value as SemanticRequirementStatus) ? value as SemanticRequirementStatus : 'active';
}

export function coerceSemanticRequirementStrictness(value: unknown): SemanticRequirementStrictness {
  const allowed: SemanticRequirementStrictness[] = ['strictOnly', 'targetRange', 'fallbackAllowed'];
  return allowed.includes(value as SemanticRequirementStrictness) ? value as SemanticRequirementStrictness : 'targetRange';
}

export function coerceSemanticMemorySource(value: unknown): SemanticMemorySource {
  const allowed: SemanticMemorySource[] = ['explicit_user', 'llm_inference', 'catalog_fact'];
  return allowed.includes(value as SemanticMemorySource) ? value as SemanticMemorySource : 'llm_inference';
}

export function coerceSemanticValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ['text', 'min', 'max', 'unit', 'productClass', 'brand', 'amount']) {
    const item = raw[key];
    if (item === null || item === undefined || item === '') continue;
    if (typeof item === 'number' && Number.isFinite(item)) result[key] = item;
    if (typeof item === 'string') result[key] = shortText(item, 160);
    if (typeof item === 'boolean') result[key] = item;
  }
  return result;
}

export function coerceSemanticRequirements(value: unknown): SemanticRequirement[] {
  if (!Array.isArray(value)) return [];
  const now = new Date().toISOString();
  const result: SemanticRequirement[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const kind = coerceSemanticRequirementKind(raw.kind);
    if (!kind) continue;
    const id = shortText(raw.id, 96) || `${kind}:${result.length}`;
    result.push({
      id,
      kind,
      value: coerceSemanticValue(raw.value),
      status: coerceSemanticRequirementStatus(raw.status),
      strictness: coerceSemanticRequirementStrictness(raw.strictness),
      evidence: shortText(raw.evidence, 300),
      source: coerceSemanticMemorySource(raw.source),
      replacesRequirementIds: stringList(raw.replacesRequirementIds, 24),
      updatedAt: now
    });
  }
  return result.slice(0, 40);
}

export function coerceMentionedProductRole(value: unknown): MentionedProductMemory['role'] {
  const allowed: MentionedProductMemory['role'][] = ['targetProduct', 'availabilityCheck', 'comparison', 'example', 'compatibilityTarget'];
  return allowed.includes(value as MentionedProductMemory['role']) ? value as MentionedProductMemory['role'] : 'targetProduct';
}

export function coerceMentionedProductStatus(value: unknown): MentionedProductMemory['status'] {
  const allowed: MentionedProductMemory['status'][] = ['unresolved', 'foundInCatalog', 'notFound', 'notMatchingRequirement'];
  return allowed.includes(value as MentionedProductMemory['status']) ? value as MentionedProductMemory['status'] : 'unresolved';
}

export function coerceMentionedProducts(value: unknown): MentionedProductMemory[] {
  if (!Array.isArray(value)) return [];
  const now = new Date().toISOString();
  const result: MentionedProductMemory[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const token = shortText(raw.token, 120);
    if (!token) continue;
    const normalizedToken = compactModelText(shortText(raw.normalizedToken, 120) || token);
    result.push({
      token,
      normalizedToken,
      role: coerceMentionedProductRole(raw.role),
      status: coerceMentionedProductStatus(raw.status),
      productIds: stringList(raw.productIds, 24),
      evidence: shortText(raw.evidence, 300),
      updatedAt: now
    });
  }
  return result.slice(0, 40);
}

export function coerceSemanticAlternativeMode(value: unknown): SemanticSelectionPolicy['alternativeMode'] {
  const allowed: SemanticSelectionPolicy['alternativeMode'][] = ['none', 'afterPrimary', 'fallbackOnly'];
  return allowed.includes(value as SemanticSelectionPolicy['alternativeMode']) ? value as SemanticSelectionPolicy['alternativeMode'] : 'none';
}

export function coerceBotCommitments(value: unknown): BotCommitment[] {
  if (!Array.isArray(value)) return [];
  const now = new Date().toISOString();
  const allowed: BotCommitment['kind'][] = ['availability', 'recommendation', 'constraint', 'fact'];
  const result: BotCommitment[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const kind = allowed.includes(raw.kind as BotCommitment['kind']) ? raw.kind as BotCommitment['kind'] : undefined;
    const text = shortText(raw.text, 260);
    if (!kind || !text) continue;
    result.push({
      kind,
      text,
      productIds: stringList(raw.productIds, 16),
      evidence: shortText(raw.evidence, 300),
      updatedAt: now
    });
  }
  return result.slice(-30);
}

export function coerceSemanticMemory(value: unknown): SemanticMemory | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  return {
    version: 1,
    activeRequirementIds: stringList(raw.activeRequirementIds, 64),
    requirements: coerceSemanticRequirements(raw.requirements),
    mentionedProducts: coerceMentionedProducts(raw.mentionedProducts),
    selectionPolicy: {
      primaryRequirementIds: stringList((raw.selectionPolicy as Record<string, unknown> | undefined)?.primaryRequirementIds, 64),
      alternativeMode: coerceSemanticAlternativeMode((raw.selectionPolicy as Record<string, unknown> | undefined)?.alternativeMode),
      explanationRequired: Boolean((raw.selectionPolicy as Record<string, unknown> | undefined)?.explanationRequired)
    },
    botCommitments: coerceBotCommitments(raw.botCommitments)
  };
}
