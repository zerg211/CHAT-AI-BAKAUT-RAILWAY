import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { config } from './config.js';
import { ConversationRepository } from './db/repositories.js';
import { startLeadOutboxWorker } from './ai/leadOutbox.js';
import { AI_MANAGER_RUNTIME_MANIFEST } from './ai/aiManagerRuntimeManifest.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerLeadRoutes } from './routes/leads.js';
import { registerWidgetRoutes } from './routes/widget.js';

export function corsOriginsForEnvironment(input: {
  nodeEnv: 'development' | 'test' | 'production';
  configuredOrigins?: string;
  publicBaseUrl: string;
  catalogBaseUrl: string;
}) {
  if (input.configuredOrigins) {
    return input.configuredOrigins.split(',').map((origin) => origin.trim()).filter(Boolean);
  }
  if (input.nodeEnv !== 'production') return true as const;
  return [...new Set([new URL(input.publicBaseUrl).origin, new URL(input.catalogBaseUrl).origin])];
}

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'development' ? 'info' : 'warn'
    },
    bodyLimit: 2 * 1024 * 1024
  });

  app.setErrorHandler((error, _request, reply) => {
    const status = (error as Error & { statusCode?: number }).statusCode ?? 500;
    reply.code(status).send({
      error: status >= 500 ? 'Internal server error' : (error as Error).message
    });
  });

  app.addHook('onRequest', async (request, reply) => {
    if (config.NODE_ENV === 'development' && request.headers['access-control-request-private-network'] === 'true') {
      reply.header('Access-Control-Allow-Private-Network', 'true');
    }
  });

  const corsOrigins = corsOriginsForEnvironment({
    nodeEnv: config.NODE_ENV,
    configuredOrigins: config.CORS_ORIGINS,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    catalogBaseUrl: config.CATALOG_BASE_URL
  });
  await app.register(cors, {
    origin: corsOrigins,
    credentials: false
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute'
  });

  app.get('/api/health', async () => {
    return {
      ok: true,
      runtime: {
        commitSha: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? null,
        version: AI_MANAGER_RUNTIME_MANIFEST.version,
        contractVersion: AI_MANAGER_RUNTIME_MANIFEST.contractVersion,
        productionRuntime: AI_MANAGER_RUNTIME_MANIFEST.productionRuntime
      }
    };
  });

  await registerChatRoutes(app);
  await registerLeadRoutes(app);
  await registerAdminRoutes(app);
  await registerWidgetRoutes(app);

  const conversations = new ConversationRepository();
  setInterval(() => {
    Promise.all([
      conversations.expireInactiveSessions(),
      conversations.deleteOldEmptyWidgetSessions(),
      conversations.deleteEmptyNonWidgetSessions()
    ]).catch((error: unknown) => {
      app.log.warn({ error: error instanceof Error ? error.message : String(error) }, 'failed to maintain sessions');
    });
  }, 60_000).unref();

  if (config.NODE_ENV !== 'test') startLeadOutboxWorker({ log: app.log });

  return app;
}
