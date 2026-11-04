import { startRuntimeDiagnostics } from './observability/runtimeDiagnostics.js';
import { randomUUID } from 'node:crypto';
import { registerRequestDiagnostics } from './observability/requestDiagnostics.js';
import { startDiagnosticJournal } from './observability/diagnosticJournal.js';
import { diagnosticEvent, diagnosticError, runWithDiagnostics } from './observability/diagnostics.js';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { config } from './config.js';
import { ConversationRepository } from './db/repositories.js';
import { createReadinessProbe } from './db/readiness.js';
import { startLeadOutboxWorker } from './ai/leadOutbox.js';
import { startKnowledgeEnrichmentWorker } from './ai/knowledgeEnrichment.js';
import { startPlatformUsageReconciliation } from './ai/openaiUsageGuard.js';
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
    genReqId: () => randomUUID(),
    disableRequestLogging: true,
    logger: {
      level: config.NODE_ENV === 'development' ? 'info' : 'warn'
    },
    bodyLimit: 2 * 1024 * 1024
  });

  registerRequestDiagnostics(app);
  if (config.NODE_ENV !== 'test') app.addHook('onClose',startDiagnosticJournal(config.DATABASE_URL));
  if (config.NODE_ENV !== 'test') app.addHook('onClose',startRuntimeDiagnostics());
  diagnosticEvent('service.started');

  app.setErrorHandler((error, _request, reply) => {
    diagnosticError('request.handler.failed',error);
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
    credentials: false,
    exposedHeaders: ['x-request-id','x-chat-turn-id']
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute'
  });

  app.get('/api/health', async () => {
    return {
      ok: true,
      runtime: {
        diagnosticsSchemaVersion: 1,
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
  let maintenanceInFlight: Promise<unknown> | undefined;
  const maintenanceTimer = setInterval(() => {
    if (maintenanceInFlight) return;
    maintenanceInFlight = runWithDiagnostics({jobId:randomUUID(),jobType:'session_maintenance'},() => {
      diagnosticEvent('job.started');
      return Promise.all([
      conversations.expireInactiveSessions(),
      conversations.deleteOldEmptyWidgetSessions(),
      conversations.deleteEmptyNonWidgetSessions()
    ]).then(() => diagnosticEvent('job.complete')).catch(error => {
      diagnosticError('job.failed',error);
      app.log.warn({ error: 'session_maintenance_failed' }, 'failed to maintain sessions');
    }).finally(() => { maintenanceInFlight = undefined; });
    });
  }, 60_000).unref();
  app.addHook('onClose', async () => {
    diagnosticEvent('service.stopping');
    clearInterval(maintenanceTimer);
    await maintenanceInFlight;
  });

  const readiness = createReadinessProbe(config.DATABASE_URL, () => Boolean(config.OPENAI_API_KEY?.trim()), Boolean(config.OPENAI_PLATFORM_AGENT_ID));
  app.get('/api/ready', async (_request, reply) => {
    const ready = await readiness.check();
    return reply.code(ready ? 200 : 503).send({ ready });
  });
  app.addHook('onClose', () => readiness.close());

  if (config.NODE_ENV !== 'test') {
    const stopOutbox = startLeadOutboxWorker({ log: app.log });
    app.addHook('onClose', stopOutbox);
    if (config.OPENAI_PLATFORM_AGENT_ID) app.addHook('onClose', startPlatformUsageReconciliation());
  }
  if (config.NODE_ENV !== 'test' && !config.OPENAI_PLATFORM_AGENT_ID) {
    const stopEnrichment = startKnowledgeEnrichmentWorker();
    app.addHook('onClose', stopEnrichment);
  }

  return app;
}
