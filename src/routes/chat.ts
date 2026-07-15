import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AssistantService } from '../ai/assistant.js';
import { RecoveryAttemptUnavailableError, TurnExecutionInProgressError } from '../ai/agentManagerOrchestrator.js';
import { AgentManagerTurnBudgetExceededError } from '../ai/agentManagerTurnBudget.js';
import { getAgentManagerRuntimeDecision } from '../ai/agentManagerRuntime.js';
import { runWithOpenAIUsageContext } from '../ai/openaiUsageGuard.js';
import { config } from '../config.js';
import {
  ActiveConversationTurnError,
  ClientMessagePayloadConflictError,
  ConversationRepository
} from '../db/repositories.js';
import { closeSseReply, openSseReply, startStatusTimer } from './sse.js';

const createSessionSchema = z.object({
  visitorId: z.string().trim().min(1).max(200).optional(),
  pageUrl: z.string().trim().url().max(2048).optional()
}).strict();

const messageSchema = z.object({
  message: z.string().trim().min(1).max(6000),
  clientMessageId: z.string().uuid().optional()
}).strict();

const feedbackSchema = z.object({
  rating: z.enum(['positive', 'negative', 'wrong_cards'])
}).strict();

const generationStatusMessages = [
  'Проверяю каталог и контекст диалога...',
  'Сверяю факты и актуальные источники...',
  'Собираю короткий ответ с выводом и ценами...'
];

const TURN_DEADLINE_MS = 60_000;

function remainingTurnDeadlineMs(deadlineAt: string | null | undefined) {
  const parsed = deadlineAt ? Date.parse(deadlineAt) : Number.NaN;
  return Number.isFinite(parsed)
    ? Math.max(1, parsed - Date.now())
    : TURN_DEADLINE_MS;
}

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
      userAgent: request.headers['user-agent']?.slice(0, 500)
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
    const runtimeDecision = getAgentManagerRuntimeDecision();
    const requestedTurnId = randomUUID();
    const clientMessageId = input.clientMessageId ?? randomUUID();
    let turn: Awaited<ReturnType<ConversationRepository['createTurn']>>;
    try {
      turn = await conversations.createTurn({
        id: requestedTurnId,
        sessionId: params.id,
        clientMessageId,
        requestHash: requestHash(params.id, input.message),
        status: 'received',
        stage: 'received'
      });
    } catch (error) {
      if (error instanceof ActiveConversationTurnError) {
        return reply.code(409).send({
          error: error.code,
          activeTurnId: error.activeTurnId,
          recoverable: true
        });
      }
      if (error instanceof ClientMessagePayloadConflictError) {
        return reply.code(409).send({ error: error.code, recoverable: false });
      }
      throw error;
    }
    const turnId = turn.id;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remainingTurnDeadlineMs(turn.deadlineAt));
    timeout.unref?.();

    const send = openSseReply(reply, { 'x-chat-turn-id': turnId });

    let stopStatusTimer: (() => void) | null = null;
    try {
      send('start', { ok: true });
      send('turn', {
        turnId,
        clientMessageId,
        runtimeMode: runtimeDecision.runtimeMode,
        runtimeModeReason: runtimeDecision.reason,
        agentManagerRuntime: runtimeDecision
      });
      stopStatusTimer = startStatusTimer({
        send,
        initialStatus: generationStatusMessages[0],
        statusMessages: generationStatusMessages
      });
      const payload = await runWithOpenAIUsageContext({
        sessionId: params.id,
        turnId,
        pageUrl: session.pageUrl,
        userAgent: session.userAgent
      }, () => assistant.generateAnswer({
        sessionId: params.id,
        userMessage: input.message,
        turnId,
        onDelta: (delta) => send('delta', { delta }),
        signal: controller.signal
      }));
      stopStatusTimer?.();
      stopStatusTimer = null;
      send('done', payload);
    } catch (error) {
      const executionInProgress = error instanceof TurnExecutionInProgressError;
      const budgetStopped = error instanceof AgentManagerTurnBudgetExceededError;
      const recoveryAllowed = !executionInProgress && !budgetStopped;
      let semanticRecoveryAttempted = false;
      if (!controller.signal.aborted && recoveryAllowed) {
        semanticRecoveryAttempted = true;
        try {
          const recoveredPayload = await runWithOpenAIUsageContext({
            sessionId: params.id,
            turnId,
            pageUrl: session.pageUrl,
            userAgent: session.userAgent
          }, () => assistant.recoverTurn({
            sessionId: params.id,
            turnId,
            onDelta: (delta) => send('delta', { delta }),
            signal: controller.signal
          }));
          stopStatusTimer?.();
          stopStatusTimer = null;
          send('done', recoveredPayload);
          return;
        } catch (recoveryError) {
          app.log.warn({ sessionId: params.id, turnId, error: safeErrorMessage(recoveryError) }, 'agent manager same-turn recovery failed');
        }
      }
      if (recoveryAllowed) {
        await conversations.updateTurn({
          sessionId: params.id,
          turnId,
          status: 'failed',
          stage: controller.signal.aborted ? 'timeout_or_aborted' : 'failed',
          errorCode: controller.signal.aborted
            ? `${runtimeDecision.runtimeMode}_generation_aborted_or_timeout`
            : `${runtimeDecision.runtimeMode}_generation_failed`,
          errorMessage: safeErrorMessage(error)
        }).catch((updateError) => app.log.warn({ sessionId: params.id, turnId, error: safeErrorMessage(updateError) }, 'turn failure update failed'));
      }
      const clientRecoveryAllowed = recoveryAllowed && !semanticRecoveryAttempted && !controller.signal.aborted;
      const message = executionInProgress
        ? 'Этот ответ уже формируется в другом запросе. Дождитесь завершения — повторно выполнять ход не нужно.'
        : budgetStopped
          ? 'Не удалось завершить ответ в безопасных лимитах этого хода. Запрос сохранён; попробуйте уточнить его короче.'
          : controller.signal.aborted
            ? 'Не удалось завершить ответ в пределах времени этого хода. Запрос сохранён, но повторный запуск этого же хода не выполняется.'
            : 'Не удалось завершить ответ после единственной попытки восстановления. Запрос сохранён, но повторный запуск этого же хода не выполняется.';
      if (!controller.signal.aborted) {
        app.log.warn({
          sessionId: params.id,
          runtimeMode: runtimeDecision.runtimeMode,
          runtimeModeReason: runtimeDecision.reason,
          error: error instanceof Error ? error.message : String(error)
        }, 'chat generation failed');
      }
      send('error', {
        error: message,
        turnId,
        recoverable: clientRecoveryAllowed,
        runtimeMode: runtimeDecision.runtimeMode,
        runtimeModeReason: runtimeDecision.reason,
        agentManagerRuntime: runtimeDecision
      });
    } finally {
      stopStatusTimer?.();
      clearTimeout(timeout);
      closeSseReply(reply);
    }
  });

  app.post('/api/chat/sessions/:id/messages/:turnId/recover', async (request, reply) => {
    const params = z.object({
      id: z.string().uuid(),
      turnId: z.string().uuid()
    }).parse(request.params);
    const persistedTurn = await conversations.getTurn(params.id, params.turnId);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remainingTurnDeadlineMs(persistedTurn?.deadlineAt));
    timeout.unref?.();

    const send = openSseReply(reply, { 'x-chat-turn-id': params.turnId });

    let stopStatusTimer: (() => void) | null = null;
    let sessionForRecovery: Awaited<ReturnType<ConversationRepository['getSession']>> | null = null;
    let runtimeDecision = getAgentManagerRuntimeDecision();
    try {
      sessionForRecovery = await conversations.getSession(params.id);
      runtimeDecision = getAgentManagerRuntimeDecision();
      send('turn', {
        turnId: params.turnId,
        recovered: true,
        runtimeMode: runtimeDecision.runtimeMode,
        runtimeModeReason: runtimeDecision.reason,
        agentManagerRuntime: runtimeDecision
      });
      stopStatusTimer = startStatusTimer({
        send,
        initialStatus: 'Ответ оборвался, восстанавливаю...',
        statusMessages: generationStatusMessages
      });
      const payload = await runWithOpenAIUsageContext({
        sessionId: params.id,
        turnId: params.turnId,
        pageUrl: sessionForRecovery?.pageUrl,
        userAgent: sessionForRecovery?.userAgent
      }, () => assistant.recoverTurn({
        sessionId: params.id,
        turnId: params.turnId,
        onDelta: (delta) => send('delta', { delta }),
        signal: controller.signal
      }));
      send('done', payload);
    } catch (error) {
      const executionInProgress = error instanceof TurnExecutionInProgressError;
      const budgetStopped = error instanceof AgentManagerTurnBudgetExceededError;
      const recoveryUnavailable = error instanceof RecoveryAttemptUnavailableError;
      if (!executionInProgress) {
        await conversations.updateTurn({
          sessionId: params.id,
          turnId: params.turnId,
          status: 'failed',
          stage: 'recovery_failed',
          errorCode: controller.signal.aborted
            ? `${runtimeDecision.runtimeMode}_recovery_aborted_or_timeout`
            : `${runtimeDecision.runtimeMode}_recovery_failed`,
          errorMessage: safeErrorMessage(error)
        }).catch((updateError) => app.log.warn({ sessionId: params.id, turnId: params.turnId, error: safeErrorMessage(updateError) }, 'turn recovery failure update failed'));
      }
      app.log.warn({
        sessionId: params.id,
        turnId: params.turnId,
        runtimeMode: runtimeDecision.runtimeMode,
        runtimeModeReason: runtimeDecision.reason,
        error: safeErrorMessage(error)
      }, 'chat recovery failed');
      send('error', {
        turnId: params.turnId,
        recoverable: false,
        runtimeMode: runtimeDecision.runtimeMode,
        runtimeModeReason: runtimeDecision.reason,
        agentManagerRuntime: runtimeDecision,
        error: executionInProgress
          ? 'Этот ответ уже формируется в другом запросе. Дождитесь завершения — повторно выполнять ход не нужно.'
          : budgetStopped
            ? 'Не удалось завершить ответ в безопасных лимитах этого хода. Запрос сохранён; попробуйте уточнить его короче.'
            : recoveryUnavailable
              ? 'Для этого хода уже использована единственная попытка восстановления. Новый запуск этого же хода не выполняется.'
              : 'Не удалось завершить восстановление этого хода. Запрос сохранён, но повторный запуск этого же хода не выполняется.'
      });
    } finally {
      stopStatusTimer?.();
      clearTimeout(timeout);
      closeSseReply(reply);
    }
  });
}
