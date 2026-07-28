import { z } from 'zod';
import {
  CatalogSearchToolArgsSchema,
  GeneratorLoadToolArgsSchema,
  LeadCaptureToolArgsSchema,
  ProductDetailsToolArgsSchema,
  ToolRequestSchema,
  WebResearchToolArgsSchema,
  type ToolRequest,
  type ToolResult
} from './agentManagerContracts.js';

const nonEmpty = z.string().trim().min(1);

const productResult = z.object({
  id: nonEmpty,
  externalId: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
  sourceUrl: z.string().nullable().optional(),
  name: nonEmpty,
  brand: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  price: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  specs: z.record(z.string(), z.unknown()),
  raw: z.record(z.string(), z.unknown()).optional(),
  lastSeenAt: z.string().nullable().optional(),
  lastSyncedAt: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  sourceContentHash: z.string().nullable().optional(),
  retrievalScore: z.number().nullable().optional(),
  retrievalSource: z.enum(['text', 'exact', 'vector', 'unknown']).nullable().optional()
}).strict();

const retrievalResult = z.object({
  intent: nonEmpty,
  query: z.string(),
  embeddingQuery: z.string(),
  textCount: z.number().int().nonnegative(),
  vectorCount: z.number().int().nonnegative(),
  usedEmbeddings: z.boolean(),
  candidateTiers: z.array(z.object({
    productId: nonEmpty,
    tier: z.enum(['exact_match', 'preliminary_match', 'compromise', 'rejected']),
    tradeoffs: z.array(z.string())
  }).strict()).max(12).optional(),
  structuredRecovery: z.object({
    attempted: z.boolean(),
    query: z.string(),
    scannedCount: z.number().int().nonnegative(),
    matchedCount: z.number().int().nonnegative()
  }).strict().nullable().optional()
}).strict();

const catalogSearchResult = z.object({
  query: z.string().optional(),
  productIntent: z.string().optional(),
  reason: z.string().optional(),
  productIds: z.array(nonEmpty).optional(),
  products: z.array(productResult).optional(),
  generatorLoadFit: z.object({
    requiredNominalKw: z.number().nonnegative(),
    droppedProductIds: z.array(nonEmpty),
    loadAwareRetry: z.boolean().optional()
  }).strict().optional(),
  retrieval: retrievalResult.optional(),
  replacementFor: z.string().optional(),
  droppedPreviousProductIds: z.array(nonEmpty).optional(),
  sourceRequestId: z.string().optional(),
  error: z.unknown().optional()
}).strict();

const productDetailsResult = z.object({
  productIntent: z.string().optional(),
  reason: z.string().optional(),
  productIds: z.array(nonEmpty).optional(),
  products: z.array(productResult).optional(),
  error: z.unknown().optional()
}).strict();

const generatorLoadResult = z.object({
  loads: z.array(z.unknown()).optional(),
  profile: z.record(z.string(), z.unknown()).nullable().optional(),
  estimateBasis: z.string().nullable().optional(),
  error: z.unknown().optional()
}).strict();

const webResearchResult = z.object({
  usedWebSearch: z.boolean().optional(),
  searchDisposition: z.enum(['completed', 'memory_hit', 'not_needed', 'skipped_budget', 'timed_out', 'failed', 'aborted']).optional(),
  researchOutcome: z.enum(['answered', 'partial', 'exhausted']).optional(),
  sourcesExhausted: z.boolean().optional(),
  sourceAttempts: z.array(z.object({
    tier: z.enum(['catalog', 'official_page', 'official_manual', 'reliable_secondary']),
    outcome: z.enum(['confirmed', 'not_found', 'unreadable', 'skipped_budget']),
    query: z.string().optional()
  }).strict()).optional(),
  unconfirmedFacts: z.array(z.object({
    requirementIds: z.array(z.string()),
    attribute: z.string(),
    status: z.string(),
    reason: z.string()
  }).strict()).optional(),
  facts: z.array(z.unknown()).optional(),
  conflicts: z.array(z.unknown()).optional(),
  answerGuidance: z.record(z.string(), z.unknown()).optional(),
  summaryForAnswer: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  targetProductNames: z.array(z.string()).optional(),
  comparisonAttributes: z.array(z.string()).optional(),
  catalogPresence: z.array(z.unknown()).optional(),
  nearbyCatalogProducts: z.array(z.unknown()).optional(),
  suppressedTargetProductNames: z.array(z.string()).optional(),
  error: z.unknown().optional()
}).strict();

const leadCaptureResult = z.object({
  leadId: z.string().optional(),
  existing: z.boolean().optional(),
  outbox: z.boolean().optional(),
  outboxId: z.string().optional(),
  status: z.enum(['queued']).optional(),
  dispatchStatus: z.enum(['pending', 'sending', 'sent', 'failed']).optional(),
  missing: z.enum(['contact', 'name']).optional(),
  missingFields: z.array(z.enum(['name', 'contact'])).max(2).optional(),
  draftId: z.string().uuid().optional(),
  draftSaved: z.boolean().optional(),
  contactStored: z.boolean().optional(),
  preferredContact: z.enum(['message', 'call']).optional(),
  originalQuestionPreserved: z.boolean().optional(),
  actionFingerprint: z.string().length(64).refine((value) =>
    [...value].every((character) => '0123456789abcdef'.includes(character)),
  'actionFingerprint must be lowercase SHA-256 hex').optional(),
  reason: z.string().optional(),
  error: z.unknown().optional()
}).strict();

export type AgentManagerToolRisk = 'safe_read' | 'external_read' | 'sensitive_write';

export interface AgentManagerToolDefinition {
  argsSchema: z.ZodType<Record<string, unknown>>;
  resultPayloadSchema: z.ZodType<Record<string, unknown>>;
  risk: AgentManagerToolRisk;
  sideEffect: boolean;
  timeoutMs: number;
  maxResultItems: number;
  maxResultBytes: number;
  maxAttempts: number;
}

export const agentManagerToolRegistry = {
  'catalog.search': {
    argsSchema: CatalogSearchToolArgsSchema,
    resultPayloadSchema: catalogSearchResult,
    risk: 'safe_read',
    sideEffect: false,
    timeoutMs: 10_000,
    maxResultItems: 12,
    maxResultBytes: 180_000,
    maxAttempts: 2
  },
  'catalog.getProductDetails': {
    argsSchema: ProductDetailsToolArgsSchema,
    resultPayloadSchema: productDetailsResult,
    risk: 'safe_read',
    sideEffect: false,
    timeoutMs: 10_000,
    maxResultItems: 16,
    maxResultBytes: 220_000,
    maxAttempts: 2
  },
  'calculator.generatorLoad': {
    argsSchema: GeneratorLoadToolArgsSchema,
    resultPayloadSchema: generatorLoadResult,
    risk: 'safe_read',
    sideEffect: false,
    timeoutMs: 2_000,
    maxResultItems: 24,
    maxResultBytes: 60_000,
    maxAttempts: 1
  },
  'web.researchProductFacts': {
    argsSchema: WebResearchToolArgsSchema,
    resultPayloadSchema: webResearchResult,
    risk: 'external_read',
    sideEffect: false,
    timeoutMs: 19_500,
    maxResultItems: 32,
    maxResultBytes: 300_000,
    maxAttempts: 1
  },
  'lead.capture': {
    argsSchema: LeadCaptureToolArgsSchema,
    resultPayloadSchema: leadCaptureResult,
    risk: 'sensitive_write',
    sideEffect: true,
    timeoutMs: 8_000,
    maxResultItems: 1,
    maxResultBytes: 20_000,
    maxAttempts: 1
  }
} satisfies Record<ToolRequest['tool'], AgentManagerToolDefinition>;

export function validateToolRequest(request: ToolRequest): ToolRequest {
  const parsed = ToolRequestSchema.parse(request);
  agentManagerToolRegistry[parsed.tool].argsSchema.parse(parsed.args);
  return parsed;
}

export function validateToolResultOutput(result: ToolResult): ToolResult {
  const definition = agentManagerToolRegistry[result.tool];
  return {
    ...result,
    payload: definition.resultPayloadSchema.parse(result.payload)
  };
}

export function toolResultByteLength(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
