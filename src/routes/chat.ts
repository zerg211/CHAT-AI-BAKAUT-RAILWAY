import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AssistantService } from '../ai/assistant.js';
import { ConversationRepository } from '../db/repositories.js';

const createSessionSchema = z.object({
  visitorId: z.string().optional(),
  pageUrl: z.string().optional()
});

const messageSchema = z.object({
  message: z.string().trim().min(1).max(6000)
});

const feedbackSchema = z.object({
  rating: z.enum(['positive', 'negative', 'wrong_cards'])
});

const generationStatusMessages = [
  'Проверяю каталог и контекст диалога...',
  'Сверяю факты и актуальные источники...',
  'Собираю короткий ответ с выводом и ценами...'
];

const GENERATION_TIMEOUT_MS = 120_000;

function requestHash(sessionId: string, message: string) {
  return createHash('sha256').update(`${sessionId}\n${message.trim()}`).digest('hex');
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function registerChatRoutes(app: FastifyInstance) {
  const conversations = new ConversationRepository();
  const assistant = new AssistantService(conversations);

  app.post('/api/chat/sessions', async (request, reply) => {
    const input = createSessionSchema.parse(request.body ?? {});
    const session = await conversations.createSession({
      visitorId: input.visitorId,
      pageUrl: input.pageUrl,
      userAgent: request.headers['user-agent']
    });
    return reply.send({ session });
  });

  app.post('/api/chat/sessions/:id/heartbeat', async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const session = await conversations.touchSession(params.id);
    if (!session) return reply.code(404).send({ error: 'Session not found or inactive' });
    return reply.send({ session });
  });

  app.post('/api/chat/sessions/:id/close', async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const session = await conversations.closeSession(params.id, 'closed');
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    return reply.send({ session });
  });

  app.post('/api/chat/sessions/:id/messages/:messageId/feedback', async (request, reply) => {
    const params = z.object({
      id: z.string().uuid(),
      messageId: z.string().uuid()
    }).parse(request.params);
    const input = feedbackSchema.parse(request.body ?? {});
    const message = await conversations.updateAssistantFeedback({
      sessionId: params.id,
      messageId: params.messageId,
      rating: input.rating
    });
    if (!message) return reply.code(404).send({ error: 'Message not found' });
    return reply.send({ message });
  });

  app.post('/api/chat/sessions/:id/messages', async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = messageSchema.parse(request.body ?? {});
    const session = await conversations.getSession(params.id);
    if (!session || session.status !== 'active') return reply.code(404).send({ error: 'Session not found or inactive' });
    const requestedTurnId = randomUUID();
    const turn = await conversations.createTurn({
      id: requestedTurnId,
      sessionId: params.id,
      requestHash: requestHash(params.id, input.message),
      status: 'received',
      stage: 'received'
    });
    const turnId = turn.id;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);
    timeout.unref?.();
    const abort = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.once('close', abort);

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });

    const send = (event: string, data: unknown) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let statusTimer: NodeJS.Timeout | null = null;
    try {
      send('start', { ok: true });
      send('turn', { turnId });
      let statusIndex = 0;
      send('status', { status: generationStatusMessages[statusIndex] });
      statusTimer = setInterval(() => {
        statusIndex = Math.min(statusIndex + 1, generationStatusMessages.length - 1);
        send('status', { status: generationStatusMessages[statusIndex] });
      }, 12_000);
      statusTimer.unref?.();
      const payload = await assistant.generateAnswer({
        sessionId: params.id,
        userMessage: input.message,
        turnId,
        onDelta: (delta) => send('delta', { delta }),
        signal: controller.signal
      });
      if (statusTimer) clearInterval(statusTimer);
      statusTimer = null;
      send('done', payload);
    } catch (error) {
      await conversations.updateTurn({
        sessionId: params.id,
        turnId,
        status: 'failed',
        stage: controller.signal.aborted ? 'timeout_or_aborted' : 'failed',
        errorCode: controller.signal.aborted ? 'generation_aborted_or_timeout' : 'generation_failed',
        errorMessage: safeErrorMessage(error)
      }).catch((updateError) => app.log.warn({ sessionId: params.id, turnId, error: safeErrorMessage(updateError) }, 'turn failure update failed'));
      const message = controller.signal.aborted
        ? 'Ответ не успел сформироваться. Попробуйте спросить короче или повторите запрос.'
        : 'Сейчас не смог надежно сформировать ответ. Вопрос сохранен, повторите его через пару минут.';
      if (!controller.signal.aborted) {
        app.log.warn({ sessionId: params.id, error: error instanceof Error ? error.message : String(error) }, 'chat generation failed');
      }
      send('error', { error: message, turnId, recoverable: true });
    } finally {
      if (statusTimer) clearInterval(statusTimer);
      clearTimeout(timeout);
      reply.raw.off('close', abort);
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    }
  });

  app.post('/api/chat/sessions/:id/messages/:turnId/recover', async (request, reply) => {
    const params = z.object({
      id: z.string().uuid(),
      turnId: z.string().uuid()
    }).parse(request.params);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);
    timeout.unref?.();
    const abort = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.once('close', abort);

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });

    const send = (event: string, data: unknown) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      send('turn', { turnId: params.turnId, recovered: true });
      send('status', { status: 'Ответ оборвался, восстанавливаю...' });
      const payload = await assistant.recoverTurn({
        sessionId: params.id,
        turnId: params.turnId,
        onDelta: (delta) => send('delta', { delta }),
        signal: controller.signal
      });
      send('done', payload);
    } catch (error) {
      await conversations.updateTurn({
        sessionId: params.id,
        turnId: params.turnId,
        status: 'failed',
        stage: 'recovery_failed',
        errorCode: controller.signal.aborted ? 'recovery_aborted_or_timeout' : 'recovery_failed',
        errorMessage: safeErrorMessage(error)
      }).catch((updateError) => app.log.warn({ sessionId: params.id, turnId: params.turnId, error: safeErrorMessage(updateError) }, 'turn recovery failure update failed'));
      app.log.warn({ sessionId: params.id, turnId: params.turnId, error: safeErrorMessage(error) }, 'chat recovery failed');
      send('error', {
        turnId: params.turnId,
        recoverable: false,
        error: 'Сейчас не смог надежно сформировать ответ. Вопрос сохранен, повторите его через пару минут.'
      });
    } finally {
      clearTimeout(timeout);
      reply.raw.off('close', abort);
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    }
  });
}
