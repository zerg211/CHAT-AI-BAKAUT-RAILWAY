import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AssistantService } from '../ai/assistant.js';
import { AgentSemanticDecisionIncoherentError, RecoveryAttemptUnavailableError, TurnExecutionInProgressError } from '../ai/agentManagerOrchestrator.js';
import { AgentManagerTurnBudgetExceededError } from '../ai/agentManagerTurnBudget.js';
import { getAgentManagerRuntimeDecision } from '../ai/agentManagerRuntime.js';
import { buildPublicCustomerResponse } from '../ai/agentManagerOutputGuard.js';
import { runWithOpenAIUsageContext } from '../ai/openaiUsageGuard.js';
import { config } from '../config.js';
import type { ChatResponsePayload } from '../shared/types.js';
import {
  ActiveConversationTurnError,
  ClientMessagePayloadConflictError,
  ConversationSessionUnavailableError,
  ConversationRepository
} from '../db/repositories.js';
import { limitPublicHistoryResponse, normalizePublicHistoryMessage } from '../shared/publicChatHistory.js';
import { closeSseReply, createStageStatusSender, customerStatusForStage, openSseReply } from './sse.js';
import { sseCorsHeaders } from '../cors.js';

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

const turnEventsQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200)
}).strict();

// Must exceed the turn budget wall time (150s) plus SSE delivery headroom.
const TURN_DEADLINE_MS = 160_000;

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

function publicPersistedTurnResult(value: unknown, turnId: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<ChatResponsePayload>;
  if (typeof candidate.answer !== 'string' || !Array.isArray(candidate.productCards)) return null;
  try {
    return buildPublicCustomerResponse({
      ...candidate,
      turnId,
      answer: candidate.answer,
      productCards: candidate.productCards
    } as ChatResponsePayload);
  } catch {
    return null;
  }
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

  app.get('/api/chat/sessions/:id/messages/:turnId/events', async (request, reply) => {
    const params = z.object({
      id: z.string().uuid(),
      turnId: z.string().uuid()
    }).parse(request.params);
    const query = turnEventsQuerySchema.parse(request.query ?? {});
    const session = await restoreAuthorizedSession(request, reply, conversations, params.id);
    if (!session) return sessionNotFound(reply);
    const turn = await conversations.getTurn(params.id, params.turnId);
    if (!turn) return reply.code(404).send({ error: 'Turn not found' });

    const eventRepository = conversations as ConversationRepository & {
      listTurnEvents?: ConversationRepository['listTurnEvents'];
      getFinalAnswerContract?: ConversationRepository['getFinalAnswerContract'];
    };
    const rows = typeof eventRepository.listTurnEvents === 'function'
      ? await eventRepository.listTurnEvents.call(conversations, params.id, params.turnId, query.afterSeq, query.limit)
      : [];
    const events = rows.map((row) => {
      const seq = Number(row.seq);
      if (!Number.isSafeInteger(seq) || seq <= 0) return null;
      const phase = String(row.stage ?? '');
      const eventType = String(row.event_type ?? '');
      const status = customerStatusForStage({ phase, eventType });
      return {
        seq,
        stage: phase,
        eventType,
        timestamp: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
        ...(status ? { status } : {})
      };
    }).filter((event): event is NonNullable<typeof event> => event !== null);
    const finalContract = typeof eventRepository.getFinalAnswerContract === 'function'
      ? await eventRepository.getFinalAnswerContract.call(conversations, params.id, params.turnId)
      : null;
    const result = publicPersistedTurnResult(finalContract?.response_payload, params.turnId);
    return reply.send({
      turnId: params.turnId,
      afterSeq: query.afterSeq,
      events,
      nextSeq: events.length ? events[events.length - 1].seq : query.afterSeq,
      result
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

    const send = openSseReply(reply, {
      'x-chat-turn-id': turnId,
      ...sseCorsHeaders(request.headers.origin)
    });

    try {
      send('start', { ok: true });
      send('turn', {
        turnId,
        clientMessageId
      });
      const sendStageStatus = createStageStatusSender(send);
      let payload: Awaited<ReturnType<typeof assistant.generateAnswer>>;
      try {
        payload = await runWithOpenAIUsageContext({
          sessionId: params.id,
          turnId,
          pageUrl: session.pageUrl,
          userAgent: session.userAgent
        }, () => assistant.generateAnswer({
          sessionId: params.id,
          userMessage: input.message,
           turnId,
           onDelta: (delta) => send('delta', { delta }),
           onStage: sendStageStatus,
           signal: controller.signal
        }));
      } catch (firstError) {
        const isTransient = !(firstError instanceof TurnExecutionInProgressError) &&
          !(firstError instanceof AgentSemanticDecisionIncoherentError) &&
          !(firstError instanceof AgentManagerTurnBudgetExceededError) &&
          !controller.signal.aborted;
        if (isTransient) {
          app.log.warn({ sessionId: params.id, turnId, error: safeErrorMessage(firstError) }, 'chat generation transient failure, retrying once');
          // brief backoff before retry
          await new Promise<void>((resolve) => setTimeout(resolve, 350));
          payload = await runWithOpenAIUsageContext({
            sessionId: params.id,
            turnId,
            pageUrl: session.pageUrl,
            userAgent: session.userAgent
          }, () => assistant.generateAnswer({
            sessionId: params.id,
            userMessage: input.message,
             turnId,
             onDelta: (delta) => send('delta', { delta }),
             onStage: sendStageStatus,
             signal: controller.signal
          }));
        } else {
          throw firstError;
        }
      }
      send('done', buildPublicCustomerResponse(payload));
    } catch (error) {
      const executionInProgress = error instanceof TurnExecutionInProgressError;
      const budgetStopped = error instanceof AgentManagerTurnBudgetExceededError;
      if (!executionInProgress) {
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
      const message = executionInProgress
        ? 'Этот ответ уже формируется в другом запросе. Дождитесь завершения — повторно выполнять ход не нужно.'
        : budgetStopped
          ? 'Ваш вопрос сохранён, но сейчас не удалось завершить ответ. Извините за ожидание.'
          : controller.signal.aborted
            ? 'Ваш вопрос сохранён, но ответ не успел подготовиться. Извините за ожидание.'
            : 'Сейчас не удалось подготовить ответ из-за технического сбоя. Ваш вопрос сохранён.';
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
        recoverable: false
      });
    } finally {
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

    const send = openSseReply(reply, {
      'x-chat-turn-id': params.turnId,
      ...sseCorsHeaders(request.headers.origin)
    });

    let runtimeDecision = getAgentManagerRuntimeDecision();
    try {
      runtimeDecision = getAgentManagerRuntimeDecision();
      send('turn', {
        turnId: params.turnId,
        recovered: true
      });
      const sendStageStatus = createStageStatusSender(send);
      const payload = await runWithOpenAIUsageContext({
        sessionId: params.id,
        turnId: params.turnId,
        pageUrl: sessionForRecovery?.pageUrl,
        userAgent: sessionForRecovery?.userAgent
      }, () => assistant.recoverTurn({
        sessionId: params.id,
        turnId: params.turnId,
        onDelta: (delta) => send('delta', { delta }),
        onStage: sendStageStatus,
        signal: controller.signal
      }));
      send('done', buildPublicCustomerResponse(payload));
    } catch (error) {
      const executionInProgress = error instanceof TurnExecutionInProgressError;
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
          : 'Не удалось завершить ответ. Ваш вопрос сохранён в истории чата.'
      });
    } finally {
      clearTimeout(timeout);
      closeSseReply(reply);
    }
  });
}
