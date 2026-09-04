import { z } from 'zod';
import { ToolRequestSchema, type AgentIntentContract, type ToolRequest } from './agentManagerContracts.js';
import type { Product } from '../shared/types.js';
import { exactProductIdentity } from './modelTextMatching.js';

export const CONTINUATION_MAX_ROUNDS = 2;
export const continuationReadTools = new Set(['catalog.search', 'catalog.getProductDetails', 'web.researchProductFacts']);

const continuationDecisionSchema = z.object({
  action: z.enum(['answer', 'clarify', 'continue']),
  rationale: z.string().trim().min(1).max(2000),
  missingFacts: z.array(z.string().trim().min(1)).max(12),
  candidateProductIds: z.array(z.string().trim().min(1)).max(8),
  toolRequests: z.array(ToolRequestSchema).max(3)
}).strict().refine((decision) =>
  decision.action === 'continue' ? decision.toolRequests.length > 0 : decision.toolRequests.length === 0,
  'Only continue may request tools, and it must request at least one read'
);

export interface ContinuationDecision {
  action: 'answer' | 'clarify' | 'continue';
  rationale: string;
  missingFacts: string[];
  candidateProductIds: string[];
  toolRequests: ToolRequest[];
}

export interface ContinuationOutcome {
  status: 'answer' | 'clarify' | 'stopped';
  rounds: number;
  rationale: string;
  missingFacts: string[];
  candidateProductIds: string[];
  stopReason?: string;
}

export function parseContinuationDecision(value: unknown): ContinuationDecision {
  return continuationDecisionSchema.parse(value);
}

function canonicalReadArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalReadArgs);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key, item]) => !['reason', 'notes'].includes(key) && item !== undefined && item !== null)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalReadArgs(item)]));
  }
  return typeof value === 'string' ? value.trim().toLocaleLowerCase('ru-RU') : value;
}

function readFingerprint(request: ToolRequest) {
  return JSON.stringify([request.tool, canonicalReadArgs(request.args)]);
}

export function continuationValidationIssues(input: {
  decision: ContinuationDecision;
  intent: AgentIntentContract;
  products: Product[];
}) {
  const issues: string[] = [];
  const knownIds = new Set(input.products.map((product) => product.id));
  const requestIds = new Set(input.intent.toolRequests.map((request) => request.id));
  const fingerprints = new Set(input.intent.toolRequests.map(readFingerprint));
  const requirements = new Set(input.intent.selectionPolicy?.requirements.map((item) => item.id) ?? []);
  const knownNames = [
    ...input.products.map((product) => product.name),
    ...(input.intent.productMentions ?? []).filter((mention) =>
      ['target_product', 'catalog_candidate', 'comparison_subject'].includes(mention.role)
    ).map((mention) => mention.name)
  ];
  for (const id of input.decision.candidateProductIds) {
    if (!knownIds.has(id)) issues.push(`continuation_unknown_candidate:${id}`);
  }
  for (const request of input.decision.toolRequests) {
    if (!continuationReadTools.has(request.tool)) issues.push(`continuation_tool_not_read_only:${request.tool}`);
    if (requestIds.has(request.id)) issues.push(`continuation_duplicate_request_id:${request.id}`);
    if (fingerprints.has(readFingerprint(request))) issues.push(`continuation_duplicate_read:${request.id}`);
    requestIds.add(request.id);
    fingerprints.add(readFingerprint(request));
    for (const id of request.coversRequirementIds ?? []) {
      if (!requirements.has(id)) issues.push(`continuation_unknown_requirement:${id}`);
    }
    for (const id of request.args.productIds ?? []) {
      if (!knownIds.has(id)) issues.push(`continuation_unknown_product:${id}`);
    }
    for (const name of request.args.productNames ?? []) {
      if (!knownNames.some((known) => exactProductIdentity(name).matches(known))) {
        issues.push(`continuation_ungrounded_product_name:${name}`);
      }
    }
    const policy = input.intent.selectionPolicy;
    const requestedClass = request.args.canonicalProductIntent;
    if (requestedClass && requestedClass !== 'unknown' && policy?.canonicalProductClass &&
      policy.canonicalProductClass !== 'unknown' && requestedClass !== policy.canonicalProductClass) {
      issues.push(`continuation_product_class_changed:${requestedClass}`);
    }
    if (request.args.powerSource && request.args.powerSource !== 'any' &&
      policy?.powerSource && policy.powerSource !== 'any' && request.args.powerSource !== policy.powerSource) {
      issues.push('continuation_power_source_changed');
    }
    if (request.args.phase && request.args.phase !== 'any' &&
      policy?.phase && policy.phase !== 'any' && request.args.phase !== policy.phase) {
      issues.push('continuation_phase_changed');
    }
  }
  return [...new Set(issues)];
}
