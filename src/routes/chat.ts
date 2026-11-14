import { bindDiagnosticIdentity, diagnosticAbortSource, diagnosticError, diagnosticEvent, safeErrorFields } from '../observability/diagnostics.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AssistantService } from '../ai/assistant.js';
import { PlatformAgentClient } from '../ai/platformAgentClient.js';
import { ControlledRequestRejected } from '../ai/controlledResponsesClient.js';
import { AgentAnswerRejectedError } from '../ai/agentAnswerRejected.js';
import { RecoveryAttemptUnavailableError, TurnExecutionInProgressError } from '../ai/agentManagerOrchestrator.js';
import { AgentManagerTurnBudgetExceededError } from '../ai/agentManagerTurnBudget.js';
import { getAgentManagerRuntimeDecision } from '../ai/agentManagerRuntime.js';
import { buildPublicCustomerResponse } from '../ai/agentManagerOutputGuard.js';
import { runWithOpenAIUsageContext } from '../ai/openaiUsageGuard.js';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import type { ChatResponsePayload } from '../shared/types.js';
import {
  ActiveConversationTurnError,
  ClientMessagePayloadConflictError,
  ConversationSessionUnavailableError,
  ConversationRepository
} from '../db/repositories.js';
import { limitPublicHistoryResponse, normalizePublicHistoryMessage, PUBLIC_HISTORY_MAX_RESPONSE_BYTES } from '../shared/publicChatHistory.js';
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
const RESEARCH_WINDOW_MS = 80_000;

function remainingTurnDeadlineMs(deadlineAt: string | null | undefined, graceMs = 0) {
  const parsed = deadlineAt ? Date.parse(deadlineAt) : Number.NaN;
  return Number.isFinite(parsed)
    ? Math.max(1, parsed + graceMs - Date.now())
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
  const session = await conversations.restoreSession(sessionId, visitorCapability);
  if (session) bindDiagnosticIdentity({sessionId});
  return session;
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
    candidate.availabilityRequest = metadata.availabilityRequest;
    candidate.availabilityReceipt = metadata.availabilityReceipt;
    candidate.leadCreated = metadata.leadCreated;
    if (metadata.leadRequested === true) candidate.leadRequested = true;
    const answerContract = metadata.answerContract;
    if (
      !metadata.availabilityRequest && answerContract &&
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
  const activeControllers = new Map<string, Set<AbortController>>();
  const registerController = (turnId: string, controller: AbortController) => {
    const set = activeControllers.get(turnId) ?? new Set<AbortController>();
    set.add(controller);
    activeControllers.set(turnId, set);
    return () => { set.delete(controller); if (!set.size) activeControllers.delete(turnId); };
  };

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
    const query = z.object({ before: z.string().uuid().optional() }).strict().parse(request.query);
    const history = await conversations.getHistorySnapshot(params.id, 81, query.before ?? null);
    if (history.cursorValid === false) return reply.code(400).send({ error: 'invalid_history_cursor' });
    const visible = history.messages.filter((message) => message.role === 'user' || message.role === 'assistant');
    const converted = visible.map(publicHistoryMessage);
    if (converted.some((message, index) => {
      const products = visible[index].metadata?.productCards;
      return !message || (products !== undefined && (!Array.isArray(products) || (message.products?.length ?? 0) !== products.length));
    })) {
      return reply.code(500).send({ error: 'history_message_invalid' });
    }
    const validMessages = converted.filter((message) => message !== null);
    const messages = limitPublicHistoryResponse(validMessages.slice(-80));
    if (validMessages.length && !messages.length) return reply.code(413).send({ error: 'history_message_too_large' });
    for (;;) {
      const nextBefore = messages.length < validMessages.length ? messages[0]?.id : undefined;
      if (messages.length < validMessages.length && !nextBefore) return reply.code(500).send({ error: 'history_cursor_unavailable' });
      const payload = { messages, historyComplete: !nextBefore, ...(nextBefore ? { nextBefore } : {}),
        leadOfferConsumed: history.leadOfferConsumed,
        pendingTurn: history.pendingTurn ? publicPendingTurn(history.pendingTurn) : null };
      if (Buffer.byteLength(JSON.stringify(payload), 'utf8') <= PUBLIC_HISTORY_MAX_RESPONSE_BYTES) return reply.send(payload);
      if (messages.length <= 1) return reply.code(413).send({ error: 'history_message_too_large' });
      messages.shift();
    }
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

  app.post('/api/chat/sessions/:id/diagnostics', async (request,reply) => {
    const params = z.object({id:z.string().uuid()}).parse(request.params);
    const input = z.object({clientMessageId:z.string().uuid().optional(),turnId:z.string().uuid().optional(),requestId:z.string().uuid().optional(),
      recovery:z.boolean(),droppedEvents:z.number().int().min(0).max(100000),events:z.array(z.object({
        type:z.enum(['request_sent','headers_received','turn_identified','status_received','first_answer_received','done_received','stream_closed','stream_error','recovery_started','recovery_completed','recovery_failed','aborted']),
        offsetMs:z.number().min(0).max(3600000),statusCode:z.number().int().min(100).max(599).optional()
      }).strict()).max(32)}).strict().parse(request.body);
    const session = await restoreAuthorizedSession(request,reply,conversations,params.id);
    if (!session) return sessionNotFound(reply);
    // A client claim never binds another session's turn, changes business state,
    // or becomes proof that an answer was delivered/read.
    if (input.turnId && !await conversations.getTurn(params.id,input.turnId)) return reply.code(404).send({error:'Turn not found'});
    bindDiagnosticIdentity({sessionId:params.id,turnId:input.turnId,clientMessageId:input.clientMessageId});
    for (const event of input.events) diagnosticEvent('client.observed',{eventType:event.type,durationMs:event.offsetMs,statusCode:event.statusCode,
      recovery:input.recovery,basis:'untrusted_client_report',clientRequestId:input.requestId});
    diagnosticEvent('client.report.complete',{count:input.events.length,droppedEvents:input.droppedEvents,recovery:input.recovery,basis:'untrusted_client_report'});
    return reply.send({ok:true});
  });

  app.post('/api/chat/sessions/:id/messages/:messageId/delivery', async (request, reply) => {
    const params = z.object({id:z.string().uuid(),messageId:z.string().uuid()}).parse(request.params);
    const input = z.object({firstUsefulContentMs:z.number().int().min(0).max(600_000)}).strict().parse(request.body);
    const session = await restoreAuthorizedSession(request, reply, conversations, params.id);
    if (!session) return sessionNotFound(reply);
    const recorded = await conversations.recordAnswerDelivery({...params,sessionId:params.id,...input});
    return recorded ? reply.send({ok:true}) : reply.code(404).send({error:'Message not found'});
  });

  app.post('/api/chat/sessions/:id/messages/:turnId/cancel', async (request, reply) => {
    const params = z.object({ id: z.string().uuid(), turnId: z.string().uuid() }).parse(request.params);
    const session = await restoreAuthorizedSession(request, reply, conversations, params.id);
    if (!session) return sessionNotFound(reply);
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      // Lock the session so the old turn cannot finish and a new one cannot be
      // started between identifying the remote turn and issuing its cancel.
      const locked = await db.query("SELECT id FROM conversation_sessions WHERE id=$1 AND status='active' FOR UPDATE", [params.id]);
      if (!locked.rowCount) { await db.query('ROLLBACK'); return sessionNotFound(reply); }
      const local = await db.query('SELECT status,error_code FROM conversation_turns WHERE session_id=$1 AND id=$2 FOR UPDATE', [params.id, params.turnId]);
      const turn = local.rows[0];
      if (!turn) { await db.query('ROLLBACK'); return reply.code(404).send({ error: 'Turn not found' }); }
      if (turn.error_code === 'cancelled_by_user') { await db.query('COMMIT'); return reply.send({ status: 'cancelled' }); }
      if (turn.status === 'completed' || turn.status === 'recovered') { await db.query('COMMIT'); return reply.send({ status: 'completed' }); }
      if (turn.status === 'failed') { await db.query('COMMIT'); return reply.send({ status: 'failed' }); }
      const checkpoints = await db.query("SELECT payload FROM turn_checkpoints WHERE session_id=$1 AND turn_id=$2 AND (checkpoint='platform_agent_submission' OR checkpoint LIKE 'controlled_web_search%' OR checkpoint LIKE 'controlled_web_continuation%') ORDER BY updated_at DESC", [params.id, params.turnId]);
      const data = checkpoints.rows[0]?.payload as Record<string, unknown> | undefined;
      const controlledId = typeof data?.responseId === 'string' && data.responseId.startsWith('resp_') ? data.responseId : null;
      const remoteSessionId = controlledId ? `controlled:${controlledId}` : typeof data?.agentSessionId === 'string' ? data.agentSessionId : null;
      if (!data || !remoteSessionId || (!controlledId && !(data.previousTurnId === null || typeof data.previousTurnId === 'string')) ||
          !config.OPENAI_API_KEY || !config.OPENAI_PLATFORM_AGENT_ID) {
        await db.query('ROLLBACK');
        return reply.code(409).send({ error: 'turn_identity_not_ready' });
      }
      const client = new PlatformAgentClient(config.OPENAI_API_KEY, config.OPENAI_PLATFORM_AGENT_ID,
        config.OPENAI_PLATFORM_AGENT_VAULT_ID ? [config.OPENAI_PLATFORM_AGENT_VAULT_ID] : []);
      const remote = await client.latestTurn(remoteSessionId);
      if (!remote || (!controlledId && remote.id === data.previousTurnId)) {
        await db.query('ROLLBACK');
        return reply.code(409).send({ error: 'turn_identity_not_ready' });
      }
      if (!['completed', 'failed', 'cancelled', 'incomplete'].includes(remote.status)) await client.cancelTurn(remoteSessionId);
      await db.query("UPDATE conversation_turns SET status='failed',stage='cancelled_by_user',error_code='cancelled_by_user',error_message=NULL,execution_owner=NULL,execution_lease_expires_at=NULL,updated_at=now() WHERE session_id=$1 AND id=$2", [params.id, params.turnId]);
      await db.query('COMMIT');
      bindDiagnosticIdentity({sessionId:params.id,turnId:params.turnId});
      diagnosticEvent('turn.cancel.accepted',{abortSource:'client_cancel'});
      for (const controller of activeControllers.get(params.turnId) ?? []) controller.abort('platform_agent_explicit_cancel');
      return reply.send({ status: 'cancelled' });
    } catch (error) {
      await db.query('ROLLBACK').catch(() => undefined);
      app.log.warn({ ...safeErrorFields(error) }, 'chat cancellation failed');
      return reply.code(503).send({ error: 'cancellation_unavailable' });
    } finally { db.release(); }
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
        deadlineAt: config.OPENAI_PLATFORM_AGENT_ID ? null : new Date(Date.now() + TURN_DEADLINE_MS).toISOString()
      });
    } catch (error) {
      diagnosticError('turn.acceptance.failed',error);
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
    bindDiagnosticIdentity({sessionId:params.id,turnId,clientMessageId});
    diagnosticEvent('turn.accepted',{deduplicated:turnId !== requestedTurnId});
    const controller = new AbortController();
    const unregisterController = registerController(turnId, controller);
    const resumable = Boolean(config.OPENAI_PLATFORM_AGENT_ID) && !turn.deadlineAt;
    const timeout = setTimeout(() => { diagnosticEvent('turn.abort.requested',{abortSource:resumable ? 'research_window' : 'server_deadline'}); controller.abort(resumable ? 'research_window_elapsed' : 'turn_deadline_exceeded'); }, resumable ? RESEARCH_WINDOW_MS : remainingTurnDeadlineMs(turn.deadlineAt));
    timeout.unref?.();

    const send = openSseReply(reply, {
      'x-request-id': request.id,
      'access-control-expose-headers':'x-request-id, x-chat-turn-id',
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
      // The orchestrator owns stage retries and durable recovery. The route
      // cannot infer whether an external action committed before an exception.
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
           onStage: sendStageStatus,
           signal: controller.signal
        }));
      diagnosticEvent('answer.ready',{sessionId:params.id,turnId,messageId:payload.assistantMessageId});
      send('done', buildPublicCustomerResponse(payload));
    } catch (error) {
      diagnosticError('turn.route.failed',error,{abortSource:diagnosticAbortSource(controller.signal),aborted:controller.signal.aborted});
      const executionInProgress = error instanceof TurnExecutionInProgressError;
      const budgetStopped = error instanceof AgentManagerTurnBudgetExceededError;
      const explicitlyCancelled = controller.signal.reason === 'platform_agent_explicit_cancel' ||
        (typeof conversations.getTurn === 'function' && (await conversations.getTurn(params.id, turnId).catch(() => null))?.errorCode === 'cancelled_by_user');
      const checkpoints = !executionInProgress && !explicitlyCancelled && Boolean(config.OPENAI_PLATFORM_AGENT_ID) &&
        typeof conversations.listTurnCheckpoints === 'function'
        ? await conversations.listTurnCheckpoints(params.id, turnId).catch(() => []) : [];
      const submissionRejected = error instanceof ControlledRequestRejected || checkpoints.some(row =>
        row.checkpoint === 'platform_agent_submission' && row.payload?.rejected === true);
      const answerRejected = error instanceof AgentAnswerRejectedError;
      const checkpointAvailable = !submissionRejected && !answerRejected && checkpoints.some((row) => row.checkpoint === 'platform_agent_submission');
      if (!explicitlyCancelled && checkpointAvailable && controller.signal.reason === 'research_window_elapsed') {
        send('pending', { turnId });
        return;
      }
      if (!executionInProgress && !checkpointAvailable && !explicitlyCancelled) {
        await conversations.updateTurn({
          sessionId: params.id,
          turnId,
          status: 'failed',
          stage: controller.signal.aborted ? 'timeout_or_aborted' : 'failed',
          errorCode: submissionRejected ? 'controlled_submission_rejected' : answerRejected ? 'agent_answer_rejected' : controller.signal.aborted
            ? `${runtimeDecision.runtimeMode}_generation_aborted_or_timeout`
            : `${runtimeDecision.runtimeMode}_generation_failed`,
          errorMessage: safeErrorMessage(error),
          requireUnowned: true
        }).catch((updateError) => app.log.warn({ sessionId: params.id, turnId, ...safeErrorFields(updateError) }, 'turn failure update failed'));
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
          ...safeErrorFields(error)
        }, 'chat generation failed');
      }
      if (explicitlyCancelled) send('cancelled', { turnId });
      else send('error', {
        error: message,
        turnId,
        recoverable: checkpointAvailable
      });
    } finally {
      clearTimeout(timeout);
      unregisterController();
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
    bindDiagnosticIdentity({sessionId:params.id,turnId:params.turnId});
    diagnosticEvent('turn.recovery.started',{recovery:true});
    const controller = new AbortController();
    const unregisterController = registerController(params.turnId, controller);
    // A recovery already past the deadline may reconcile the known remote turn
    // during grace; one started earlier must still stop remote work at deadline.
    const recoveryGraceMs = config.OPENAI_PLATFORM_AGENT_ID && persistedTurn.deadlineAt &&
      Date.parse(persistedTurn.deadlineAt) <= Date.now() ? 30_000 : 0;
    const resumable = Boolean(config.OPENAI_PLATFORM_AGENT_ID) && !persistedTurn.deadlineAt;
    const timeout = setTimeout(() => { diagnosticEvent('turn.abort.requested',{abortSource:resumable ? 'research_window' : recoveryGraceMs ? 'recovery_grace' : 'server_deadline'}); controller.abort(resumable ? 'research_window_elapsed' : recoveryGraceMs ? 'recovery_grace_exceeded' : 'turn_deadline_exceeded'); }, resumable ? RESEARCH_WINDOW_MS : remainingTurnDeadlineMs(persistedTurn.deadlineAt, recoveryGraceMs));
    timeout.unref?.();

    const send = openSseReply(reply, {
      'x-request-id': request.id,
      'access-control-expose-headers':'x-request-id, x-chat-turn-id',
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
      diagnosticEvent('answer.ready',{sessionId:params.id,turnId:params.turnId,messageId:payload.assistantMessageId,recovery:true});
      send('done', buildPublicCustomerResponse(payload));
    } catch (error) {
      diagnosticError('turn.route.failed',error,{abortSource:diagnosticAbortSource(controller.signal),aborted:controller.signal.aborted});
      const executionInProgress = error instanceof TurnExecutionInProgressError;
      const explicitlyCancelled = controller.signal.reason === 'platform_agent_explicit_cancel' ||
        (typeof conversations.getTurn === 'function' && (await conversations.getTurn(params.id, params.turnId).catch(() => null))?.errorCode === 'cancelled_by_user');
      const recoveryCheckpoints = !executionInProgress && !explicitlyCancelled && Boolean(config.OPENAI_PLATFORM_AGENT_ID) &&
        typeof conversations.listTurnCheckpoints === 'function' && (resumable || remainingTurnDeadlineMs(persistedTurn.deadlineAt, 30_000) > 1)
        ? await conversations.listTurnCheckpoints(params.id, params.turnId).catch(() => []) : [];
      const submissionRejected = error instanceof ControlledRequestRejected || recoveryCheckpoints.some(row =>
        row.checkpoint === 'platform_agent_submission' && row.payload?.rejected === true);
      const answerRejected = error instanceof AgentAnswerRejectedError;
      const checkpointAvailable = !submissionRejected && !answerRejected && recoveryCheckpoints.some((row) => row.checkpoint === 'platform_agent_submission');
      if (!explicitlyCancelled && checkpointAvailable && controller.signal.reason === 'research_window_elapsed') {
        send('pending', { turnId: params.turnId });
        return;
      }
      if (!executionInProgress && !explicitlyCancelled && !checkpointAvailable) {
        await conversations.updateTurn({
          sessionId: params.id,
          turnId: params.turnId,
          status: 'failed',
          stage: 'recovery_failed',
          errorCode: submissionRejected ? 'controlled_submission_rejected' : answerRejected ? 'agent_answer_rejected' : controller.signal.aborted
            ? `${runtimeDecision.runtimeMode}_recovery_aborted_or_timeout`
            : `${runtimeDecision.runtimeMode}_recovery_failed`,
          errorMessage: safeErrorMessage(error),
          requireUnowned: true
        }).catch((updateError) => app.log.warn({ sessionId: params.id, turnId: params.turnId, ...safeErrorFields(updateError) }, 'turn recovery failure update failed'));
      }
      app.log.warn({
        sessionId: params.id,
        turnId: params.turnId,
        runtimeMode: runtimeDecision.runtimeMode,
        runtimeModeReason: runtimeDecision.reason,
        ...safeErrorFields(error)
      }, 'chat recovery failed');
      if (explicitlyCancelled) send('cancelled', { turnId: params.turnId });
      else send('error', {
        turnId: params.turnId,
        recoverable: checkpointAvailable,
        error: executionInProgress
          ? 'Этот ответ уже формируется в другом запросе. Дождитесь завершения — повторно выполнять ход не нужно.'
          : 'Не удалось завершить ответ. Ваш вопрос сохранён в истории чата.'
      });
    } finally {
      clearTimeout(timeout);
      unregisterController();
      closeSseReply(reply);
    }
  });
}
