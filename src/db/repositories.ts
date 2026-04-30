import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { pool } from './pool.js';
import type {
  CatalogProductInput,
  CatalogPage,
  CatalogPageInput,
  ConversationSummary,
  ConversationSession,
  CustomerNeedState,
  DataConflict,
  Lead,
  Message,
  MessageRole,
  Product,
  ProductFact
} from '../shared/types.js';
import { emptyNeedState } from '../ai/needState.js';

type Db = Pool | PoolClient;

function mapNeedState(value: unknown): CustomerNeedState {
  if (!value || typeof value !== 'object') return emptyNeedState();
  return { ...emptyNeedState(), ...(value as Partial<CustomerNeedState>) };
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
    raw: row.raw ?? {}
  };
}

function mapLead(row: QueryResultRow): Lead {
  return {
    id: row.id,
    sessionId: row.session_id,
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
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
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
       VALUES ($1, $2, $3, $4, 'Диалог')
       RETURNING *`,
      [input.visitorId ?? null, input.pageUrl ?? null, input.userAgent ?? null, emptyNeedState()]
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
       SET need_state = $2, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [sessionId, needState]
    );
    return mapSession(result.rows[0]);
  }

  async addMessage(input: { sessionId: string; role: MessageRole; content: string; metadata?: Record<string, unknown> }) {
    const result = await this.db.query(
      `INSERT INTO messages(session_id, role, content, metadata)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.sessionId, input.role, input.content, input.metadata ?? {}]
    );
    await this.db.query(
      `UPDATE conversation_sessions
       SET updated_at = now()
       WHERE id = $1`,
      [input.sessionId]
    );
    return mapMessage(result.rows[0]);
  }

  async updateAssistantFeedback(input: {
    sessionId: string;
    messageId: string;
    rating: 'positive' | 'negative' | 'wrong_cards';
  }) {
    const result = await this.db.query(
      `UPDATE messages
       SET metadata = jsonb_set(
         coalesce(metadata, '{}'::jsonb),
         '{feedback}',
         $3::jsonb,
         true
       )
       WHERE id = $1 AND session_id = $2 AND role = 'assistant'
       RETURNING *`,
      [
        input.messageId,
        input.sessionId,
        {
          rating: input.rating,
          createdAt: new Date().toISOString()
        }
      ]
    );
    return result.rowCount ? mapMessage(result.rows[0]) : null;
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

  async listSessions(limit = 100) {
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
       ORDER BY coalesce(latest.latest_message_at, s.created_at) DESC, s.conversation_number DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapConversationSummary);
  }
}

export class ProductRepository {
  constructor(private readonly db: Db = pool) {}

  async startCatalogSource(input: { type: 'site_crawl' | 'csv_import'; location: string }) {
    const result = await this.db.query(
      `INSERT INTO catalog_sources(type, location)
       VALUES ($1, $2)
       RETURNING id`,
      [input.type, input.location]
    );
    return result.rows[0].id as string;
  }

  async finishCatalogSource(id: string, status: 'completed' | 'failed', stats: Record<string, unknown>, error?: string) {
    await this.db.query(
      `UPDATE catalog_sources
       SET status = $2, stats = $3, error = $4, finished_at = now()
       WHERE id = $1`,
      [id, status, stats, error ?? null]
    );
  }

  async upsertProduct(input: CatalogProductInput, embedding?: number[]) {
    const vector = embedding ? `[${embedding.join(',')}]` : null;
    const result = await this.db.query(
      `INSERT INTO products(
         external_id, source_url, slug, name, brand, category, price, currency, image_url,
         description, specs, raw, source_priority, embedding
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::vector)
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
        vector
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

  async upsertCatalogPage(input: CatalogPageInput, embedding?: number[]) {
    const vector = embedding ? `[${embedding.join(',')}]` : null;
    const result = await this.db.query(
      `INSERT INTO catalog_pages(source_url, page_type, title, content, summary, raw, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
       ON CONFLICT (source_url) DO UPDATE SET
         page_type = EXCLUDED.page_type,
         title = EXCLUDED.title,
         content = EXCLUDED.content,
         summary = EXCLUDED.summary,
         raw = catalog_pages.raw || EXCLUDED.raw,
         embedding = coalesce(EXCLUDED.embedding, catalog_pages.embedding),
         updated_at = now()
       RETURNING *`,
      [
        input.sourceUrl,
        input.pageType,
        input.title,
        input.content,
        input.summary ?? null,
        input.raw ?? {},
        vector
      ]
    );
    return mapCatalogPage(result.rows[0]);
  }

  async searchCatalogPages(query: string, limit = 6) {
    const normalized = query.trim();
    const result = await this.db.query(
      `SELECT *, ts_rank_cd(search_tsv, websearch_to_tsquery('russian', $1)) AS rank
       FROM catalog_pages
       WHERE $1 <> '' AND search_tsv @@ websearch_to_tsquery('russian', $1)
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
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [vector, limit]
    );
    return result.rows.map(mapCatalogPage);
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

  async searchProducts(query: string, limit = 8) {
    const normalized = query.trim();
    const tokens = searchTokens(normalized);
    const result = await this.db.query(
      `SELECT *, ts_rank_cd(search_tsv, plainto_tsquery('russian', $1)) AS rank
       FROM products
       WHERE (raw->>'pageType' = 'product' OR raw->>'sourceType' = 'csv')
         AND (
           $1 = ''
           OR search_tsv @@ websearch_to_tsquery('russian', $1)
           OR EXISTS (
             SELECT 1 FROM unnest($3::text[]) AS token
             WHERE lower(name) LIKE '%' || lower(token) || '%'
                OR lower(coalesce(category, '')) LIKE '%' || lower(token) || '%'
                OR lower(coalesce(description, '')) LIKE '%' || lower(token) || '%'
                OR lower(coalesce(source_url, '')) LIKE '%' || lower(token) || '%'
           )
         )
       ORDER BY rank DESC NULLS LAST, updated_at DESC
       LIMIT $2`,
      [normalized, limit, tokens]
    );
    return result.rows.map(mapProduct);
  }

  async searchProductsByModelTokens(tokens: string[], limit = 20) {
    if (!tokens.length) return [];
    const result = await this.db.query(
      `SELECT *
       FROM products
       WHERE (raw->>'pageType' = 'product' OR raw->>'sourceType' = 'csv')
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
      `SELECT *, 1 - (embedding <=> $1::vector) AS score
       FROM products
       WHERE embedding IS NOT NULL
         AND (raw->>'pageType' = 'product' OR raw->>'sourceType' = 'csv')
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [vector, limit]
    );
    return result.rows.map(mapProduct);
  }

  async listProducts(limit = 100) {
    const result = await this.db.query('SELECT * FROM products ORDER BY updated_at DESC LIMIT $1', [limit]);
    return result.rows.map(mapProduct);
  }

  async listProductsByTextFilter(patterns: string[], limit = 5000) {
    if (!patterns.length) {
      return this.listProducts(limit);
    }
    const conditions = patterns.map((_, i) => `(LOWER(name || ' ' || COALESCE(brand, '') || ' ' || COALESCE(category, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(source_url, '') || ' ' || COALESCE(specs::text, '')) LIKE $${i + 1})`);
    const query = `SELECT * FROM products WHERE ${conditions.join(' OR ')} ORDER BY updated_at DESC LIMIT $${patterns.length + 1}`;
    const params = [...patterns.map((p) => `%${p.toLowerCase()}%`), limit];
    const result = await this.db.query(query, params);
    return result.rows.map(mapProduct);
  }

  async listProductSourceUrls(limit = 10000) {
    const result = await this.db.query(
      `SELECT source_url
       FROM products
       WHERE source_url IS NOT NULL
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

  async createLead(input: { sessionId?: string; name: string; phone?: string; email?: string; question?: string }) {
    const result = await this.db.query(
      `INSERT INTO leads(session_id, name, phone, email, question)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.sessionId ?? null, input.name, input.phone ?? null, input.email ?? null, input.question ?? null]
    );
    return mapLead(result.rows[0]);
  }

  async markEmailResult(id: string, status: 'sent_email' | 'email_failed', providerResponse: Record<string, unknown>) {
    const result = await this.db.query(
      `UPDATE leads
       SET status = $2, email_provider_response = $3, sent_at = CASE WHEN $2 = 'sent_email' THEN now() ELSE sent_at END
       WHERE id = $1
       RETURNING *`,
      [id, status, providerResponse]
    );
    return mapLead(result.rows[0]);
  }

  async listLeads(limit = 100) {
    const result = await this.db.query('SELECT * FROM leads ORDER BY created_at DESC LIMIT $1', [limit]);
    return result.rows.map(mapLead);
  }
}
