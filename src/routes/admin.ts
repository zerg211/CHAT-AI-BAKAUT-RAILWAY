import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { importCatalogCsv } from '../catalog/csvImport.js';
import { syncCatalogFromSite } from '../catalog/crawler.js';
import { syncCatalogFromSitemap } from '../catalog/sitemapSync.js';
import { config } from '../config.js';
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

export async function registerAdminRoutes(app: FastifyInstance) {
  const conversations = new ConversationRepository();
  const products = new ProductRepository();
  const leads = new LeadRepository();

  app.addHook('preHandler', async (request) => {
    if (request.url.startsWith('/api/admin/')) assertAdmin(request);
  });

  app.post('/api/admin/catalog/import-csv', async (request) => {
    const input = z.object({ filePath: z.string().min(1) }).parse(request.body ?? {});
    return importCatalogCsv(input.filePath, products);
  });

  app.post('/api/admin/catalog/sync-site', async (request) => {
    const input = z.object({
      maxPages: z.number().int().positive().optional(),
      startPath: z.string().min(1).optional()
    }).parse(request.body ?? {});
    return syncCatalogFromSite({ maxPages: input.maxPages, startPath: input.startPath }, products);
  });

  app.post('/api/admin/catalog/sync-sitemap', async (request) => {
    const input = z.object({
      sitemapUrl: z.string().url().optional(),
      maxProducts: z.number().int().positive().optional(),
      maxContentPages: z.number().int().positive().optional(),
      concurrency: z.number().int().positive().max(10).optional(),
      requestDelayMs: z.number().int().nonnegative().optional(),
      includeEmbeddings: z.boolean().optional(),
      includeProducts: z.boolean().optional(),
      includeContent: z.boolean().optional(),
      onlyUrls: z.array(z.string().url()).optional()
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
      turns: await conversations.listTurns(params.id, 200)
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

  app.get('/api/admin/conflicts', async (request) => {
    const query = z.object({ limit: z.coerce.number().int().positive().max(500).default(100) }).parse(request.query);
    return { conflicts: await products.listOpenConflicts(query.limit) };
  });

  app.get('/api/admin/products', async (request) => {
    const query = z.object({ limit: z.coerce.number().int().positive().max(500).default(100) }).parse(request.query);
    return { products: await products.listProducts(query.limit) };
  });
}
