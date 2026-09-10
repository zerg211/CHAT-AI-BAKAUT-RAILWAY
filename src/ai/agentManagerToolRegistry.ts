import { z } from 'zod';
import {
  CatalogSearchToolArgsSchema,
  CompanyKnowledgeToolArgsSchema,
  FirstPartyPageToolArgsSchema,
  GeneratorLoadToolArgsSchema,
  LeadCaptureToolArgsSchema,
  ProductDetailsToolArgsSchema,
  ToolRequestSchema,
  WebResearchToolArgsSchema,
  normalizeToolObservation,
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
  technicalVersion: z.string().nullable().optional(),
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
  primaryExpansion: z.object({
    attempted: z.boolean(),
    query: z.string(),
    scannedCount: z.number().int().nonnegative(),
    matchedCount: z.number().int().nonnegative()
  }).strict().nullable().optional()
}).strict();

const priceVerifications = z.array(z.object({ productId: nonEmpty, status: z.enum(['verified','unavailable']),
  previousPrice: z.number().nullable().optional(), price: z.number().optional(), currency:z.literal('RUB').optional(),
  sourceUrl:z.string().optional(), observedAt:z.string().optional(), evidence:z.string().optional(),
  errorCode:z.string().optional() }).strict()).max(16).optional();

const catalogSearchResult = z.object({
  priceVerifications,
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
  priceVerifications,
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

const researchSource = z.object({
  url: z.string().url(),
  host: nonEmpty,
  documentKind: z.enum(['product_page', 'manual_or_specification', 'other']),
  tier: z.enum(['official_page', 'official_manual', 'reliable_secondary']),
  authority: z.enum(['manufacturer', 'secondary'])
}).strict();

const webResearchResult = z.object({
  usedDocumentRead: z.boolean().optional(),
  // Catalog identity resolved inside this read must survive checkpoint replay.
  products: z.array(productResult).max(4).optional(),
  sourceCandidates: z.array(z.object({
    url: z.string().url().max(2_000).refine((value) => {
      try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
      catch { return false; }
    }),
    title: z.string().max(300).optional()
  }).strict()).max(12).optional(),
  sourceDiagnostics: z.array(z.object({
    url: z.string().max(600),
    reason: z.enum(['http_status', 'timeout', 'network', 'unsupported_binary', 'unreadable']),
    elapsedMs: z.number().nonnegative(),
    status: z.number().int().optional(),
    code: z.string().max(80).optional()
  }).strict()).max(32).optional(),
  usedWebSearch: z.boolean().optional(),
  searchDisposition: z.enum(['completed', 'memory_hit', 'not_needed', 'skipped_budget', 'timed_out', 'failed', 'aborted']).optional(),
  researchOutcome: z.enum(['answered', 'partial', 'exhausted']).optional(),
  sourcesExhausted: z.boolean().optional(),
  sourceAttempts: z.array(z.object({
    tier: z.enum(['catalog', 'official_page', 'official_manual', 'reliable_secondary']),
    outcome: z.enum(['confirmed', 'not_found', 'unreadable', 'skipped_budget']),
    query: z.string().optional(),
    // A single web-search query may return several exact-model pages. Keep a
    // bounded payload, but do not reject a valid result merely because the
    // provider returned more than the former eight-source cap.
    sources: z.array(researchSource).max(32).optional()
  }).strict()).optional(),
  unconfirmedFacts: z.array(z.object({
    requirementIds: z.array(z.string()),
    productName: z.string().nullable().optional(),
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

const firstPartyPageResult = z.object({
  canonicalUrl: nonEmpty,
  pageKind: z.enum(['product', 'company', 'other']).optional(),
  title: z.string().optional(),
  text: z.string().optional(),
  productIdentity: z.object({
    title: z.string(),
    article: z.string().optional()
  }).strict().optional(),
  catalogProductId: nonEmpty.optional(),
  catalogMatch: z.enum(['matched', 'absent']).optional(),
  companyInfo: z.object({
    kind: z.string(),
    volatility: z.enum(['STABLE', 'SEMI_VOLATILE']),
    snippet: z.string()
  }).strict().optional(),
  sourceFingerprint: z.string().optional(),
  observedAt: z.string().optional(),
  failureCode: z.enum(['denied', 'timeout', 'http_status', 'unreadable', 'unsupported']).optional(),
  error: z.unknown().optional()
}).strict();

const companyKnowledgeResult = z.object({
  query: z.string().optional(),
  pages: z.array(z.object({
    url: nonEmpty,
    title: z.string(),
    pageKind: z.string(),
    volatility: z.enum(['STABLE', 'SEMI_VOLATILE']).optional(),
    snippet: z.string()
  }).strict()).max(6).optional(),
  reason: z.string().optional(),
  error: z.unknown().optional()
}).strict();

const leadCaptureResult = z.object({  leadId: z.string().optional(),
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
    // Multi-tier research (catalog → official page → manual → dealers) needs more
    // than 30s; turn budget 150s fits planner + 60s research + writer.
    timeoutMs: 60_000,
    maxResultItems: 32,
    maxResultBytes: 300_000,
    // 2 attempts: a single network timeout must not end the search while the turn
    // budget still fits a shortened retry (AGENTS.md: exhaust sources before giving up).
    maxAttempts: 2
  },
  'site.readFirstPartyPage': {
    argsSchema: FirstPartyPageToolArgsSchema,
    resultPayloadSchema: firstPartyPageResult,
    risk: 'external_read',
    sideEffect: false,
    timeoutMs: 20_000,
    maxResultItems: 1,
    maxResultBytes: 60_000,
    maxAttempts: 2
  },
  'site.searchCompanyKnowledge': {
    argsSchema: CompanyKnowledgeToolArgsSchema,
    resultPayloadSchema: companyKnowledgeResult,
    risk: 'safe_read',
    sideEffect: false,
    timeoutMs: 10_000,
    maxResultItems: 6,
    maxResultBytes: 120_000,
    maxAttempts: 2
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
  return normalizeToolObservation({
    ...result,
    payload: definition.resultPayloadSchema.parse(result.payload)
  });
}

export function toolResultByteLength(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
