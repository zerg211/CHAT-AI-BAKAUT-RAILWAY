import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { importCatalogCsv } from '../catalog/csvImport.js';
import { syncCatalogFromSite } from '../catalog/crawler.js';
import { syncCatalogFromSitemap } from '../catalog/sitemapSync.js';
import { buildEmbeddingCoverageReport } from '../ai/embeddingCoverage.js';
import { EvalLlmRubricJudgeInputSchema, runEvalLlmRubricJudge } from '../ai/evalJudge.js';
import { createOpenAIClient } from '../ai/openaiClient.js';
import { recordOpenAIUsageOnce } from '../ai/openaiUsageGuard.js';
import { getAgentManagerRuntimeDecision } from '../ai/agentManagerRuntime.js';
import { AI_MANAGER_RUNTIME_MANIFEST } from '../ai/aiManagerRuntimeManifest.js';
import {
  AssistantFeedbackQueueStatusSchema,
  AssistantFeedbackRatingSchema,
  buildAssistantFeedbackRegressionCandidate,
  knownPiiValuesForFeedback
} from '../ai/assistantFeedbackQueue.js';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { ConversationRepository, LeadRepository, ProductRepository } from '../db/repositories.js';

function adminSecret() {
  return config.ADMIN_PASSWORD?.trim() || config.ADMIN_API_KEY?.trim();
}

function secretsMatch(input: string, expected: string) {
  const inputBuffer = Buffer.from(input);
  const expectedBuffer = Buffer.from(expected);
  return inputBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(inputBuffer, expectedBuffer);
}

function assertAdmin(request: FastifyRequest) {
  const secret = adminSecret();
  if (!secret) {
    const error = new Error('Пароль администратора не настроен. Задайте ADMIN_PASSWORD в переменных окружения.');
    (error as Error & { statusCode?: number }).statusCode = 403;
    throw error;
  }

  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (!token || !secretsMatch(token, secret)) {
    const error = new Error('Unauthorized');
    (error as Error & { statusCode?: number }).statusCode = 401;
    throw error;
  }
}

export type OpenAIRuntimeErrorClass =
  | 'quota_or_billing'
  | 'authentication'
  | 'provider_access_region'
  | 'rate_limit'
  | 'model_project_or_org_access'
  | 'network_or_timeout'
  | 'unknown';

function safeJsonText(value: unknown) {
  try {
    return JSON.stringify(value ?? '');
  } catch {
    return String(value ?? '');
  }
}

function classifierText(status: unknown, body: unknown) {
  return `${status ?? ''} ${safeJsonText(body)}`.toLocaleLowerCase('en');
}

function containsAnyPhrase(text: string, phrases: string[]) {
  return phrases.some((phrase) => text.includes(phrase));
}

function statusCode(value: unknown) {
  const code = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(code) ? code : null;
}

export function classifyOpenAIRuntimeError(status: unknown, body: unknown): OpenAIRuntimeErrorClass {
  const text = classifierText(status, body);
  const code = statusCode(status);
  if (containsAnyPhrase(text, ['insufficient_quota', 'quota', 'billing', 'credits'])) return 'quota_or_billing';
  if (code === 401 || containsAnyPhrase(text, ['invalid_api_key', 'incorrect api key', '401'])) return 'authentication';
  if (text.includes('unsupported_country_region_territory')) return 'provider_access_region';
  if (code === 429 || containsAnyPhrase(text, ['rate_limit', '429'])) return 'rate_limit';
  if (code === 403 || containsAnyPhrase(text, ['model_not_found', 'permission', '403'])) return 'model_project_or_org_access';
  if (containsAnyPhrase(text, ['timeout', 'aborted', 'econnreset', 'fetch failed', 'connection'])) return 'network_or_timeout';
  return 'unknown';
}

function safeOpenAIError(error: unknown) {
  const maybe = error as {
    status?: number;
    code?: string;
    type?: string;
    message?: string;
    error?: unknown;
  };
  return {
    status: maybe.status ?? null,
    code: maybe.code ?? null,
    type: maybe.type ?? null,
    class: classifyOpenAIRuntimeError(maybe.status, maybe.error ?? maybe.message ?? error),
    message: String(maybe.message ?? error).slice(0, 500)
  };
}

export async function registerAdminRoutes(app: FastifyInstance) {
  const conversations = new ConversationRepository();
  const products = new ProductRepository();
  const leads = new LeadRepository();

  app.addHook('preHandler', async (request) => {
    if (request.url.startsWith('/api/admin/')) assertAdmin(request);
  });

  app.get('/api/admin/health', async () => {
    const operations = config.NODE_ENV === 'test'
      ? {
          catalog: { status: 'not_checked_in_test' },
          embeddings: { status: 'not_checked_in_test' },
          leadOutbox: { status: 'not_checked_in_test' }
        }
      : await (async () => {
          const [catalog, embeddings, leadOutbox] = await Promise.allSettled([
            products.getCatalogFreshness(),
            products.getEmbeddingCoverage('products'),
            leads.getLeadOutboxHealth()
          ]);
          const unavailable = (_result: PromiseRejectedResult) => ({
            status: 'unavailable',
            errorCode: 'operation_health_check_failed'
          });
          return {
            catalog: catalog.status === 'fulfilled' ? catalog.value : unavailable(catalog),
            embeddings: embeddings.status === 'fulfilled' ? embeddings.value : unavailable(embeddings),
            leadOutbox: leadOutbox.status === 'fulfilled' ? leadOutbox.value : unavailable(leadOutbox)
          };
        })();
    return {
      ok: true,
      answerModel: config.OPENAI_ANSWER_MODEL,
      plannerModel: config.OPENAI_PLANNER_MODEL,
      factModel: config.OPENAI_FACT_MODEL,
      runtime: {
        commitSha: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? null,
        branch: process.env.RAILWAY_GIT_BRANCH ?? process.env.GIT_BRANCH ?? null,
        decision: getAgentManagerRuntimeDecision(null),
        manifest: AI_MANAGER_RUNTIME_MANIFEST
      },
      operations
    };
  });

  app.post('/api/admin/catalog/import-csv', async (request) => {
    const input = z.object({ filePath: z.string().trim().min(1).max(1000) }).parse(request.body ?? {});
    return importCatalogCsv(input.filePath, products);
  });

  app.post('/api/admin/catalog/sync-site', async (request) => {
    const input = z.object({
      maxPages: z.number().int().positive().max(5000).optional(),
      startPath: z.string().trim().min(1).max(2000).optional()
    }).parse(request.body ?? {});
    return syncCatalogFromSite({ maxPages: input.maxPages, startPath: input.startPath }, products);
  });

  app.post('/api/admin/catalog/sync-sitemap', async (request) => {
    const input = z.object({
      sitemapUrl: z.string().url().optional(),
      maxProducts: z.number().int().positive().max(100_000).optional(),
      maxContentPages: z.number().int().positive().max(100_000).optional(),
      concurrency: z.number().int().positive().max(10).optional(),
      requestDelayMs: z.number().int().nonnegative().max(60_000).optional(),
      includeEmbeddings: z.boolean().optional(),
      includeProducts: z.boolean().optional(),
      includeContent: z.boolean().optional(),
      onlyUrls: z.array(z.string().url()).max(5000).optional()
    }).parse(request.body ?? {});
    return syncCatalogFromSitemap(input, products);
  });

  app.get('/api/admin/conversations', async (request) => {
    const query = z.object({
      limit: z.coerce.number().int().positive().max(500).default(100),
      filter: z.enum(['all', 'withMessages', 'empty']).default('all')
    }).parse(request.query);
    const [sessions, stats] = await Promise.all([
      conversations.listSessions(query.limit, query.filter),
      conversations.listSessionStats()
    ]);
    return { sessions, stats };
  });

  app.get('/api/admin/conversations/:id', async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const session = await conversations.getSession(params.id);
    if (!session) {
      const error = new Error('Conversation not found');
      (error as Error & { statusCode?: number }).statusCode = 404;
      throw error;
    }
    return {
      session,
      messages: await conversations.listMessages(params.id, 200),
      turns: await conversations.listTurns(params.id, 200),
      agentTraces: await conversations.listAgentTraces(params.id, undefined, 200)
    };
  });

  app.get('/api/admin/conversations/:id/agent-traces', async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z.object({
      turnId: z.string().uuid().optional(),
      limit: z.coerce.number().int().positive().max(500).default(200)
    }).parse(request.query);
    return {
      traces: await conversations.listAgentTraces(params.id, query.turnId, query.limit)
    };
  });

  app.delete('/api/admin/conversations/:id', async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const deleted = await conversations.deleteSession(params.id);
    if (!deleted) {
      const error = new Error('Conversation not found');
      (error as Error & { statusCode?: number }).statusCode = 404;
      throw error;
    }
    return { deleted };
  });

  app.get('/api/admin/leads', async (request) => {
    const query = z.object({ limit: z.coerce.number().int().positive().max(500).default(100) }).parse(request.query);
    return { leads: await leads.listLeads(query.limit) };
  });

  app.get('/api/admin/feedback', async (request) => {
    const query = z.object({
      limit: z.coerce.number().int().positive().max(500).default(100),
      status: AssistantFeedbackQueueStatusSchema.optional(),
      rating: AssistantFeedbackRatingSchema.optional()
    }).parse(request.query);
    return { items: await conversations.listAssistantFeedbackQueue(query) };
  });

  app.patch('/api/admin/feedback/:id', async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ status: AssistantFeedbackQueueStatusSchema }).parse(request.body ?? {});
    const item = await conversations.updateAssistantFeedbackQueueStatus({ id: params.id, status: body.status });
    if (!item) {
      const error = new Error('Feedback event not found');
      (error as Error & { statusCode?: number }).statusCode = 404;
      throw error;
    }
    return { item };
  });

  app.post('/api/admin/feedback/:id/export-candidate', async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      knownPiiValues: z.array(z.string().trim().min(2).max(300)).max(30).default([])
    }).parse(request.body ?? {});
    const item = await conversations.getAssistantFeedbackQueueItem(params.id);
    if (!item) {
      const error = new Error('Feedback event not found');
      (error as Error & { statusCode?: number }).statusCode = 404;
      throw error;
    }
    const fixture = buildAssistantFeedbackRegressionCandidate(item, {
      knownPiiValues: [...new Set([
        ...knownPiiValuesForFeedback(item),
        ...body.knownPiiValues
      ])]
    });
    await conversations.markAssistantFeedbackExported({ id: item.id, fixture });
    return { fixture };
  });

  app.get('/api/admin/conflicts', async (request) => {
    const query = z.object({ limit: z.coerce.number().int().positive().max(500).default(100) }).parse(request.query);
    return { conflicts: await products.listOpenConflicts(query.limit) };
  });

  app.get('/api/admin/products', async (request) => {
    const query = z.object({ limit: z.coerce.number().int().positive().max(500).default(100) }).parse(request.query);
    return { products: await products.listProducts(query.limit) };
  });

  app.get('/api/admin/embedding-coverage', async () => buildEmbeddingCoverageReport(products));

  app.get('/api/admin/catalog/freshness', async (request) => {
    const query = z.object({
      staleAfterHours: z.coerce.number().int().positive().max(24 * 30).default(config.CATALOG_STALE_AFTER_HOURS)
    }).parse(request.query);
    return products.getCatalogFreshness(query.staleAfterHours);
  });

  app.get('/api/admin/runtime/openai', async () => {
    const client = createOpenAIClient();
    if (!client) {
      return {
        ok: false,
        provider: 'openai',
        class: 'authentication',
        code: 'missing_openai_api_key',
        answerModel: config.OPENAI_ANSWER_MODEL,
        plannerModel: config.OPENAI_PLANNER_MODEL,
        factModel: config.OPENAI_FACT_MODEL
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    timeout.unref?.();
    try {
      const response: any = await client.responses.create({
        model: config.OPENAI_PLANNER_MODEL,
        input: 'Reply with exactly: OK',
        max_output_tokens: 16
      }, { signal: controller.signal });
      await recordOpenAIUsageOnce('admin_runtime_probe', config.OPENAI_PLANNER_MODEL, response);
      return {
        ok: true,
        provider: 'openai',
        class: 'ok',
        answerModel: config.OPENAI_ANSWER_MODEL,
        plannerModel: config.OPENAI_PLANNER_MODEL,
        factModel: config.OPENAI_FACT_MODEL,
        responseId: typeof response?.id === 'string' ? response.id : null,
        outputPresent: Boolean(response?.output_text || response?.output?.length)
      };
    } catch (error) {
      return {
        ok: false,
        provider: 'openai',
        answerModel: config.OPENAI_ANSWER_MODEL,
        plannerModel: config.OPENAI_PLANNER_MODEL,
        factModel: config.OPENAI_FACT_MODEL,
        error: safeOpenAIError(error)
      };
    } finally {
      clearTimeout(timeout);
    }
  });

  app.post('/api/admin/evals/llm-rubric', async (request) => {
    const input = EvalLlmRubricJudgeInputSchema.parse(request.body ?? {});
    const result = await runEvalLlmRubricJudge({ prompt: input.prompt });
    return {
      ok: true,
      model: config.OPENAI_FACT_MODEL,
      result
    };
  });

  app.get('/api/admin/openai-usage', async (request) => {
    const query = z.object({
      hours: z.coerce.number().int().positive().max(168).default(24),
      source: z.string().trim().min(1).max(80).optional()
    }).parse(request.query);
    const params: unknown[] = [query.hours];
    const sourceClause = query.source ? 'AND request_source = $2' : '';
    if (query.source) params.push(query.source);
    const result = await pool.query(
      `SELECT
         request_source,
         stage,
         model,
         count(*)::int AS call_count,
         coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
         coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
         coalesce(sum(reasoning_tokens), 0)::bigint AS reasoning_tokens,
         coalesce(sum(total_tokens), 0)::bigint AS total_tokens,
         min(created_at) AS first_seen_at,
         max(created_at) AS last_seen_at
       FROM openai_usage_events
       WHERE created_at >= now() - ($1 || ' hours')::interval
         ${sourceClause}
       GROUP BY request_source, stage, model
       ORDER BY total_tokens DESC, call_count DESC`,
      params
    );
    return {
      hours: query.hours,
      source: query.source ?? null,
      budget: {
        dailyTokenBudget: config.OPENAI_DAILY_TOKEN_BUDGET,
        guardReserveTokens: config.OPENAI_BUDGET_GUARD_RESERVE_TOKENS
      },
      rows: result.rows.map((row) => ({
        requestSource: row.request_source,
        stage: row.stage,
        model: row.model,
        callCount: Number(row.call_count ?? 0),
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        reasoningTokens: Number(row.reasoning_tokens ?? 0),
        totalTokens: Number(row.total_tokens ?? 0),
        firstSeenAt: row.first_seen_at?.toISOString?.() ?? row.first_seen_at ?? null,
        lastSeenAt: row.last_seen_at?.toISOString?.() ?? row.last_seen_at ?? null
      }))
    };
  });
}
