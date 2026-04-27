import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { config } from './config.js';
import { ConversationRepository } from './db/repositories.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerLeadRoutes } from './routes/leads.js';
import { registerWidgetRoutes } from './routes/widget.js';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'development' ? 'info' : 'warn'
    },
    bodyLimit: 10 * 1024 * 1024
  });

  app.setErrorHandler((error, _request, reply) => {
    const status = (error as Error & { statusCode?: number }).statusCode ?? 500;
    reply.code(status).send({
      error: status >= 500 ? 'Internal server error' : (error as Error).message
    });
  });

  app.addHook('onRequest', async (request, reply) => {
    if (request.headers['access-control-request-private-network'] === 'true') {
      reply.header('Access-Control-Allow-Private-Network', 'true');
    }
  });

  await app.register(cors, {
    origin: true,
    credentials: true
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute'
  });

  app.get('/api/health', async () => ({
    ok: true,
    answerModel: config.OPENAI_ANSWER_MODEL,
    plannerModel: config.OPENAI_PLANNER_MODEL
  }));

  await registerChatRoutes(app);
  await registerLeadRoutes(app);
  await registerAdminRoutes(app);
  await registerWidgetRoutes(app);

  const conversations = new ConversationRepository();
  setInterval(() => {
    conversations.expireInactiveSessions().catch((error: unknown) => {
      app.log.warn({ error: error instanceof Error ? error.message : String(error) }, 'failed to expire sessions');
    });
  }, 60_000).unref();

  return app;
}
