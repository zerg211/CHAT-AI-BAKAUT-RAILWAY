import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AssistantService } from '../ai/assistant.js';
import { RecoveryAttemptUnavailableError, TurnExecutionInProgressError } from '../ai/agentManagerOrchestrator.js';
import { AgentManagerTurnBudgetExceededError } from '../ai/agentManagerTurnBudget.js';
import { getAgentManagerRuntimeDecision } from '../ai/agentManagerRuntime.js';
import { buildPublicCustomerResponse } from '../ai/agentManagerOutputGuard.js';
import { runWithOpenAIUsageContext } from '../ai/openaiUsageGuard.js';
import { config } from '../config.js';
import {
  ActiveConversationTurnError,
  ClientMessagePayloadConflictError,
  ConversationSessionUnavailableError,
  ConversationRepository
} from '../db/repositories.js';
import { limitPublicHistoryResponse, normalizePublicHistoryMessage } from '../shared/publicChatHistory.js';
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

const TURN_DEADLINE_MS = 105_000;

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

interface ChatRouteDependencies {
  conversations?: ConversationRepository;
  assistant?: AssistantService;
}

function visitorCapabilityFromRequest(request: FastifyRequest) {
  const value = request.headers['x-bakaut-visitor-id'];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function setPrivateSessionHeaders(reply: FastifyReply) {
  reply.header('cache-control', 'no-store');
  reply.header('vary', 'x-bakaut-visitor-id');
}

async function restoreAuthorizedSession(
  request: FastifyRequest,
  reply: FastifyReply,
  conversations: ConversationRepository,
  sessionId: string
) {
  setPrivateSessionHeaders(reply);
  const visitorCapability = visitorCapabilityFromRequest(request);
  if (!visitorCapability) return null;
  return conversations.restoreSession(sessionId, visitorCapability);
}

function sessionNotFound(reply: FastifyReply) {
  return reply.code(404).send({ error: 'Session not found or inactive' });
}

function publicHistoryMessage(message: Awaited<ReturnType<ConversationRepository['listMessages']>>[number]) {
  const metadata = message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
    ? message.metadata as Record<string, unknown>
    : {};
  const candidate: Record<string, unknown> = {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt
  };
  if (message.role === 'assistant') {
    candidate.products = metadata.productCards;
    candidate.cardDisplay = metadata.cardDisplay;
    const answerContract = metadata.answerContract;
    if (
      answerContract &&
      typeof answerContract === 'object' &&
      !Array.isArray(answerContract) &&
      (answerContract as Record<string, unknown>).leadAction === 'offer_form'
    ) {
      candidate.leadRequested = true;
    }
  }
  return normalizePublicHistoryMessage(candidate);
}

function publicPendingTurn(
  pending: NonNullable<Awaited<ReturnType<ConversationRepository['getLatestUnansweredTurn']>>>
) {
  const { turn, resultReady } = pending;
  const terminal = turn.status === 'completed' || turn.status === 'recovered' || turn.status === 'failed';
  return {
    turnId: turn.id,
    status: turn.status,
    stage: turn.stage ?? null,
    deadlineAt: turn.deadlineAt ?? null,
    terminal,
    resultState: resultReady ? 'ready' : terminal ? 'failed' : 'pending'
  };
}

export async function registerChatRoutes(
  app: FastifyInstance,
  dependencies: ChatRouteDependencies = {}
) {
  const conversations = dependencies.conversations ?? new ConversationRepository();
  const assistant = dependencies.assistant ?? new AssistantService(conversations);

  app.post('/api/chat/sessions', async (request, reply) => {
    const input = createSessionSchema.parse(request.body ?? {});
    const session = await conversations.createSession({
      visitorId: input.visitorId,
      pageUrl: input.pageUrl,
      userAgent: request.headers['user-agent']?.slice(0, 500)
    });
    return reply.send({ session });
  });

  app.get('/api/chat/sessions/:id/messages', async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const session = await restoreAuthorizedSession(request, reply, conversations, params.id);
    if (!session) return sessionNotFound(reply);
    const history = await conversations.getHistorySnapshot(params.id);
    return reply.send({
      messages: limitPublicHistoryResponse(history.messages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map(publicHistoryMessage)
        .filter((message) => message !== null)),
      leadOfferConsumed: history.leadOfferConsumed,
      pendingTurn: history.pendingTurn ? publicPendingTurn(history.pendingTurn) : null
    });
  });

  app.post('/api/chat/sessions/:id/heartbeat', async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const session = await restoreAuthorizedSession(request, reply, conversations, params.id);
    if (!session) return sessionNotFound(reply);
    return reply.send({ ok: true });
  });

  app.post('/api/chat/sessions/:id/close', async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    setPrivateSessionHeaders(reply);
    const visitorCapability = visitorCapabilityFromRequest(request);
    if (!visitorCapability) return sessionNotFound(reply);
    const session = await conversations.closeSession({
      id: params.id,
      visitorCapability
    });
    if (!session) return sessionNotFound(reply);
    return reply.send({ ok: true });
  });

  app.post('/api/chat/sessions/:id/messages/:messageId/feedback', async (request, reply) => {
    const params = z.object({
      id: z.string().uuid(),
      messageId: z.string().uuid()
    }).parse(request.params);
    const input = feedbackSchema.parse(request.body ?? {});
    setPrivateSessionHeaders(reply);
    const visitorCapability = visitorCapabilityFromRequest(request);
    if (!visitorCapability) return sessionNotFound(reply);
    const message = await conversations.updateAssistantFeedback({
      sessionId: params.id,
      messageId: params.messageId,
      visitorCapability,
      rating: input.rating
    });
    if (!message) return sessionNotFound(reply);
    return reply.send({ ok: true });
  });

  app.post('/api/chat/sessions/:id/messages', async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = messageSchema.parse(request.body ?? {});
    const session = await restoreAuthorizedSession(request, reply, conversations, params.id);
    if (!session) return sessionNotFound(reply);
    const visitorCapability = visitorCapabilityFromRequest(request);
    if (!visitorCapability) return sessionNotFound(reply);
    const runtimeDecision = getAgentManagerRuntimeDecision();
    const requestedTurnId = randomUUID();
    const clientMessageId = input.clientMessageId ?? randomUUID();
    let turn: Awaited<ReturnType<ConversationRepository['createTurnWithUserMessage']>>;
    try {
      turn = await conversations.createTurnWithUserMessage({
        id: requestedTurnId,
        sessionId: params.id,
        visitorCapability,
        clientMessageId,
        requestHash: requestHash(params.id, input.message),
        content: input.message,
        activeNeedsBefore: session.needState.activeNeeds ?? [],
        deadlineAt: new Date(Date.now() + TURN_DEADLINE_MS).toISOString()
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
      if (error instanceof ConversationSessionUnavailableError) {
        return sessionNotFound(reply);
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
        clientMessageId
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
      send('done', buildPublicCustomerResponse(payload));
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
          send('done', buildPublicCustomerResponse(recoveredPayload));
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
          errorMessage: safeErrorMessage(error),
          requireUnowned: true
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
        recoverable: clientRecoveryAllowed
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
    const sessionForRecovery = await restoreAuthorizedSession(request, reply, conversations, params.id);
    if (!sessionForRecovery) return sessionNotFound(reply);
    const persistedTurn = await conversations.getTurn(params.id, params.turnId);
    if (!persistedTurn) return reply.code(404).send({ error: 'Turn not found' });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remainingTurnDeadlineMs(persistedTurn?.deadlineAt));
    timeout.unref?.();

    const send = openSseReply(reply, { 'x-chat-turn-id': params.turnId });

    let stopStatusTimer: (() => void) | null = null;
    let runtimeDecision = getAgentManagerRuntimeDecision();
    try {
      runtimeDecision = getAgentManagerRuntimeDecision();
      send('turn', {
        turnId: params.turnId,
        recovered: true
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
      send('done', buildPublicCustomerResponse(payload));
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
          errorMessage: safeErrorMessage(error),
          requireUnowned: true
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
