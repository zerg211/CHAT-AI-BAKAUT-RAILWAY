import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { pool } from './pool.js';
import { config } from '../config.js';
import type {
  CatalogProductInput,
  CatalogPage,
  CatalogPageInput,
  ConversationSummary,
  ConversationSession,
  ConversationTurn,
  CustomerNeedState,
  DataConflict,
  EmbeddingMetadata,
  Lead,
  Message,
  MessageRole,
  Product,
  ProductRetrievalSource,
  ProductFact,
  TroubleshootingCase,
  TroubleshootingCaseInput,
  VerifiedProductFact,
  VerifiedProductFactConfidence,
  VerifiedProductFactInput
} from '../shared/types.js';
import { emptyNeedState } from '../ai/needState.js';
import {
  catalogSourceContentHash,
  catalogSyncLockIdentity,
  evaluateCatalogSyncHealth,
  type CatalogSyncMode
} from '../catalog/catalogFreshness.js';
import {
  AssistantFeedbackQueueItemSchema,
  type AssistantFeedbackQueueItem,
  type AssistantFeedbackQueueStatus,
  type AssistantFeedbackRating,
  type AssistantFeedbackRegressionFixture
} from '../ai/assistantFeedbackQueue.js';

type Db = Pool | PoolClient;
export type EmbeddingCoverageTarget = 'products' | 'catalog_pages' | 'troubleshooting_cases';

export interface EmbeddingCoverage {
  target: EmbeddingCoverageTarget;
  total: number;
  embedded: number;
  usable: number;
  coverage: number;
}

export interface EmbeddingBackfillProduct {
  product: Product;
  hasEmbedding: boolean;
  embeddingModel?: string | null;
  embeddingSourceHash?: string | null;
  embeddingUpdatedAt?: string | null;
}

export interface EmbeddingBackfillCatalogPage {
  page: CatalogPage;
  hasEmbedding: boolean;
  embeddingModel?: string | null;
  embeddingSourceHash?: string | null;
  embeddingUpdatedAt?: string | null;
}

function jsonbParam(value: unknown) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function freshnessHashInput(input: CatalogProductInput | CatalogPageInput) {
  const raw = { ...(input.raw ?? {}) };
  delete raw.crawledAt;
  delete raw.importedAt;
  delete raw.syncedAt;
  return { ...input, raw };
}

export class ActiveConversationTurnError extends Error {
  readonly code = 'active_conversation_turn_exists';

  constructor(readonly activeTurnId?: string) {
    super('Another turn is already active for this conversation');
    this.name = 'ActiveConversationTurnError';
  }
}

export class ClientMessagePayloadConflictError extends Error {
  readonly code = 'client_message_id_reused_with_different_payload';

  constructor() {
    super('The client message id was already used with a different payload');
    this.name = 'ClientMessagePayloadConflictError';
  }
}

function charCode(value: string) {
  return value.codePointAt(0) ?? 0;
}

function isAsciiDigit(value: string) {
  const code = charCode(value);
  return code >= 48 && code <= 57;
}

function isAsciiLetter(value: string) {
  const code = charCode(value);
  return code >= 97 && code <= 122;
}

function isCyrillicLetter(value: string) {
  const code = charCode(value);
  return (code >= 0x0430 && code <= 0x044f) || code === 0x0451;
}

function isProductKeyChar(value: string) {
  return isAsciiDigit(value) || isAsciiLetter(value) || isCyrillicLetter(value);
}

function tokenHasDigit(value: string) {
  for (const char of value) {
    if (isAsciiDigit(char)) return true;
  }
  return false;
}

function tokenHasLetter(value: string) {
  for (const char of value) {
    if (isAsciiLetter(char) || isCyrillicLetter(char)) return true;
  }
  return false;
}

function normalizeVerifiedProductKey(value: unknown) {
  const tokens: string[] = [];
  let current = '';
  for (const char of String(value ?? '').normalize('NFKD').toLocaleLowerCase('ru-RU')) {
    if (isProductKeyChar(char)) {
      current += char;
    } else if (current) {
      tokens.push(current);
      current = '';
    }
  }
  if (current) tokens.push(current);
  const identifierTokens = tokens.filter((token) => token.length >= 4 && tokenHasDigit(token) && tokenHasLetter(token));
  return (identifierTokens.length ? identifierTokens : tokens).join(' ').trim();
}

function mapNeedState(value: unknown): CustomerNeedState {
  if (!value || typeof value !== 'object') return emptyNeedState();
  const empty = emptyNeedState();
  const raw = value as Partial<CustomerNeedState>;
  return {
    ...empty,
    ...raw,
    semanticMemory: {
      ...empty.semanticMemory,
      ...(raw.semanticMemory ?? {}),
      selectionPolicy: {
        ...empty.semanticMemory.selectionPolicy,
        ...(raw.semanticMemory?.selectionPolicy ?? {})
      }
    },
    selectionState: {
      ...empty.selectionState,
      ...(raw.selectionState ?? {}),
      hardConstraints: {
        ...empty.selectionState.hardConstraints,
        ...(raw.selectionState?.hardConstraints ?? {})
      },
      softPreferences: {
        ...empty.selectionState.softPreferences,
        ...(raw.selectionState?.softPreferences ?? {})
      }
    }
  };
}

function mapSession(row: QueryResultRow): ConversationSession {
  return {
    id: row.id,
    status: row.status,
    conversationNumber: Number(row.conversation_number ?? 0),
    topic: row.topic,
    title: row.title ?? (row.conversation_number ? `Диалог #${row.conversation_number}` : 'Диалог'),
    visitorId: row.visitor_id,
    pageUrl: row.page_url,
    userAgent: row.user_agent,
    needState: mapNeedState(row.need_state),
    historySummary: row.history_summary ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastHeartbeatAt: row.last_heartbeat_at.toISOString(),
    closedAt: row.closed_at ? row.closed_at.toISOString() : null
  };
}

function mapConversationSummary(row: QueryResultRow): ConversationSummary {
  return {
    ...mapSession(row),
    messageCount: Number(row.message_count ?? 0),
    leadCount: Number(row.lead_count ?? 0),
    latestMessageAt: row.latest_message_at ? row.latest_message_at.toISOString() : null,
    latestUserMessage: row.latest_user_message ?? null,
    latestAssistantMessage: row.latest_assistant_message ?? null
  };
}

function mapMessage(row: QueryResultRow): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    metadata: row.metadata ?? {},
    createdAt: row.created_at.toISOString()
  };
}

function mapProduct(row: QueryResultRow): Product {
  const retrievalSource = typeof row.retrieval_source === 'string'
    ? row.retrieval_source as ProductRetrievalSource
    : undefined;
  const retrievalScore = row.retrieval_score === null || row.retrieval_score === undefined
    ? undefined
    : Number(row.retrieval_score);
  return {
    id: row.id,
    externalId: row.external_id,
    slug: row.slug,
    sourceUrl: row.source_url,
    name: row.name,
    brand: row.brand,
    category: row.category,
    price: row.price === null || row.price === undefined ? null : Number(row.price),
    currency: row.currency,
    imageUrl: row.image_url,
    description: row.description,
    specs: row.specs ?? {},
    raw: row.raw ?? {},
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    lastSyncedAt: row.last_synced_at ? row.last_synced_at.toISOString() : null,
    isActive: row.is_active === undefined ? true : Boolean(row.is_active),
    sourceContentHash: row.source_content_hash ?? null,
    retrievalScore,
    retrievalSource
  };
}

const PRODUCT_RESPONSE_COLUMNS = [
  'id',
  'external_id',
  'slug',
  'source_url',
  'name',
  'brand',
  'category',
  'price',
  'currency',
  'image_url',
  'description',
  'specs',
  'last_seen_at',
  'last_synced_at',
  'is_active',
  'source_content_hash'
].join(', ');

const PRODUCT_FILTER = `is_active IS NOT FALSE AND (raw->>'pageType' = 'product' OR raw->>'sourceType' = 'csv')`;

function mapConversationTurn(row: QueryResultRow): ConversationTurn {
  return {
    id: row.id,
    sessionId: row.session_id,
    clientMessageId: row.client_message_id ?? null,
    userMessageId: row.user_message_id ?? null,
    assistantMessageId: row.assistant_message_id ?? null,
    status: row.status,
    requestHash: row.request_hash,
    stage: row.stage ?? null,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    plannerContract: row.planner_contract ?? null,
    activeNeedsBefore: row.active_needs_before ?? null,
    activeNeedsAfter: row.active_needs_after ?? null,
    executionOwner: row.execution_owner ?? null,
    executionLeaseExpiresAt: row.execution_lease_expires_at
      ? new Date(row.execution_lease_expires_at).toISOString()
      : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapTroubleshootingCase(row: QueryResultRow): TroubleshootingCase {
  return {
    id: row.id,
    model: row.model,
    modelKey: row.model_key,
    faultCodes: row.fault_codes ?? [],
    problemSummary: row.problem_summary,
    problemKey: row.problem_key,
    answer: row.answer,
    sourceUrls: row.source_urls ?? [],
    sourceTitles: row.source_titles ?? [],
    confidence: Number(row.confidence ?? 0),
    firstSeenMessage: row.first_seen_message ?? null,
    hitCount: Number(row.hit_count ?? 0),
    semanticScore: row.semantic_score === null || row.semantic_score === undefined ? null : Number(row.semantic_score),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapLead(row: QueryResultRow): Lead {
  return {
    id: row.id,
    sessionId: row.session_id,
    clientLeadId: row.client_lead_id ?? null,
    clientRequestHash: row.client_request_hash ?? null,
    originTurnId: row.origin_turn_id ?? null,
    originToolRequestId: row.origin_tool_request_id ?? null,
    name: row.name,
    phone: row.phone,
    email: row.email,
    question: row.question,
    status: row.status,
    createdAt: row.created_at.toISOString()
  };
}

function mapCatalogPage(row: QueryResultRow): CatalogPage {
  return {
    id: row.id,
    sourceUrl: row.source_url,
    pageType: row.page_type,
    title: row.title,
    content: row.content,
    summary: row.summary,
    raw: row.raw ?? {},
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    lastSyncedAt: row.last_synced_at ? row.last_synced_at.toISOString() : null,
    isActive: row.is_active === undefined ? true : Boolean(row.is_active),
    sourceContentHash: row.source_content_hash ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapVerifiedProductFact(row: QueryResultRow): VerifiedProductFact {
  return {
    id: row.id,
    productId: row.product_id ?? null,
    productKey: row.product_key,
    productName: row.product_name,
    attribute: row.attribute,
    value: row.value,
    sourceType: row.source_type,
    sourceUrl: row.source_url ?? null,
    sourceTitle: row.source_title ?? null,
    evidence: row.evidence ?? null,
    confidence: row.confidence as VerifiedProductFactConfidence,
    status: row.status,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastVerifiedAt: row.last_verified_at.toISOString(),
    hitCount: Number(row.hit_count ?? 0),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

export interface LeadOutboxItem {
  id: string;
  leadId: string;
  sessionId: string;
  turnId: string | null;
  destination: string;
  payload: Record<string, unknown>;
  status: string;
  attemptCount: number;
  nextAttemptAt?: string | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapLeadOutboxItem(row: QueryResultRow): LeadOutboxItem {
  return {
    id: row.id,
    leadId: row.lead_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    destination: row.destination,
    payload: row.payload ?? {},
    status: row.status,
    attemptCount: Number(row.attempt_count ?? 0),
    nextAttemptAt: row.next_attempt_at ? row.next_attempt_at.toISOString() : null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function isoTimestamp(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  return new Date(0).toISOString();
}

function mapAssistantFeedbackQueueItem(row: QueryResultRow): AssistantFeedbackQueueItem {
  return AssistantFeedbackQueueItemSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    userMessageId: row.user_message_id ?? null,
    assistantMessageId: row.assistant_message_id,
    rating: row.rating,
    status: row.status,
    buyerMessage: row.buyer_message,
    assistantAnswer: row.assistant_answer,
    policyEvidence: row.policy_evidence ?? {},
    modelEvidence: row.model_evidence ?? {},
    toolEvidence: row.tool_evidence ?? [],
    cardEvidence: row.card_evidence ?? [],
    diagnosticMetadata: row.diagnostic_metadata ?? {},
    feedbackCreatedAt: isoTimestamp(row.feedback_created_at),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  });
}

export interface CatalogFreshnessReport {
  status: 'fresh' | 'stale' | 'unknown';
  syncHealth: ReturnType<typeof evaluateCatalogSyncHealth>;
  latestRun: {
    id: string;
    sourceType: string;
    sourceLocation: string;
    syncMode: CatalogSyncMode;
    status: 'running' | 'completed' | 'failed';
    coverageComplete: boolean;
    discoveredItemCount: number;
    syncedItemCount: number;
    failedItemCount: number;
    startedAt: string;
    heartbeatAt: string;
    finishedAt: string | null;
  } | null;
  lastSuccessfulSyncAt: string | null;
  products: {
    active: number;
    inactive: number;
    stale: number;
  };
  pages: {
    active: number;
    inactive: number;
    stale: number;
  };
}

function mapBackfillProduct(row: QueryResultRow): EmbeddingBackfillProduct {
  return {
    product: mapProduct(row),
    hasEmbedding: Boolean(row.has_embedding),
    embeddingModel: row.embedding_model ?? null,
    embeddingSourceHash: row.embedding_source_hash ?? null,
    embeddingUpdatedAt: row.embedding_updated_at ? row.embedding_updated_at.toISOString() : null
  };
}

function mapBackfillCatalogPage(row: QueryResultRow): EmbeddingBackfillCatalogPage {
  return {
    page: mapCatalogPage(row),
    hasEmbedding: Boolean(row.has_embedding),
    embeddingModel: row.embedding_model ?? null,
    embeddingSourceHash: row.embedding_source_hash ?? null,
    embeddingUpdatedAt: row.embedding_updated_at ? row.embedding_updated_at.toISOString() : null
  };
}

const ruStopWords = new Set([
  'нужна',
  'нужен',
  'нужно',
  'для',
  'чтобы',
  'что',
  'посоветуете',
  'посоветуй',
  'подбор',
  'вероятно',
  'важны',
  'важен',
  'могла',
  'мог',
  'сама',
  'сам',
  'есть',
  'под',
  'или',
  'как',
  'это',
  'будет',
  'буду'
]);

function searchTokens(query: string) {
  return [...new Set(
    query
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
      .split(/\s+/)
      .map((word) => word.trim())
      .filter((word) => word.length >= 3 && !ruStopWords.has(word))
  )].slice(0, 16);
}

export class ConversationRepository {
  constructor(private readonly db: Db = pool) {}

  async createSession(input: { visitorId?: string; pageUrl?: string; userAgent?: string }) {
    const inserted = await this.db.query(
      `INSERT INTO conversation_sessions(visitor_id, page_url, user_agent, need_state, title)
       VALUES ($1, $2, $3, $4::jsonb, 'Диалог')
       RETURNING *`,
      [input.visitorId ?? null, input.pageUrl ?? null, input.userAgent ?? null, jsonbParam(emptyNeedState())]
    );
    const result = await this.db.query(
      `UPDATE conversation_sessions
       SET title = 'Диалог #' || conversation_number
       WHERE id = $1
       RETURNING *`,
      [inserted.rows[0].id]
    );
    return mapSession(result.rows[0] ?? inserted.rows[0]);
  }

  async getSession(id: string) {
    const result = await this.db.query('SELECT * FROM conversation_sessions WHERE id = $1', [id]);
    return result.rowCount ? mapSession(result.rows[0]) : null;
  }

  async deleteSession(id: string) {
    const result = await this.db.query('DELETE FROM conversation_sessions WHERE id = $1 RETURNING *', [id]);
    return result.rowCount ? mapSession(result.rows[0]) : null;
  }

  async touchSession(id: string) {
    const result = await this.db.query(
      `UPDATE conversation_sessions
       SET last_heartbeat_at = now()
       WHERE id = $1 AND status = 'active'
       RETURNING *`,
      [id]
    );
    return result.rowCount ? mapSession(result.rows[0]) : null;
  }

  async closeSession(id: string, status: 'closed' | 'expired' = 'closed') {
    const result = await this.db.query(
      `UPDATE conversation_sessions
       SET status = $2, closed_at = coalesce(closed_at, now()), updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, status]
    );
    return result.rowCount ? mapSession(result.rows[0]) : null;
  }

  async expireInactiveSessions(maxInactiveMinutes = 30) {
    const result = await this.db.query(
      `UPDATE conversation_sessions
       SET status = 'expired', closed_at = now(), updated_at = now()
       WHERE status = 'active' AND last_heartbeat_at < now() - ($1 || ' minutes')::interval
       RETURNING id`,
      [maxInactiveMinutes]
    );
    return result.rowCount ?? 0;
  }

  async deleteOldEmptyWidgetSessions(maxAgeHours = 24) {
    const result = await this.db.query(
      `DELETE FROM conversation_sessions s
       WHERE s.page_url IS NOT NULL
         AND s.created_at < now() - ($1 || ' hours')::interval
         AND NOT EXISTS (
           SELECT 1 FROM messages m WHERE m.session_id = s.id
         )`,
      [maxAgeHours]
    );
    return result.rowCount ?? 0;
  }

  async deleteEmptyNonWidgetSessions() {
    const result = await this.db.query(
      `DELETE FROM conversation_sessions s
       WHERE s.page_url IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM messages m WHERE m.session_id = s.id
         )`
    );
    return result.rowCount ?? 0;
  }

  async updateHistorySummary(sessionId: string, summary: string) {
    const result = await this.db.query(
      `UPDATE conversation_sessions
       SET history_summary = $2, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [sessionId, summary]
    );
    return mapSession(result.rows[0]);
  }

  async updateNeedState(sessionId: string, needState: CustomerNeedState) {
    const result = await this.db.query(
      `UPDATE conversation_sessions
       SET need_state = $2::jsonb, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [sessionId, jsonbParam(needState)]
    );
    return mapSession(result.rows[0]);
  }

  async addMessage(input: { sessionId: string; role: MessageRole; content: string; metadata?: Record<string, unknown> }) {
    const result = await this.db.query(
      `INSERT INTO messages(session_id, role, content, metadata)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING *`,
      [input.sessionId, input.role, input.content, jsonbParam(input.metadata ?? {})]
    );
    await this.db.query(
      `UPDATE conversation_sessions
       SET updated_at = now()
       WHERE id = $1`,
      [input.sessionId]
    );
    return mapMessage(result.rows[0]);
  }

  async createTurn(input: {
    sessionId: string;
    id?: string;
    clientMessageId: string;
    requestHash: string;
    status?: ConversationTurn['status'];
    stage?: string;
    activeNeedsBefore?: unknown;
  }) {
    try {
      const result = await this.db.query(
        `INSERT INTO conversation_turns(
           id,
           session_id,
           client_message_id,
           request_hash,
           status,
           stage,
           active_needs_before
         )
         VALUES (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (session_id, client_message_id) DO UPDATE
         SET updated_at = conversation_turns.updated_at
         WHERE conversation_turns.request_hash = EXCLUDED.request_hash
         RETURNING *`,
        [
          input.id ?? null,
          input.sessionId,
          input.clientMessageId,
          input.requestHash,
          input.status ?? 'received',
          input.stage ?? null,
          jsonbParam(input.activeNeedsBefore)
        ]
      );
      if (!result.rowCount) throw new ClientMessagePayloadConflictError();
      return mapConversationTurn(result.rows[0]);
    } catch (error) {
      const pgError = error as { code?: string; constraint?: string };
      if (pgError.code !== '23505' || pgError.constraint !== 'conversation_turns_one_active_per_session_idx') {
        throw error;
      }
      const active = await this.db.query(
        `SELECT id
         FROM conversation_turns
         WHERE session_id = $1
           AND status IN ('received', 'need_extracted', 'planned', 'answering')
         ORDER BY created_at DESC
         LIMIT 1`,
        [input.sessionId]
      );
      throw new ActiveConversationTurnError(active.rows[0]?.id);
    }
  }

  async claimTurnExecution(input: {
    sessionId: string;
    turnId: string;
    ownerId: string;
    leaseMs: number;
  }) {
    const leaseMs = Math.max(1_000, Math.min(300_000, Math.trunc(input.leaseMs)));
    const result = await this.db.query(
      `UPDATE conversation_turns
       SET execution_owner = $3::uuid,
           execution_lease_expires_at = now() + ($4::text || ' milliseconds')::interval,
           updated_at = now()
       WHERE session_id = $1
         AND id = $2
         AND status NOT IN ('completed', 'recovered')
         AND (
           execution_owner IS NULL
           OR execution_owner = $3::uuid
           OR execution_lease_expires_at IS NULL
           OR execution_lease_expires_at < now()
         )
       RETURNING *`,
      [input.sessionId, input.turnId, input.ownerId, leaseMs]
    );
    return result.rowCount ? mapConversationTurn(result.rows[0]) : null;
  }

  async renewTurnExecution(input: {
    sessionId: string;
    turnId: string;
    ownerId: string;
    leaseMs: number;
  }) {
    const leaseMs = Math.max(1_000, Math.min(300_000, Math.trunc(input.leaseMs)));
    const result = await this.db.query(
      `UPDATE conversation_turns
       SET execution_lease_expires_at = now() + ($4::text || ' milliseconds')::interval,
           updated_at = now()
       WHERE session_id = $1
         AND id = $2
         AND execution_owner = $3::uuid
       RETURNING *`,
      [input.sessionId, input.turnId, input.ownerId, leaseMs]
    );
    return result.rowCount ? mapConversationTurn(result.rows[0]) : null;
  }

  async releaseTurnExecution(input: { sessionId: string; turnId: string; ownerId: string }) {
    const result = await this.db.query(
      `UPDATE conversation_turns
       SET execution_owner = NULL,
           execution_lease_expires_at = NULL,
           updated_at = now()
       WHERE session_id = $1
         AND id = $2
         AND execution_owner = $3::uuid
       RETURNING *`,
      [input.sessionId, input.turnId, input.ownerId]
    );
    return result.rowCount ? mapConversationTurn(result.rows[0]) : null;
  }

  async getTurn(sessionId: string, turnId: string) {
    const result = await this.db.query(
      'SELECT * FROM conversation_turns WHERE session_id = $1 AND id = $2',
      [sessionId, turnId]
    );
    return result.rowCount ? mapConversationTurn(result.rows[0]) : null;
  }

  async listTurns(sessionId: string, limit = 200) {
    const result = await this.db.query(
      `SELECT * FROM conversation_turns
       WHERE session_id = $1
       ORDER BY created_at ASC
       LIMIT $2`,
      [sessionId, limit]
    );
    return result.rows.map(mapConversationTurn);
  }

  async updateTurn(input: {
    sessionId: string;
    turnId: string;
    status?: ConversationTurn['status'];
    stage?: string | null;
    userMessageId?: string | null;
    assistantMessageId?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    plannerContract?: unknown;
    activeNeedsBefore?: unknown;
    activeNeedsAfter?: unknown;
  }) {
    const result = await this.db.query(
      `UPDATE conversation_turns
       SET status = coalesce($3, status),
           stage = coalesce($4, stage),
           user_message_id = coalesce($5::uuid, user_message_id),
           assistant_message_id = coalesce($6::uuid, assistant_message_id),
           error_code = coalesce($7, error_code),
           error_message = coalesce($8, error_message),
           planner_contract = coalesce($9::jsonb, planner_contract),
           active_needs_before = coalesce($10::jsonb, active_needs_before),
           active_needs_after = coalesce($11::jsonb, active_needs_after),
           updated_at = now()
       WHERE session_id = $1 AND id = $2
       RETURNING *`,
      [
        input.sessionId,
        input.turnId,
        input.status ?? null,
        input.stage ?? null,
        input.userMessageId ?? null,
        input.assistantMessageId ?? null,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        jsonbParam(input.plannerContract),
        jsonbParam(input.activeNeedsBefore),
        jsonbParam(input.activeNeedsAfter)
      ]
    );
    return result.rowCount ? mapConversationTurn(result.rows[0]) : null;
  }

  async upsertDialogueLedgerEvent(input: {
    sessionId: string;
    turnId: string;
    eventId: string;
    eventType: string;
    scope: string;
    payload: unknown;
    evidence: string;
    source: string;
    status: string;
  }) {
    const result = await this.db.query(
      `INSERT INTO dialogue_ledger_events(session_id, turn_id, event_id, event_type, scope, payload, evidence, source, status)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       ON CONFLICT (session_id, event_id) DO UPDATE
       SET event_id = dialogue_ledger_events.event_id
       RETURNING *`,
      [
        input.sessionId,
        input.turnId,
        input.eventId,
        input.eventType,
        input.scope,
        jsonbParam(input.payload),
        input.evidence,
        input.source,
        input.status
      ]
    );
    return result.rows[0] ?? null;
  }

  async listDialogueLedgerEvents(sessionId: string, limit = 500) {
    const result = await this.db.query(
      `SELECT *
       FROM (
         SELECT *
         FROM dialogue_ledger_events
         WHERE session_id = $1
         ORDER BY event_seq DESC
         LIMIT $2
       ) AS recent_events
       ORDER BY event_seq ASC`,
      [sessionId, limit]
    );
    return result.rows;
  }

  async listDialogueLedgerEventsAfter(sessionId: string, afterEventSeq: number, limit = 2_000) {
    const result = await this.db.query(
      `SELECT *
       FROM dialogue_ledger_events
       WHERE session_id = $1
         AND event_seq > $2
       ORDER BY event_seq ASC
       LIMIT $3`,
      [sessionId, afterEventSeq, limit]
    );
    return result.rows;
  }

  async getDialogueLedgerSnapshot(sessionId: string) {
    const result = await this.db.query(
      'SELECT * FROM dialogue_ledger_snapshots WHERE session_id = $1',
      [sessionId]
    );
    return result.rowCount ? result.rows[0] : null;
  }

  async saveDialogueLedgerSnapshot(input: {
    sessionId: string;
    throughEventSeq: number;
    eventCount: number;
    state: unknown;
    recentEvents: unknown[];
  }) {
    const result = await this.db.query(
      `INSERT INTO dialogue_ledger_snapshots(
         session_id,
         through_event_seq,
         event_count,
         state,
         recent_events
       )
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
       ON CONFLICT (session_id) DO UPDATE
       SET through_event_seq = EXCLUDED.through_event_seq,
           event_count = EXCLUDED.event_count,
           state = EXCLUDED.state,
           recent_events = EXCLUDED.recent_events,
           updated_at = now()
       WHERE dialogue_ledger_snapshots.through_event_seq <= EXCLUDED.through_event_seq
       RETURNING *`,
      [
        input.sessionId,
        input.throughEventSeq,
        input.eventCount,
        jsonbParam(input.state),
        jsonbParam(input.recentEvents)
      ]
    );
    return result.rows[0] ?? null;
  }

  async latestDialogueLedgerEventSeq(sessionId: string) {
    const result = await this.db.query(
      `SELECT coalesce(max(event_seq), 0)::text AS event_seq,
              count(*)::text AS event_count
       FROM dialogue_ledger_events
       WHERE session_id = $1`,
      [sessionId]
    );
    return {
      eventSeq: Number(result.rows[0]?.event_seq ?? 0),
      eventCount: Number(result.rows[0]?.event_count ?? 0)
    };
  }

  async upsertTurnCheckpoint(input: {
    sessionId: string;
    turnId: string;
    checkpoint: string;
    status: string;
    artifactRef?: string | null;
    payload?: unknown;
    errorCode?: string | null;
    errorMessage?: string | null;
  }) {
    const result = await this.db.query(
      `INSERT INTO turn_checkpoints(session_id, turn_id, checkpoint, status, artifact_ref, payload, error_code, error_message)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       ON CONFLICT (session_id, turn_id, checkpoint) DO UPDATE
       SET status = EXCLUDED.status,
           artifact_ref = EXCLUDED.artifact_ref,
           payload = EXCLUDED.payload,
           error_code = EXCLUDED.error_code,
           error_message = EXCLUDED.error_message,
           updated_at = now()
       RETURNING *`,
      [
        input.sessionId,
        input.turnId,
        input.checkpoint,
        input.status,
        input.artifactRef ?? null,
        jsonbParam(input.payload ?? {}),
        input.errorCode ?? null,
        input.errorMessage ?? null
      ]
    );
    return result.rows[0] ?? null;
  }

  async listTurnCheckpoints(sessionId: string, turnId: string) {
    const result = await this.db.query(
      `SELECT *
       FROM turn_checkpoints
       WHERE session_id = $1 AND turn_id = $2
       ORDER BY created_at ASC`,
      [sessionId, turnId]
    );
    return result.rows;
  }

  async saveToolArtifact(input: {
    sessionId: string;
    turnId: string;
    toolName: string;
    toolRequestId: string;
    status: string;
    payload: unknown;
    warnings?: unknown[];
    errorCode?: string | null;
  }) {
    const result = await this.db.query(
      `INSERT INTO tool_artifacts(session_id, turn_id, tool_name, tool_request_id, status, payload, warnings, error_code)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
       ON CONFLICT (session_id, turn_id, tool_request_id) DO UPDATE
       SET tool_name = EXCLUDED.tool_name,
           status = EXCLUDED.status,
           payload = EXCLUDED.payload,
           warnings = EXCLUDED.warnings,
           error_code = EXCLUDED.error_code
       RETURNING *`,
      [
        input.sessionId,
        input.turnId,
        input.toolName,
        input.toolRequestId,
        input.status,
        jsonbParam(input.payload),
        jsonbParam(input.warnings ?? []),
        input.errorCode ?? null
      ]
    );
    return result.rows[0] ?? null;
  }

  async listToolArtifacts(sessionId: string, turnId: string) {
    const result = await this.db.query(
      `SELECT *
       FROM tool_artifacts
       WHERE session_id = $1 AND turn_id = $2
       ORDER BY created_at ASC`,
      [sessionId, turnId]
    );
    return result.rows;
  }

  async saveAnswerContract(input: {
    sessionId: string;
    turnId: string;
    answerText: string;
    contract: unknown;
    review?: unknown;
    responsePayload?: unknown;
    status: string;
  }) {
    const result = await this.db.query(
      `INSERT INTO answer_contracts(session_id, turn_id, answer_text, contract, review, response_payload, status)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7)
       ON CONFLICT (session_id, turn_id) WHERE status = 'final' DO UPDATE
       SET answer_text = EXCLUDED.answer_text,
           contract = EXCLUDED.contract,
           review = EXCLUDED.review,
           response_payload = EXCLUDED.response_payload
       RETURNING *`,
      [
        input.sessionId,
        input.turnId,
        input.answerText,
        jsonbParam(input.contract),
        jsonbParam(input.review ?? null),
        jsonbParam(input.responsePayload),
        input.status
      ]
    );
    return result.rows[0] ?? null;
  }

  async getFinalAnswerContract(sessionId: string, turnId: string) {
    const result = await this.db.query(
      `SELECT *
       FROM answer_contracts
       WHERE session_id = $1
         AND turn_id = $2
         AND status = 'final'
       ORDER BY created_at DESC
       LIMIT 1`,
      [sessionId, turnId]
    );
    return result.rows[0] ?? null;
  }

  async addAssistantMessageForTurn(input: {
    sessionId: string;
    turnId: string;
    content: string;
    metadata?: Record<string, unknown>;
    recovered?: boolean;
  }) {
    const result = await this.db.query(
      `WITH locked_turn AS (
         SELECT *
         FROM conversation_turns
         WHERE session_id = $1 AND id = $2
         FOR UPDATE
       ),
       existing_message AS (
         SELECT m.*
         FROM messages m
         JOIN locked_turn t ON t.assistant_message_id = m.id
         WHERE m.role = 'assistant'
       ),
       inserted_message AS (
         INSERT INTO messages(session_id, role, content, metadata)
         SELECT locked_turn.session_id, 'assistant', $3, $4::jsonb
         FROM locked_turn
         WHERE NOT EXISTS (SELECT 1 FROM existing_message)
         RETURNING *
       ),
       chosen_message AS (
         SELECT * FROM existing_message
         UNION ALL
         SELECT * FROM inserted_message
         LIMIT 1
       ),
       updated_turn AS (
         UPDATE conversation_turns
         SET assistant_message_id = (SELECT id FROM chosen_message),
             status = CASE WHEN $5::boolean THEN 'recovered' ELSE 'completed' END,
             stage = 'assistant_message_saved',
             updated_at = now()
         WHERE session_id = $1 AND id = $2
         RETURNING *
       )
       SELECT *
       FROM chosen_message`,
      [
        input.sessionId,
        input.turnId,
        input.content,
        jsonbParam(input.metadata ?? {}),
        input.recovered ?? false
      ]
    );
    if (!result.rowCount) throw new Error('Unable to save assistant message for turn');
    await this.db.query(
      `UPDATE conversation_sessions
       SET updated_at = now()
       WHERE id = $1`,
      [input.sessionId]
    );
    return mapMessage(result.rows[0]);
  }

  async addUserMessageForTurn(input: {
    sessionId: string;
    turnId: string;
    content: string;
    metadata?: Record<string, unknown>;
    activeNeedsBefore?: unknown;
  }) {
    const result = await this.db.query(
      `WITH locked_turn AS (
         SELECT *
         FROM conversation_turns
         WHERE session_id = $1 AND id = $2
         FOR UPDATE
       ),
       existing_message AS (
         SELECT m.*
         FROM messages m
         JOIN locked_turn t ON t.user_message_id = m.id
         WHERE m.role = 'user'
       ),
       inserted_message AS (
         INSERT INTO messages(session_id, role, content, metadata)
         SELECT locked_turn.session_id, 'user', $3, $4::jsonb
         FROM locked_turn
         WHERE NOT EXISTS (SELECT 1 FROM existing_message)
         RETURNING *
       ),
       chosen_message AS (
         SELECT * FROM existing_message
         UNION ALL
         SELECT * FROM inserted_message
         LIMIT 1
       ),
       updated_turn AS (
         UPDATE conversation_turns
         SET user_message_id = (SELECT id FROM chosen_message),
             stage = 'user_message_saved',
             active_needs_before = coalesce($5::jsonb, active_needs_before),
             updated_at = now()
         WHERE session_id = $1 AND id = $2
         RETURNING *
       )
       SELECT *
       FROM chosen_message`,
      [
        input.sessionId,
        input.turnId,
        input.content,
        jsonbParam(input.metadata ?? {}),
        jsonbParam(input.activeNeedsBefore)
      ]
    );
    if (!result.rowCount) throw new Error('Unable to save user message for turn');
    await this.db.query(
      `UPDATE conversation_sessions
       SET updated_at = now()
       WHERE id = $1`,
      [input.sessionId]
    );
    return mapMessage(result.rows[0]);
  }

  async enqueueLeadOutbox(input: {
    leadId: string;
    sessionId: string;
    turnId: string | null;
    destination: string;
    payload: unknown;
    status?: string;
    nextAttemptAt?: string | null;
  }) {
    const result = await this.db.query(
      `INSERT INTO lead_outbox(lead_id, session_id, turn_id, destination, payload, status, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::timestamptz)
       ON CONFLICT (lead_id, destination) DO UPDATE
       SET payload = EXCLUDED.payload,
           status = lead_outbox.status,
           next_attempt_at = lead_outbox.next_attempt_at,
           updated_at = now()
       RETURNING *`,
      [
        input.leadId,
        input.sessionId,
        input.turnId,
        input.destination,
        jsonbParam(input.payload),
        input.status ?? 'pending',
        input.nextAttemptAt ?? null
      ]
    );
    return result.rows[0] ?? null;
  }

  async addAgentTrace(input: {
    sessionId?: string | null;
    turnId?: string | null;
    phase: string;
    eventType: string;
    payload?: unknown;
    redacted?: boolean;
  }) {
    const result = await this.db.query(
      `INSERT INTO agent_traces(session_id, turn_id, phase, event_type, payload, redacted)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6)
       RETURNING *`,
      [
        input.sessionId ?? null,
        input.turnId ?? null,
        input.phase,
        input.eventType,
        jsonbParam(input.payload ?? {}),
        input.redacted ?? true
      ]
    );
    return result.rows[0] ?? null;
  }

  async listAgentTraces(sessionId: string, turnId?: string, limit = 200) {
    const params: unknown[] = [sessionId, limit];
    const turnClause = turnId ? 'AND turn_id = $3' : '';
    if (turnId) params.push(turnId);
    const result = await this.db.query(
      `SELECT *
       FROM agent_traces
       WHERE session_id = $1
         ${turnClause}
       ORDER BY created_at DESC
       LIMIT $2`,
      params
    );
    return result.rows;
  }

  async updateAssistantFeedback(input: {
    sessionId: string;
    messageId: string;
    rating: 'positive' | 'negative' | 'wrong_cards';
  }) {
    const feedback = {
      rating: input.rating,
      createdAt: new Date().toISOString()
    };
    const result = await this.db.query(
      `WITH updated AS (
         UPDATE messages
         SET metadata = jsonb_set(
           coalesce(metadata, '{}'::jsonb),
           '{feedback}',
           $3::jsonb,
           true
         )
         WHERE id = $1 AND session_id = $2 AND role = 'assistant'
         RETURNING *
       ), turn_context AS (
         SELECT t.id AS turn_id, t.user_message_id
         FROM conversation_turns t
         JOIN updated u ON u.id = t.assistant_message_id
         LIMIT 1
       ), buyer_message AS (
         SELECT m.id, m.content
         FROM messages m
         JOIN turn_context t ON t.user_message_id = m.id
         WHERE m.role = 'user'
         LIMIT 1
       ), queued AS (
         INSERT INTO assistant_feedback_events(
           session_id,
           turn_id,
           user_message_id,
           assistant_message_id,
           rating,
           buyer_message,
           assistant_answer,
           policy_evidence,
           model_evidence,
           tool_evidence,
           card_evidence,
           diagnostic_metadata,
           feedback_created_at
         )
         SELECT
           u.session_id,
           t.turn_id,
           buyer.id,
           u.id,
           $4,
           buyer.content,
           u.content,
           jsonb_build_object(
             'version', u.metadata #>> '{managerPolicy,packVersion}',
             'hash', u.metadata #>> '{managerPolicy,packHash}',
             'selectedRuleIds', coalesce(u.metadata #> '{managerPolicy,selectedByPlanner}', '[]'::jsonb),
             'reviewMode', u.metadata #>> '{managerPolicy,reviewMode}',
             'reviewReason', u.metadata #>> '{managerPolicy,reviewReason}'
           ),
           jsonb_build_object(
             'plannerModel', u.metadata #>> '{models,planner}',
             'answerModel', u.metadata #>> '{models,answer}',
             'reviewerModel', u.metadata #>> '{models,reviewer}',
             'responseIds', '[]'::jsonb
           ),
           coalesce(u.metadata->'toolResults', '[]'::jsonb),
           coalesce((
             SELECT jsonb_agg(jsonb_build_object(
               'productId', card.value->>'id',
               'name', card.value->>'name',
               'position', card.ordinality - 1,
               'price', card.value->'price',
               'currency', card.value->>'currency',
               'visible', true,
               'sourceUrl', card.value->>'sourceUrl'
             ) ORDER BY card.ordinality)
             FROM jsonb_array_elements(coalesce(u.metadata->'productCards', '[]'::jsonb))
               WITH ORDINALITY AS card(value, ordinality)
           ), '[]'::jsonb),
           jsonb_build_object(
             'runtimeMode', u.metadata->'runtimeMode',
             'turnBudget', u.metadata->'turnBudget',
             'selectionReadiness', u.metadata->'selectionReadiness',
             'warnings', coalesce(u.metadata->'warnings', '[]'::jsonb)
           ),
           now()
         FROM updated u
         JOIN turn_context t ON true
         JOIN buyer_message buyer ON true
         WHERE $4::text IN ('negative', 'wrong_cards')
         ON CONFLICT (assistant_message_id, rating) DO UPDATE SET
           buyer_message = EXCLUDED.buyer_message,
           assistant_answer = EXCLUDED.assistant_answer,
           policy_evidence = EXCLUDED.policy_evidence,
           model_evidence = EXCLUDED.model_evidence,
           tool_evidence = EXCLUDED.tool_evidence,
           card_evidence = EXCLUDED.card_evidence,
           diagnostic_metadata = EXCLUDED.diagnostic_metadata,
           feedback_created_at = EXCLUDED.feedback_created_at,
           status = CASE
             WHEN assistant_feedback_events.status IN ('resolved', 'dismissed') THEN assistant_feedback_events.status
             ELSE 'pending'
           END,
           updated_at = now()
         RETURNING id
       )
       SELECT * FROM updated`,
      [
        input.messageId,
        input.sessionId,
        jsonbParam(feedback),
        input.rating
      ]
    );
    return result.rowCount ? mapMessage(result.rows[0]) : null;
  }

  async listAssistantFeedbackQueue(input: {
    status?: AssistantFeedbackQueueStatus;
    rating?: AssistantFeedbackRating;
    statuses?: AssistantFeedbackQueueStatus[];
    ratings?: AssistantFeedbackRating[];
    limit?: number;
  } = {}) {
    const params: unknown[] = [Math.max(1, Math.min(500, input.limit ?? 100))];
    const clauses: string[] = [];
    if (input.status) {
      params.push(input.status);
      clauses.push(`status = $${params.length}`);
    }
    if (input.rating) {
      params.push(input.rating);
      clauses.push(`rating = $${params.length}`);
    }
    if (input.statuses?.length) {
      params.push(input.statuses);
      clauses.push(`status = ANY($${params.length}::text[])`);
    }
    if (input.ratings?.length) {
      params.push(input.ratings);
      clauses.push(`rating = ANY($${params.length}::text[])`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.db.query(
      `SELECT *
       FROM assistant_feedback_events
       ${where}
       ORDER BY created_at ASC
       LIMIT $1`,
      params
    );
    return result.rows.map(mapAssistantFeedbackQueueItem);
  }

  async getAssistantFeedbackQueueItem(id: string) {
    const result = await this.db.query(
      'SELECT * FROM assistant_feedback_events WHERE id = $1',
      [id]
    );
    return result.rowCount ? mapAssistantFeedbackQueueItem(result.rows[0]) : null;
  }

  async updateAssistantFeedbackQueueStatus(input: {
    id: string;
    status: AssistantFeedbackQueueStatus;
  }) {
    const result = await this.db.query(
      `UPDATE assistant_feedback_events
       SET status = $2,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [input.id, input.status]
    );
    return result.rowCount ? mapAssistantFeedbackQueueItem(result.rows[0]) : null;
  }

  async markAssistantFeedbackExported(input: {
    id: string;
    fixture: AssistantFeedbackRegressionFixture;
  } | {
    exportedAt: string;
    items: Array<{ eventId: string; fixture: AssistantFeedbackRegressionFixture }>;
  }) {
    if ('items' in input) {
      if (!input.items.length) return [];
      const result = await this.db.query(
        `WITH export_items AS (
           SELECT event_id, fixture
           FROM jsonb_to_recordset($1::jsonb) AS item(event_id uuid, fixture jsonb)
         )
         UPDATE assistant_feedback_events feedback
         SET status = 'exported',
             exported_fixture = export_items.fixture,
             exported_at = $2::timestamptz,
             updated_at = now()
         FROM export_items
         WHERE feedback.id = export_items.event_id
           AND feedback.status IN ('pending', 'in_review', 'exported')
         RETURNING feedback.*`,
        [
          jsonbParam(input.items.map((item) => ({
            event_id: item.eventId,
            fixture: item.fixture
          }))),
          input.exportedAt
        ]
      );
      return result.rows.map(mapAssistantFeedbackQueueItem);
    }
    const result = await this.db.query(
      `UPDATE assistant_feedback_events
       SET status = 'exported',
           exported_fixture = $2::jsonb,
           exported_at = now(),
           updated_at = now()
       WHERE id = $1
         AND status IN ('pending', 'in_review', 'exported')
       RETURNING *`,
      [input.id, jsonbParam(input.fixture)]
    );
    return result.rowCount ? mapAssistantFeedbackQueueItem(result.rows[0]) : null;
  }

  async listMessages(sessionId: string, limit = 80) {
    const result = await this.db.query(
      `SELECT * FROM (
         SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2
       ) recent ORDER BY created_at ASC`,
      [sessionId, limit]
    );
    return result.rows.map(mapMessage);
  }

  async updateSessionTopic(sessionId: string, topic: string) {
    const cleanTopic = topic.trim().replace(/\s+/g, ' ').slice(0, 90);
    if (!cleanTopic) return this.getSession(sessionId);
    const result = await this.db.query(
      `UPDATE conversation_sessions
       SET topic = $2,
           title = 'Диалог #' || conversation_number || ': ' || $2,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [sessionId, cleanTopic]
    );
    return result.rowCount ? mapSession(result.rows[0]) : null;
  }

  async listSessionStats() {
    const result = await this.db.query(
      `WITH message_counts AS (
         SELECT session_id, count(*) AS message_count
         FROM messages
         GROUP BY session_id
       )
       SELECT
         count(*)::int AS total_sessions,
         count(*) FILTER (WHERE coalesce(message_counts.message_count, 0) > 0)::int AS sessions_with_messages,
         count(*) FILTER (WHERE coalesce(message_counts.message_count, 0) = 0)::int AS empty_sessions,
         coalesce((SELECT count(*) FROM messages), 0)::int AS total_messages
       FROM conversation_sessions s
       LEFT JOIN message_counts ON message_counts.session_id = s.id`
    );
    const row = result.rows[0] ?? {};
    return {
      totalSessions: Number(row.total_sessions ?? 0),
      sessionsWithMessages: Number(row.sessions_with_messages ?? 0),
      emptySessions: Number(row.empty_sessions ?? 0),
      totalMessages: Number(row.total_messages ?? 0)
    };
  }

  async listSessions(limit = 100, filter: 'all' | 'withMessages' | 'empty' = 'all') {
    const filterClause = filter === 'withMessages'
      ? 'WHERE coalesce(message_counts.message_count, 0) > 0'
      : filter === 'empty'
        ? 'WHERE coalesce(message_counts.message_count, 0) = 0'
        : '';
    const result = await this.db.query(
      `WITH latest AS (
         SELECT DISTINCT ON (session_id)
           session_id,
           created_at AS latest_message_at
         FROM messages
         ORDER BY session_id, created_at DESC
       ),
       latest_user AS (
         SELECT DISTINCT ON (session_id)
           session_id,
           content AS latest_user_message
         FROM messages
         WHERE role = 'user'
         ORDER BY session_id, created_at DESC
       ),
       latest_assistant AS (
         SELECT DISTINCT ON (session_id)
           session_id,
           content AS latest_assistant_message
         FROM messages
         WHERE role = 'assistant'
         ORDER BY session_id, created_at DESC
       ),
       message_counts AS (
         SELECT session_id, count(*) AS message_count
         FROM messages
         GROUP BY session_id
       ),
       lead_counts AS (
         SELECT session_id, count(*) AS lead_count
         FROM leads
         WHERE session_id IS NOT NULL
         GROUP BY session_id
       )
       SELECT
         s.*,
         coalesce(message_counts.message_count, 0) AS message_count,
         coalesce(lead_counts.lead_count, 0) AS lead_count,
         latest.latest_message_at,
         latest_user.latest_user_message,
         latest_assistant.latest_assistant_message
       FROM conversation_sessions s
       LEFT JOIN latest ON latest.session_id = s.id
       LEFT JOIN latest_user ON latest_user.session_id = s.id
       LEFT JOIN latest_assistant ON latest_assistant.session_id = s.id
       LEFT JOIN message_counts ON message_counts.session_id = s.id
       LEFT JOIN lead_counts ON lead_counts.session_id = s.id
       ${filterClause}
       ORDER BY coalesce(latest.latest_message_at, s.created_at) DESC, s.conversation_number DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapConversationSummary);
  }
}

export class ProductRepository {
  private readonly catalogSyncLocks = new Map<string, { client: PoolClient; lockIdentity: string }>();

  constructor(private readonly db: Db = pool) {}

  async getActiveCatalogInventoryCounts() {
    const result = await this.db.query(
      `SELECT
         (SELECT count(*)::int
          FROM products
          WHERE is_active
            AND raw->>'sourceType' = 'site') AS active_products,
         (SELECT count(*)::int
          FROM catalog_pages
          WHERE is_active) AS active_pages`
    );
    return {
      products: Number(result.rows[0]?.active_products ?? 0),
      pages: Number(result.rows[0]?.active_pages ?? 0)
    };
  }

  async startCatalogSource(input: {
    type: 'site_crawl' | 'csv_import';
    location: string;
    syncMode?: CatalogSyncMode;
  }) {
    const syncMode = input.syncMode ?? 'partial';
    const lockIdentity = catalogSyncLockIdentity(input.type, input.location);
    let lock: { client: PoolClient; lockIdentity: string } | null = null;
    if (!('release' in this.db) && 'connect' in this.db && typeof this.db.connect === 'function') {
      const client = await (this.db as Pool).connect();
      try {
        const acquired = await client.query(
          'SELECT pg_try_advisory_lock(catalog_sync_advisory_key($1)) AS acquired',
          [lockIdentity]
        );
        if (!acquired.rows[0]?.acquired) {
          throw new Error(`catalog_sync_already_running:${lockIdentity}`);
        }
        lock = { client, lockIdentity };
      } catch (error) {
        client.release();
        throw error;
      }
    }
    const runner = lock?.client ?? this.db;
    try {
      const result = await runner.query(
        `WITH source AS (
           INSERT INTO catalog_sources(type, location)
           VALUES ($1, $2)
           RETURNING id
         )
         INSERT INTO catalog_sync_runs(id, source_type, source_location, lock_identity, sync_mode)
         SELECT id, $1, $2, $3, $4 FROM source
         RETURNING id`,
        [input.type, input.location, lockIdentity, syncMode]
      );
      const id = result.rows[0].id as string;
      if (lock) this.catalogSyncLocks.set(id, lock);
      return id;
    } catch (error) {
      if (lock) {
        await lock.client.query('SELECT pg_advisory_unlock(catalog_sync_advisory_key($1))', [lock.lockIdentity]).catch(() => undefined);
        lock.client.release();
      }
      throw error;
    }
  }

  async heartbeatCatalogSource(id: string) {
    const lock = this.catalogSyncLocks.get(id);
    const runner = lock?.client ?? this.db;
    const result = await runner.query(
      `UPDATE catalog_sync_runs
       SET heartbeat_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'running'`,
      [id]
    );
    if (result.rowCount !== 1) throw new Error(`catalog_sync_heartbeat_not_updated:${id}`);
  }

  async finishCatalogSource(
    id: string,
    status: 'completed' | 'failed',
    stats: Record<string, unknown>,
    error?: string,
    lifecycle: {
      coverageComplete?: boolean;
      discoveredItemCount?: number;
      syncedItemCount?: number;
      failedItemCount?: number;
      deactivateProducts?: boolean;
      deactivatePages?: boolean;
    } = {}
  ) {
    const lock = this.catalogSyncLocks.get(id);
    const runner = lock?.client ?? this.db;
    try {
      await runner.query(
        `WITH run_updated AS (
           UPDATE catalog_sync_runs
           SET status = $2,
               coverage_complete = $5,
               discovered_item_count = $6,
               synced_item_count = $7,
               failed_item_count = $8,
               stats = $3,
               error = $4,
               heartbeat_at = now(),
               finished_at = now(),
               updated_at = now()
           WHERE id = $1
           RETURNING id, started_at, deactivation_eligible
         ), eligible AS (
           SELECT id, started_at
           FROM run_updated
           WHERE deactivation_eligible
             AND ($9::boolean OR $10::boolean)
         ), deactivated_products AS (
           UPDATE products
           SET is_active = false,
               updated_at = now()
           FROM eligible
           WHERE $9::boolean
             AND products.is_active
             AND products.raw->>'sourceType' = 'site'
             AND products.last_seen_at < eligible.started_at
           RETURNING products.id
         ), deactivated_pages AS (
           UPDATE catalog_pages
           SET is_active = false,
               updated_at = now()
           FROM eligible
           WHERE $10::boolean
             AND catalog_pages.is_active
             AND catalog_pages.last_seen_at < eligible.started_at
           RETURNING catalog_pages.id
         ), deactivation_counts AS (
           SELECT
             (SELECT count(*)::int FROM deactivated_products) AS products,
             (SELECT count(*)::int FROM deactivated_pages) AS pages
         ), run_marked AS (
           UPDATE catalog_sync_runs
           SET deactivated_item_count = deactivation_counts.products + deactivation_counts.pages,
               deactivation_applied_at = now(),
               updated_at = now()
           FROM deactivation_counts
           WHERE id = $1
             AND EXISTS (SELECT 1 FROM eligible)
           RETURNING id
         )
         UPDATE catalog_sources
         SET status = $2, stats = $3, error = $4, finished_at = now()
         WHERE id = $1
           AND EXISTS (SELECT 1 FROM run_updated)`,
        [
          id,
          status,
          stats,
          error ?? null,
          status === 'completed' && Boolean(lifecycle.coverageComplete),
          Math.max(0, lifecycle.discoveredItemCount ?? 0),
          Math.max(0, lifecycle.syncedItemCount ?? 0),
          Math.max(0, lifecycle.failedItemCount ?? 0),
          lifecycle.deactivateProducts ?? false,
          lifecycle.deactivatePages ?? false
        ]
      );
    } finally {
      if (lock) {
        this.catalogSyncLocks.delete(id);
        await lock.client.query('SELECT pg_advisory_unlock(catalog_sync_advisory_key($1))', [lock.lockIdentity]).catch(() => undefined);
        lock.client.release();
      }
    }
  }

  async getCatalogFreshness(staleAfterHours = config.CATALOG_STALE_AFTER_HOURS): Promise<CatalogFreshnessReport> {
    const result = await this.db.query(
      `WITH latest_run AS (
         SELECT * FROM catalog_sync_runs ORDER BY started_at DESC LIMIT 1
       ), latest_success AS (
         SELECT finished_at
         FROM catalog_sync_runs
         WHERE status = 'completed'
           AND coverage_complete
           AND failed_item_count = 0
         ORDER BY finished_at DESC
         LIMIT 1
       ), product_counts AS (
         SELECT
           count(*) FILTER (WHERE is_active)::int AS active,
           count(*) FILTER (WHERE NOT is_active)::int AS inactive,
           count(*) FILTER (
             WHERE is_active
               AND greatest(last_seen_at, last_synced_at) < now() - ($1 || ' hours')::interval
           )::int AS stale
         FROM products
         WHERE raw->>'pageType' = 'product' OR raw->>'sourceType' = 'csv'
       ), page_counts AS (
         SELECT
           count(*) FILTER (WHERE is_active)::int AS active,
           count(*) FILTER (WHERE NOT is_active)::int AS inactive,
           count(*) FILTER (
             WHERE is_active
               AND greatest(last_seen_at, last_synced_at) < now() - ($1 || ' hours')::interval
           )::int AS stale
         FROM catalog_pages
       )
       SELECT
         latest_run.*,
         latest_success.finished_at AS last_successful_sync_at,
         product_counts.active AS active_products,
         product_counts.inactive AS inactive_products,
         product_counts.stale AS stale_products,
         page_counts.active AS active_pages,
         page_counts.inactive AS inactive_pages,
         page_counts.stale AS stale_pages
       FROM product_counts
       CROSS JOIN page_counts
       LEFT JOIN latest_run ON true
       LEFT JOIN latest_success ON true`,
      [Math.max(1, staleAfterHours)]
    );
    const row = result.rows[0] ?? {};
    const latestRun = row.id ? {
      id: String(row.id),
      sourceType: String(row.source_type),
      sourceLocation: String(row.source_location),
      syncMode: row.sync_mode as CatalogSyncMode,
      status: row.status as 'running' | 'completed' | 'failed',
      coverageComplete: Boolean(row.coverage_complete),
      discoveredItemCount: Number(row.discovered_item_count ?? 0),
      syncedItemCount: Number(row.synced_item_count ?? 0),
      failedItemCount: Number(row.failed_item_count ?? 0),
      startedAt: isoTimestamp(row.started_at),
      heartbeatAt: isoTimestamp(row.heartbeat_at),
      finishedAt: row.finished_at ? isoTimestamp(row.finished_at) : null
    } : null;
    const syncHealth = evaluateCatalogSyncHealth({
      now: new Date(),
      latestRun: latestRun ? {
        syncMode: latestRun.syncMode,
        status: latestRun.status,
        coverageComplete: latestRun.coverageComplete,
        failedItemCount: latestRun.failedItemCount,
        startedAt: latestRun.startedAt,
        heartbeatAt: latestRun.heartbeatAt,
        finishedAt: latestRun.finishedAt
      } : null
    });
    const hasStaleRecords = Number(row.stale_products ?? 0) > 0 || Number(row.stale_pages ?? 0) > 0;
    const status = !latestRun
      ? 'unknown'
      : hasStaleRecords || ['degraded', 'overdue', 'stuck', 'failed'].includes(syncHealth.status)
        ? 'stale'
        : 'fresh';
    return {
      status,
      syncHealth,
      latestRun,
      lastSuccessfulSyncAt: row.last_successful_sync_at ? isoTimestamp(row.last_successful_sync_at) : null,
      products: {
        active: Number(row.active_products ?? 0),
        inactive: Number(row.inactive_products ?? 0),
        stale: Number(row.stale_products ?? 0)
      },
      pages: {
        active: Number(row.active_pages ?? 0),
        inactive: Number(row.inactive_pages ?? 0),
        stale: Number(row.stale_pages ?? 0)
      }
    };
  }

  async getEmbeddingCoverage(target: EmbeddingCoverageTarget, model = config.OPENAI_EMBEDDING_MODEL): Promise<EmbeddingCoverage> {
    const targets: Record<EmbeddingCoverageTarget, { table: string; where: string }> = {
      products: { table: 'products', where: PRODUCT_FILTER },
      catalog_pages: { table: 'catalog_pages', where: 'true' },
      troubleshooting_cases: { table: 'troubleshooting_cases', where: 'true' }
    };
    const item = targets[target];
    const result = await this.db.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded,
         COUNT(*) FILTER (WHERE embedding IS NOT NULL AND embedding_model = $1)::int AS usable
       FROM ${item.table}
       WHERE ${item.where}`,
      [model]
    );
    const row = result.rows[0] ?? {};
    const total = Number(row.total ?? 0);
    const usable = Number(row.usable ?? 0);
    return {
      target,
      total,
      embedded: Number(row.embedded ?? 0),
      usable,
      coverage: total > 0 ? usable / total : 0
    };
  }

  async listProductsNeedingEmbeddings(limit = 100, model = config.OPENAI_EMBEDDING_MODEL) {
    const result = await this.db.query(
      `SELECT ${PRODUCT_RESPONSE_COLUMNS}, embedding IS NOT NULL AS has_embedding, embedding_model, embedding_source_hash, embedding_updated_at
       FROM products
       WHERE ${PRODUCT_FILTER}
         AND (
           embedding IS NULL
           OR embedding_model IS DISTINCT FROM $1
           OR embedding_source_hash IS NULL
           OR embedding_updated_at IS NULL
           OR updated_at > embedding_updated_at
         )
       ORDER BY updated_at DESC
       LIMIT $2`,
      [model, limit]
    );
    return result.rows.map(mapBackfillProduct);
  }

  async updateProductEmbedding(id: string, embedding: number[], metadata: EmbeddingMetadata) {
    const vector = `[${embedding.join(',')}]`;
    await this.db.query(
      `UPDATE products
       SET embedding = $2::vector,
           embedding_model = $3,
           embedding_source_hash = $4,
           embedding_updated_at = now()
       WHERE id = $1`,
      [id, vector, metadata.model, metadata.sourceHash]
    );
  }

  async touchProductEmbeddingMetadata(id: string, metadata: EmbeddingMetadata) {
    await this.db.query(
      `UPDATE products
       SET embedding_model = $2,
           embedding_source_hash = $3,
           embedding_updated_at = now()
       WHERE id = $1
         AND embedding IS NOT NULL`,
      [id, metadata.model, metadata.sourceHash]
    );
  }

  async listCatalogPagesNeedingEmbeddings(limit = 100, model = config.OPENAI_EMBEDDING_MODEL) {
    const result = await this.db.query(
      `SELECT *, embedding IS NOT NULL AS has_embedding, embedding_model, embedding_source_hash, embedding_updated_at
       FROM catalog_pages
       WHERE embedding IS NULL
          OR embedding_model IS DISTINCT FROM $1
          OR embedding_source_hash IS NULL
          OR embedding_updated_at IS NULL
          OR updated_at > embedding_updated_at
       ORDER BY updated_at DESC
       LIMIT $2`,
      [model, limit]
    );
    return result.rows.map(mapBackfillCatalogPage);
  }

  async updateCatalogPageEmbedding(id: string, embedding: number[], metadata: EmbeddingMetadata) {
    const vector = `[${embedding.join(',')}]`;
    await this.db.query(
      `UPDATE catalog_pages
       SET embedding = $2::vector,
           embedding_model = $3,
           embedding_source_hash = $4,
           embedding_updated_at = now()
       WHERE id = $1`,
      [id, vector, metadata.model, metadata.sourceHash]
    );
  }

  async touchCatalogPageEmbeddingMetadata(id: string, metadata: EmbeddingMetadata) {
    await this.db.query(
      `UPDATE catalog_pages
       SET embedding_model = $2,
           embedding_source_hash = $3,
           embedding_updated_at = now()
       WHERE id = $1
         AND embedding IS NOT NULL`,
      [id, metadata.model, metadata.sourceHash]
    );
  }

  async upsertProduct(input: CatalogProductInput, embedding?: number[], embeddingMetadata?: EmbeddingMetadata) {
    const vector = embedding ? `[${embedding.join(',')}]` : null;
    const sourceContentHash = catalogSourceContentHash(freshnessHashInput(input));
    const result = await this.db.query(
      `INSERT INTO products(
         external_id, source_url, slug, name, brand, category, price, currency, image_url,
         description, specs, raw, source_priority, embedding, embedding_model, embedding_source_hash, embedding_updated_at,
         last_seen_at, last_synced_at, is_active, source_content_hash
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::vector, $15, $16,
         CASE WHEN $14::vector IS NULL THEN NULL ELSE now() END, now(), now(), true, $17
       )
       ON CONFLICT (source_url) DO UPDATE SET
         external_id = coalesce(EXCLUDED.external_id, products.external_id),
         slug = coalesce(EXCLUDED.slug, products.slug),
         name = EXCLUDED.name,
         brand = coalesce(EXCLUDED.brand, products.brand),
         category = coalesce(EXCLUDED.category, products.category),
         price = coalesce(EXCLUDED.price, products.price),
         currency = coalesce(EXCLUDED.currency, products.currency),
         image_url = coalesce(EXCLUDED.image_url, products.image_url),
         description = coalesce(EXCLUDED.description, products.description),
         specs = products.specs || EXCLUDED.specs,
         raw = products.raw || EXCLUDED.raw,
         source_priority = LEAST(products.source_priority, EXCLUDED.source_priority),
         embedding = coalesce(EXCLUDED.embedding, products.embedding),
         embedding_model = CASE WHEN EXCLUDED.embedding IS NULL THEN products.embedding_model ELSE EXCLUDED.embedding_model END,
         embedding_source_hash = CASE WHEN EXCLUDED.embedding IS NULL THEN products.embedding_source_hash ELSE EXCLUDED.embedding_source_hash END,
         embedding_updated_at = CASE WHEN EXCLUDED.embedding IS NULL THEN products.embedding_updated_at ELSE EXCLUDED.embedding_updated_at END,
         last_seen_at = now(),
         last_synced_at = now(),
         is_active = true,
         source_content_hash = EXCLUDED.source_content_hash,
         updated_at = now()
       RETURNING *`,
      [
        input.externalId ?? null,
        input.sourceUrl ?? null,
        input.slug ?? null,
        input.name,
        input.brand ?? null,
        input.category ?? null,
        input.price ?? null,
        input.currency ?? 'RUB',
        input.imageUrl ?? null,
        input.description ?? null,
        input.specs ?? {},
        input.raw ?? {},
        input.sourcePriority ?? 50,
        vector,
        embedding ? embeddingMetadata?.model ?? config.OPENAI_EMBEDDING_MODEL : null,
        embedding ? embeddingMetadata?.sourceHash ?? null : null,
        sourceContentHash
      ]
    );

    const product = mapProduct(result.rows[0]);
    await this.upsertFactsFromProduct(product.id, input);
    return product;
  }

  async upsertFactsFromProduct(productId: string, product: CatalogProductInput) {
    const specs = product.specs ?? {};
    const sourceType = product.raw?.sourceType === 'csv' ? 'csv' : 'site';
    if (product.sourceUrl) {
      await this.db.query(
        `DELETE FROM product_facts
         WHERE product_id = $1 AND source_type = $2 AND source_url = $3`,
        [productId, sourceType, product.sourceUrl]
      );
    }

    const facts: ProductFact[] = Object.entries(specs)
      .filter(([, value]) => value !== null && value !== undefined && String(value).trim().length > 0)
      .map(([attribute, value]) => ({
        productId,
        attribute,
        value: String(value),
        sourceType,
        sourceUrl: product.sourceUrl,
        confidence: product.raw?.sourceType === 'csv' ? 0.8 : 0.75
      }));

    if (product.price !== undefined) {
      facts.push({
        productId,
        attribute: 'price',
        value: String(product.price),
        unit: product.currency ?? 'RUB',
        sourceType,
        sourceUrl: product.sourceUrl,
        confidence: 0.65
      });
    }

    for (const fact of facts) {
      await this.db.query(
        `INSERT INTO product_facts(product_id, attribute, value, unit, source_type, source_url, confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        [
          fact.productId,
          fact.attribute,
          fact.value,
          fact.unit ?? null,
          fact.sourceType,
          fact.sourceUrl ?? null,
          fact.confidence
        ]
      );
    }

    await this.refreshConflicts(productId);
  }

  async upsertTroubleshootingCase(input: TroubleshootingCaseInput, embedding?: number[], embeddingMetadata?: EmbeddingMetadata) {
    const vector = embedding ? `[${embedding.join(',')}]` : null;
    const result = await this.db.query(
      `INSERT INTO troubleshooting_cases(
         model, model_key, fault_codes, problem_summary, problem_key, answer,
         source_urls, source_titles, confidence, embedding, embedding_model, embedding_source_hash, embedding_updated_at, first_seen_message
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector, $11, $12, CASE WHEN $10::vector IS NULL THEN NULL ELSE now() END, $13)
       ON CONFLICT (model_key, problem_key) DO UPDATE SET
         model = EXCLUDED.model,
         fault_codes = EXCLUDED.fault_codes,
         problem_summary = EXCLUDED.problem_summary,
         answer = EXCLUDED.answer,
         source_urls = EXCLUDED.source_urls,
         source_titles = EXCLUDED.source_titles,
         confidence = GREATEST(troubleshooting_cases.confidence, EXCLUDED.confidence),
         embedding = coalesce(EXCLUDED.embedding, troubleshooting_cases.embedding),
         embedding_model = CASE WHEN EXCLUDED.embedding IS NULL THEN troubleshooting_cases.embedding_model ELSE EXCLUDED.embedding_model END,
         embedding_source_hash = CASE WHEN EXCLUDED.embedding IS NULL THEN troubleshooting_cases.embedding_source_hash ELSE EXCLUDED.embedding_source_hash END,
         embedding_updated_at = CASE WHEN EXCLUDED.embedding IS NULL THEN troubleshooting_cases.embedding_updated_at ELSE EXCLUDED.embedding_updated_at END,
         first_seen_message = coalesce(troubleshooting_cases.first_seen_message, EXCLUDED.first_seen_message),
         updated_at = now()
       RETURNING *`,
      [
        input.model,
        input.modelKey,
        input.faultCodes ?? [],
        input.problemSummary,
        input.problemKey,
        input.answer,
        input.sourceUrls ?? [],
        input.sourceTitles ?? [],
        input.confidence ?? 0.75,
        vector,
        embedding ? embeddingMetadata?.model ?? config.OPENAI_EMBEDDING_MODEL : null,
        embedding ? embeddingMetadata?.sourceHash ?? null : null,
        input.firstSeenMessage ?? null
      ]
    );
    return mapTroubleshootingCase(result.rows[0]);
  }

  async searchTroubleshootingCases(input: {
    query: string;
    modelKeys?: string[];
    faultCodes?: string[];
    embedding?: number[] | null;
    limit?: number;
  }) {
    const normalized = input.query.trim();
    const modelKeys = input.modelKeys ?? [];
    const faultCodes = input.faultCodes ?? [];
    const vector = input.embedding ? `[${input.embedding.join(',')}]` : null;
    const result = await this.db.query(
      `WITH ranked AS (
         SELECT *,
           CASE
             WHEN $4::vector IS NOT NULL AND embedding IS NOT NULL AND embedding_model = $6 THEN 1 - (embedding <=> $4::vector)
             ELSE NULL
           END AS semantic_score,
           CASE
             WHEN $1 <> '' THEN ts_rank_cd(
               to_tsvector(
                 'russian',
                 coalesce(model, '') || ' ' ||
                 coalesce(array_to_string(fault_codes, ' '), '') || ' ' ||
                 coalesce(problem_summary, '') || ' ' ||
                 coalesce(answer, '')
               ),
               websearch_to_tsquery('russian', $1)
             )
             ELSE 0
           END AS text_rank,
           CASE WHEN model_key = ANY($2::text[]) THEN 1 ELSE 0 END AS model_match,
           CASE WHEN fault_codes && $3::text[] THEN 1 ELSE 0 END AS fault_match
         FROM troubleshooting_cases
         WHERE
           ($2::text[] <> '{}'::text[] AND model_key = ANY($2::text[]))
           OR ($3::text[] <> '{}'::text[] AND fault_codes && $3::text[])
           OR (
             $1 <> ''
             AND to_tsvector(
               'russian',
               coalesce(model, '') || ' ' ||
               coalesce(array_to_string(fault_codes, ' '), '') || ' ' ||
               coalesce(problem_summary, '') || ' ' ||
               coalesce(answer, '')
             ) @@ websearch_to_tsquery('russian', $1)
           )
           OR ($4::vector IS NOT NULL AND embedding IS NOT NULL AND embedding_model = $6)
       )
       SELECT *
       FROM ranked
       ORDER BY model_match DESC, fault_match DESC, semantic_score DESC NULLS LAST, text_rank DESC, updated_at DESC
       LIMIT $5`,
      [normalized, modelKeys, faultCodes, vector, input.limit ?? 4, config.OPENAI_EMBEDDING_MODEL]
    );
    return result.rows.map(mapTroubleshootingCase);
  }

  async markTroubleshootingCasesUsed(ids: string[]) {
    if (!ids.length) return 0;
    const result = await this.db.query(
      `UPDATE troubleshooting_cases
       SET hit_count = hit_count + 1,
           last_used_at = now(),
           updated_at = now()
       WHERE id = ANY($1::uuid[])`,
      [ids]
    );
    return result.rowCount ?? 0;
  }

  async upsertCatalogPage(input: CatalogPageInput, embedding?: number[], embeddingMetadata?: EmbeddingMetadata) {
    const vector = embedding ? `[${embedding.join(',')}]` : null;
    const sourceContentHash = catalogSourceContentHash(freshnessHashInput(input));
    const result = await this.db.query(
      `INSERT INTO catalog_pages(
         source_url, page_type, title, content, summary, raw, embedding, embedding_model,
         embedding_source_hash, embedding_updated_at, last_seen_at, last_synced_at, is_active, source_content_hash
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7::vector, $8, $9,
         CASE WHEN $7::vector IS NULL THEN NULL ELSE now() END, now(), now(), true, $10
       )
       ON CONFLICT (source_url) DO UPDATE SET
         page_type = EXCLUDED.page_type,
         title = EXCLUDED.title,
         content = EXCLUDED.content,
         summary = EXCLUDED.summary,
         raw = catalog_pages.raw || EXCLUDED.raw,
         embedding = coalesce(EXCLUDED.embedding, catalog_pages.embedding),
         embedding_model = CASE WHEN EXCLUDED.embedding IS NULL THEN catalog_pages.embedding_model ELSE EXCLUDED.embedding_model END,
         embedding_source_hash = CASE WHEN EXCLUDED.embedding IS NULL THEN catalog_pages.embedding_source_hash ELSE EXCLUDED.embedding_source_hash END,
         embedding_updated_at = CASE WHEN EXCLUDED.embedding IS NULL THEN catalog_pages.embedding_updated_at ELSE EXCLUDED.embedding_updated_at END,
         last_seen_at = now(),
         last_synced_at = now(),
         is_active = true,
         source_content_hash = EXCLUDED.source_content_hash,
         updated_at = now()
       RETURNING *`,
      [
        input.sourceUrl,
        input.pageType,
        input.title,
        input.content,
        input.summary ?? null,
        input.raw ?? {},
        vector,
        embedding ? embeddingMetadata?.model ?? config.OPENAI_EMBEDDING_MODEL : null,
        embedding ? embeddingMetadata?.sourceHash ?? null : null,
        sourceContentHash
      ]
    );
    return mapCatalogPage(result.rows[0]);
  }

  async searchCatalogPages(query: string, limit = 6) {
    const normalized = query.trim();
    const result = await this.db.query(
      `SELECT *, ts_rank_cd(search_tsv, websearch_to_tsquery('russian', $1)) AS rank
       FROM catalog_pages
       WHERE is_active IS NOT FALSE
         AND $1 <> ''
         AND search_tsv @@ websearch_to_tsquery('russian', $1)
       ORDER BY rank DESC NULLS LAST, updated_at DESC
       LIMIT $2`,
      [normalized, limit]
    );
    return result.rows.map(mapCatalogPage);
  }

  async vectorSearchCatalogPages(embedding: number[], limit = 6) {
    const vector = `[${embedding.join(',')}]`;
    const result = await this.db.query(
      `SELECT *, 1 - (embedding <=> $1::vector) AS score
       FROM catalog_pages
       WHERE embedding IS NOT NULL
         AND is_active IS NOT FALSE
         AND embedding_model = $3
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [vector, limit, config.OPENAI_EMBEDDING_MODEL]
    );
    return result.rows.map(mapCatalogPage);
  }

  async upsertVerifiedProductFact(input: VerifiedProductFactInput) {
    const productName = input.productName.trim();
    const productKey = normalizeVerifiedProductKey(productName);
    const attribute = input.attribute.trim();
    const value = input.value.trim();
    if (!productName || !productKey || !attribute || !value) return null;
    const result = await this.db.query(
      `WITH inserted AS (
         INSERT INTO verified_product_facts(
           product_id, product_key, product_name, attribute, value, source_type,
           source_url, source_title, evidence, confidence
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT DO NOTHING
         RETURNING *
       ),
       updated AS (
         UPDATE verified_product_facts
         SET
           product_id = coalesce($1, verified_product_facts.product_id),
           product_name = $3,
           source_title = coalesce($8, verified_product_facts.source_title),
           evidence = coalesce($9, verified_product_facts.evidence),
           confidence = CASE
             WHEN verified_product_facts.confidence = 'high' THEN verified_product_facts.confidence
             WHEN $10 = 'high' THEN 'high'
             WHEN verified_product_facts.confidence = 'medium' THEN verified_product_facts.confidence
             WHEN $10 = 'medium' THEN 'medium'
             ELSE verified_product_facts.confidence
           END,
           last_verified_at = now(),
           updated_at = now()
         WHERE NOT EXISTS (SELECT 1 FROM inserted)
           AND product_key = $2
           AND attribute = $4
           AND value = $5
           AND source_type = $6
           AND coalesce(source_url, '') = coalesce($7, '')
           AND status = 'active'
         RETURNING *
       )
       SELECT * FROM inserted
       UNION ALL
       SELECT * FROM updated
       LIMIT 1`,
      [
        input.productId ?? null,
        productKey,
        productName,
        attribute,
        value,
        input.sourceType,
        input.sourceUrl ?? null,
        input.sourceTitle ?? null,
        input.evidence ?? null,
        input.confidence
      ]
    );
    return result.rows[0] ? mapVerifiedProductFact(result.rows[0]) : null;
  }

  async searchVerifiedProductFacts(input: {
    productNames?: string[];
    productIds?: string[];
    sourceTypes?: Array<'web' | 'catalog' | 'manual'>;
    limit?: number;
  }) {
    const productKeys = [...new Set((input.productNames ?? [])
      .map((name) => normalizeVerifiedProductKey(name))
      .filter(Boolean))];
    const productIds = [...new Set((input.productIds ?? []).filter(Boolean))];
    if (!productKeys.length && !productIds.length) return [];
    const sourceTypes = input.sourceTypes?.length ? input.sourceTypes : ['web'];
    const result = await this.db.query(
      `SELECT *
       FROM verified_product_facts
       WHERE status = 'active'
         AND source_type = ANY($3::text[])
         AND (
           ($1::text[] <> '{}'::text[] AND product_key = ANY($1::text[]))
           OR ($2::uuid[] <> '{}'::uuid[] AND product_id = ANY($2::uuid[]))
         )
       ORDER BY
         CASE confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
         last_verified_at DESC,
         updated_at DESC
       LIMIT $4`,
      [productKeys, productIds, sourceTypes, input.limit ?? 24]
    );
    return result.rows.map(mapVerifiedProductFact);
  }

  async markVerifiedProductFactsUsed(ids: string[]) {
    const factIds = [...new Set(ids.filter(Boolean))];
    if (!factIds.length) return 0;
    const result = await this.db.query(
      `UPDATE verified_product_facts
       SET hit_count = hit_count + 1,
           updated_at = now()
       WHERE id = ANY($1::uuid[])`,
      [factIds]
    );
    return result.rowCount ?? 0;
  }

  async upsertVerifiedWebFact(input: {
    productId: string;
    attribute: string;
    value: string;
    unit?: string | null;
    sourceUrl?: string | null;
    confidence?: number;
  }) {
    await this.db.query(
      `INSERT INTO product_facts(product_id, attribute, value, unit, source_type, source_url, confidence)
       VALUES ($1, $2, $3, $4, 'web', $5, $6)
       ON CONFLICT DO NOTHING`,
      [
        input.productId,
        input.attribute,
        input.value,
        input.unit ?? null,
        input.sourceUrl ?? null,
        input.confidence ?? 0.85
      ]
    );
    await this.refreshConflicts(input.productId);
  }

  async recordWebEvidence(input: {
    conflictId?: string | null;
    productId?: string | null;
    query: string;
    sourceUrl?: string | null;
    title?: string | null;
    snippet?: string | null;
    verdict?: Record<string, unknown>;
  }) {
    await this.db.query(
      `INSERT INTO web_evidence(conflict_id, product_id, query, source_url, title, snippet, verdict)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.conflictId ?? null,
        input.productId ?? null,
        input.query,
        input.sourceUrl ?? null,
        input.title ?? null,
        input.snippet ?? null,
        input.verdict ?? {}
      ]
    );
  }

  async recordDataQualityIssue(input: {
    productId?: string | null;
    issueType: string;
    fieldName?: string | null;
    conflictingValues?: unknown[];
    evidence?: unknown[];
  }) {
    const result = await this.db.query(
      `INSERT INTO data_quality_issues(product_id, issue_type, field_name, conflicting_values, evidence)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
       RETURNING *`,
      [
        input.productId ?? null,
        input.issueType,
        input.fieldName ?? null,
        jsonbParam(input.conflictingValues ?? []),
        jsonbParam(input.evidence ?? [])
      ]
    );
    return result.rows[0] ?? null;
  }

  async searchProducts(query: string, limit = 8) {
    const normalized = query.trim();
    const tokens = searchTokens(normalized);
    const result = await this.db.query(
      `WITH ranked AS (
         SELECT ${PRODUCT_RESPONSE_COLUMNS},
           updated_at,
           ts_rank_cd(search_tsv, websearch_to_tsquery('russian', $1)) AS retrieval_score,
           (
             SELECT count(*)::int
             FROM unnest($3::text[]) AS token
             WHERE lower(name) LIKE '%' || lower(token) || '%'
                OR lower(coalesce(category, '')) LIKE '%' || lower(token) || '%'
                OR lower(coalesce(description, '')) LIKE '%' || lower(token) || '%'
                OR lower(coalesce(source_url, '')) LIKE '%' || lower(token) || '%'
                OR lower(coalesce(specs::text, '')) LIKE '%' || lower(token) || '%'
           ) AS token_match_count,
           'text'::text AS retrieval_source
         FROM products
         WHERE ${PRODUCT_FILTER}
            AND (
              $1 = ''
              OR search_tsv @@ websearch_to_tsquery('russian', $1)
             OR EXISTS (
               SELECT 1 FROM unnest($3::text[]) AS token
               WHERE lower(name) LIKE '%' || lower(token) || '%'
                  OR lower(coalesce(category, '')) LIKE '%' || lower(token) || '%'
                  OR lower(coalesce(description, '')) LIKE '%' || lower(token) || '%'
                  OR lower(coalesce(source_url, '')) LIKE '%' || lower(token) || '%'
                  OR lower(coalesce(specs::text, '')) LIKE '%' || lower(token) || '%'
             )
           )
       )
       SELECT *
       FROM ranked
       ORDER BY retrieval_score DESC NULLS LAST, token_match_count DESC, updated_at DESC
       LIMIT $2`,
      [normalized, limit, tokens]
    );
    return result.rows.map(mapProduct);
  }

  async searchProductsByModelTokens(tokens: string[], limit = 20) {
    if (!tokens.length) return [];
    const result = await this.db.query(
      `SELECT ${PRODUCT_RESPONSE_COLUMNS}, 1::numeric AS retrieval_score, 'exact'::text AS retrieval_source
       FROM products
       WHERE ${PRODUCT_FILTER}
          AND EXISTS (
            SELECT 1 FROM unnest($1::text[]) AS token
            WHERE lower(name) LIKE '%' || lower(token) || '%'
              OR lower(coalesce(specs::text, '')) LIKE '%' || lower(token) || '%'
              OR lower(coalesce(source_url, '')) LIKE '%' || lower(replace(token, '-', '_')) || '%'
              OR regexp_replace(lower(name), '[^a-zа-яё0-9]+', '', 'g') LIKE '%' || regexp_replace(lower(token), '[^a-zа-яё0-9]+', '', 'g') || '%'
              OR regexp_replace(lower(coalesce(specs::text, '')), '[^a-zа-яё0-9]+', '', 'g') LIKE '%' || regexp_replace(lower(token), '[^a-zа-яё0-9]+', '', 'g') || '%'
              OR regexp_replace(lower(coalesce(source_url, '')), '[^a-zа-яё0-9]+', '', 'g') LIKE '%' || regexp_replace(lower(token), '[^a-zа-яё0-9]+', '', 'g') || '%'
         )
       ORDER BY updated_at DESC
       LIMIT $2`,
      [tokens, limit]
    );
    return result.rows.map(mapProduct);
  }

  async vectorSearch(embedding: number[], limit = 8) {
    const vector = `[${embedding.join(',')}]`;
    const result = await this.db.query(
      `SELECT ${PRODUCT_RESPONSE_COLUMNS}, 1 - (embedding <=> $1::vector) AS retrieval_score, 'vector'::text AS retrieval_source
       FROM products
       WHERE embedding IS NOT NULL
          AND ${PRODUCT_FILTER}
          AND embedding_model = $3
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [vector, limit, config.OPENAI_EMBEDDING_MODEL]
    );
    return result.rows.map(mapProduct);
  }

  async listProducts(limit = 100) {
    const result = await this.db.query(
      `SELECT ${PRODUCT_RESPONSE_COLUMNS}
       FROM products
       WHERE ${PRODUCT_FILTER}
       ORDER BY updated_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapProduct);
  }

  async listProductsByTextFilter(patterns: string[], limit = 5000) {
    if (!patterns.length) {
      return this.listProducts(limit);
    }
    const conditions = patterns.map((_, i) => `(LOWER(name || ' ' || COALESCE(brand, '') || ' ' || COALESCE(category, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(source_url, '') || ' ' || COALESCE(specs::text, '')) LIKE $${i + 1})`);
    const query = `SELECT ${PRODUCT_RESPONSE_COLUMNS} FROM products WHERE ${PRODUCT_FILTER} AND (${conditions.join(' OR ')}) ORDER BY updated_at DESC LIMIT $${patterns.length + 1}`;
    const params = [...patterns.map((p) => `%${p.toLowerCase()}%`), limit];
    const result = await this.db.query(query, params);
    return result.rows.map(mapProduct);
  }

  async listProductSourceUrls(limit = 10000) {
    const result = await this.db.query(
      `SELECT source_url
       FROM products
       WHERE source_url IS NOT NULL
         AND ${PRODUCT_FILTER}
       ORDER BY updated_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => String(row.source_url)).filter(Boolean);
  }

  async getOpenConflictsForProducts(productIds: string[]) {
    if (!productIds.length) return [];
    const result = await this.db.query(
      `SELECT * FROM data_conflicts
       WHERE status = 'open' AND product_id = ANY($1::uuid[])
       ORDER BY created_at DESC`,
      [productIds]
    );
    return result.rows.map((row) => ({
      id: row.id,
      productId: row.product_id,
      attribute: row.attribute,
      values: row.values,
      status: row.status,
      resolution: row.resolution
    })) as DataConflict[];
  }

  async listOpenConflicts(limit = 100) {
    const result = await this.db.query(
      `SELECT * FROM data_conflicts WHERE status = 'open' ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => ({
      id: row.id,
      productId: row.product_id,
      attribute: row.attribute,
      values: row.values,
      status: row.status,
      resolution: row.resolution
    })) as DataConflict[];
  }

  async refreshConflicts(productId: string) {
    const result = await this.db.query(
      `SELECT attribute, jsonb_agg(DISTINCT jsonb_build_object(
         'value', value,
         'unit', unit,
         'sourceType', source_type,
         'sourceUrl', source_url,
         'confidence', confidence
       )) AS values,
       count(DISTINCT value) AS distinct_values
       FROM product_facts
       WHERE product_id = $1
       GROUP BY attribute
       HAVING count(DISTINCT value) > 1`,
      [productId]
    );

    for (const row of result.rows) {
      await this.db.query(
        `INSERT INTO data_conflicts(product_id, attribute, values)
         VALUES ($1, $2, $3)
         ON CONFLICT (product_id, attribute, status) DO UPDATE SET
           values = EXCLUDED.values,
           created_at = data_conflicts.created_at`,
        [productId, row.attribute, row.values]
      );
    }
  }
}

export class LeadRepository {
  constructor(private readonly db: Db = pool) {}

  async createClientLead(input: {
    sessionId: string;
    clientLeadId: string;
    clientRequestHash: string;
    name: string;
    phone?: string;
    email?: string;
    question?: string;
  }) {
    const result = await this.db.query(
      `INSERT INTO leads(
         session_id,
         client_lead_id,
         client_request_hash,
         name,
         phone,
         email,
         question
       )
       SELECT $1, $2::uuid, $3, $4, $5, $6, $7
       FROM conversation_sessions
       WHERE id = $1 AND status = 'active'
       ON CONFLICT (session_id, client_lead_id) WHERE client_lead_id IS NOT NULL DO UPDATE
       SET client_request_hash = leads.client_request_hash
       WHERE leads.client_request_hash = EXCLUDED.client_request_hash
       RETURNING *`,
      [
        input.sessionId,
        input.clientLeadId,
        input.clientRequestHash,
        input.name,
        input.phone ?? null,
        input.email ?? null,
        input.question ?? null
      ]
    );
    return result.rowCount ? mapLead(result.rows[0]) : null;
  }

  async createLead(input: {
    sessionId?: string;
    originTurnId?: string;
    originToolRequestId?: string;
    name: string;
    phone?: string;
    email?: string;
    question?: string;
  }) {
    const result = await this.db.query(
      `INSERT INTO leads(
         session_id,
         origin_turn_id,
         origin_tool_request_id,
         name,
         phone,
         email,
         question
       )
       VALUES ($1, $2::uuid, $3, $4, $5, $6, $7)
       ON CONFLICT (session_id, origin_turn_id, origin_tool_request_id) DO UPDATE
       SET name = leads.name
       RETURNING *`,
      [
        input.sessionId ?? null,
        input.originTurnId ?? null,
        input.originToolRequestId ?? null,
        input.name,
        input.phone ?? null,
        input.email ?? null,
        input.question ?? null
      ]
    );
    return mapLead(result.rows[0]);
  }

  async markEmailResult(id: string, status: 'sent_email' | 'email_failed', providerResponse: Record<string, unknown>) {
    const result = await this.db.query(
      `UPDATE leads
       SET status = CASE
             WHEN status = 'sent_email' AND $2 = 'email_failed' THEN status
             ELSE $2
           END,
           email_provider_response = CASE
             WHEN status = 'sent_email' AND $2 = 'email_failed' THEN email_provider_response
             ELSE $3
           END,
           sent_at = CASE WHEN $2 = 'sent_email' AND status <> 'sent_email' THEN now() ELSE sent_at END
       WHERE id = $1
       RETURNING *`,
      [id, status, providerResponse]
    );
    return mapLead(result.rows[0]);
  }

  async getLead(id: string) {
    const result = await this.db.query('SELECT * FROM leads WHERE id = $1', [id]);
    return result.rowCount ? mapLead(result.rows[0]) : null;
  }

  async latestLeadForSession(sessionId: string) {
    const result = await this.db.query(
      'SELECT * FROM leads WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1',
      [sessionId]
    );
    return result.rowCount ? mapLead(result.rows[0]) : null;
  }

  async claimDueLeadOutbox(limit = 10) {
    const result = await this.db.query(
      `WITH due AS (
         SELECT id
         FROM lead_outbox
         WHERE (
             status IN ('pending', 'failed')
             AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           ) OR (
             status = 'sending'
             AND updated_at < now() - interval '15 minutes'
           )
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE lead_outbox o
       SET status = 'sending',
           attempt_count = o.attempt_count + 1,
           updated_at = now()
       FROM due
       WHERE o.id = due.id
       RETURNING o.*`,
      [limit]
    );
    return result.rows.map(mapLeadOutboxItem);
  }

  async markLeadOutboxSent(id: string) {
    const result = await this.db.query(
      `UPDATE lead_outbox
       SET status = 'sent',
           last_error = NULL,
           next_attempt_at = NULL,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id]
    );
    return result.rowCount ? mapLeadOutboxItem(result.rows[0]) : null;
  }

  async markLeadOutboxFailed(input: { id: string; error: string; nextAttemptAt?: string | null; dead?: boolean }) {
    const result = await this.db.query(
      `UPDATE lead_outbox
       SET status = $2,
           last_error = $3,
           next_attempt_at = $4::timestamptz,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [input.id, input.dead ? 'dead' : 'failed', input.error, input.nextAttemptAt ?? null]
    );
    return result.rowCount ? mapLeadOutboxItem(result.rows[0]) : null;
  }

  async getLeadOutboxHealth() {
    const result = await this.db.query(
      `SELECT
         count(*) FILTER (WHERE status = 'pending')::int AS pending,
         count(*) FILTER (WHERE status = 'sending')::int AS sending,
         count(*) FILTER (WHERE status = 'failed')::int AS failed,
         count(*) FILTER (WHERE status = 'dead')::int AS dead,
         count(*) FILTER (
           WHERE status = 'sending'
             AND updated_at < now() - interval '15 minutes'
         )::int AS stale_sending,
         min(created_at) FILTER (WHERE status IN ('pending', 'failed', 'sending')) AS oldest_backlog_at,
         max(updated_at) FILTER (WHERE status = 'sent') AS last_sent_at
       FROM lead_outbox`
    );
    const row = result.rows[0] ?? {};
    const pending = Number(row.pending ?? 0);
    const sending = Number(row.sending ?? 0);
    const failed = Number(row.failed ?? 0);
    const dead = Number(row.dead ?? 0);
    const staleSending = Number(row.stale_sending ?? 0);
    return {
      status: dead > 0 || failed > 0 || staleSending > 0 ? 'degraded' as const : 'healthy' as const,
      pending,
      sending,
      failed,
      dead,
      staleSending,
      oldestBacklogAt: row.oldest_backlog_at ? isoTimestamp(row.oldest_backlog_at) : null,
      lastSentAt: row.last_sent_at ? isoTimestamp(row.last_sent_at) : null
    };
  }

  async listLeads(limit = 100) {
    const result = await this.db.query('SELECT * FROM leads ORDER BY created_at DESC LIMIT $1', [limit]);
    return result.rows.map(mapLead);
  }
}
