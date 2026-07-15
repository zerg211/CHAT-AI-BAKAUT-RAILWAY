import { describe, expect, it, vi } from 'vitest';
import { ConversationRepository, LeadRepository, ProductRepository } from '../src/db/repositories.js';

function sessionRow() {
  const now = new Date('2026-04-27T08:00:00.000Z');
  return {
    id: 'session-to-delete',
    status: 'closed',
    conversation_number: 12,
    topic: 'Тестовый диалог',
    title: 'Диалог #12: Тестовый диалог',
    visitor_id: null,
    page_url: null,
    user_agent: null,
    need_state: {},
    created_at: now,
    updated_at: now,
    last_heartbeat_at: now,
    closed_at: now
  };
}

describe('ConversationRepository.deleteSession', () => {
  it('deletes a conversation session and returns the deleted session', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [sessionRow()] });
    const repository = new ConversationRepository({ query } as never);

    const deleted = await repository.deleteSession('session-to-delete');

    expect(query).toHaveBeenCalledWith('DELETE FROM conversation_sessions WHERE id = $1 RETURNING *', ['session-to-delete']);
    expect(deleted).toMatchObject({
      id: 'session-to-delete',
      title: 'Диалог #12: Тестовый диалог',
      conversationNumber: 12
    });
  });

  it('returns null when the session does not exist', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const repository = new ConversationRepository({ query } as never);

    await expect(repository.deleteSession('missing-session')).resolves.toBeNull();
  });
});

describe('ConversationRepository.updateAssistantFeedback', () => {
  it('stores feedback in assistant message metadata', async () => {
    const now = new Date('2026-04-27T08:00:00.000Z');
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{
        id: 'message-id',
        session_id: 'session-id',
        role: 'assistant',
        content: 'answer',
        metadata: { feedback: { rating: 'negative' } },
        created_at: now
      }]
    });
    const repository = new ConversationRepository({ query } as never);

    const message = await repository.updateAssistantFeedback({
      sessionId: 'session-id',
      messageId: 'message-id',
      rating: 'negative'
    });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('jsonb_set'), [
      'message-id',
      'session-id',
      expect.any(String),
      'negative'
    ]);
    expect(query.mock.calls[0][0]).toContain('INSERT INTO assistant_feedback_events');
    expect(JSON.parse(query.mock.calls[0][1][2])).toMatchObject({ rating: 'negative' });
    expect(message).toMatchObject({
      id: 'message-id',
      sessionId: 'session-id',
      metadata: { feedback: { rating: 'negative' } }
    });
  });
});

describe('ConversationRepository.deleteOldEmptyWidgetSessions', () => {
  it('deletes only old widget sessions without messages', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 7, rows: [] });
    const repository = new ConversationRepository({ query } as never);

    await expect(repository.deleteOldEmptyWidgetSessions()).resolves.toBe(7);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM conversation_sessions'), [24]);
    expect(query.mock.calls[0][0]).toContain('s.page_url IS NOT NULL');
    expect(query.mock.calls[0][0]).toContain("s.created_at < now() - ($1 || ' hours')::interval");
    expect(query.mock.calls[0][0]).toContain('NOT EXISTS');
    expect(query.mock.calls[0][0]).toContain('FROM messages m WHERE m.session_id = s.id');
  });

  it('accepts a custom retention window in hours', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const repository = new ConversationRepository({ query } as never);

    await repository.deleteOldEmptyWidgetSessions(48);

    expect(query).toHaveBeenCalledWith(expect.any(String), [48]);
  });
});

describe('ConversationRepository.deleteEmptyNonWidgetSessions', () => {
  it('deletes empty sessions without a widget page url immediately', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 3, rows: [] });
    const repository = new ConversationRepository({ query } as never);

    await expect(repository.deleteEmptyNonWidgetSessions()).resolves.toBe(3);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM conversation_sessions'));
    expect(query.mock.calls[0][0]).toContain('s.page_url IS NULL');
    expect(query.mock.calls[0][0]).toContain('NOT EXISTS');
    expect(query.mock.calls[0][0]).toContain('FROM messages m WHERE m.session_id = s.id');
    expect(query.mock.calls[0][0]).not.toContain("created_at < now()");
  });
});

describe('ConversationRepository turn JSON storage', () => {
  it('serializes top-level arrays and objects before passing jsonb params to pg', async () => {
    const now = new Date('2026-04-27T08:00:00.000Z');
    const turnRow = {
      id: 'turn-id',
      session_id: 'session-id',
      user_message_id: null,
      assistant_message_id: null,
      status: 'planned',
      client_message_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      request_hash: 'hash',
      stage: 'planned',
      error_code: null,
      error_message: null,
      planner_contract: { taskType: 'product_selection_with_availability' },
      active_needs_before: [{ summary: 'before' }],
      active_needs_after: [{ summary: 'after' }],
      created_at: now,
      updated_at: now
    };
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [turnRow] });
    const repository = new ConversationRepository({ query } as never);

    await repository.createTurn({
      sessionId: 'session-id',
      clientMessageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      requestHash: 'hash',
      status: 'received',
      activeNeedsBefore: [{ summary: 'before' }]
    });
    await repository.updateTurn({
      sessionId: 'session-id',
      turnId: 'turn-id',
      status: 'planned',
      plannerContract: { taskType: 'product_selection_with_availability' },
      activeNeedsAfter: [{ summary: 'after' }]
    });

    expect(query.mock.calls[0][1][6]).toBe(JSON.stringify([{ summary: 'before' }]));
    expect(query.mock.calls[1][1][8]).toBe(JSON.stringify({ taskType: 'product_selection_with_availability' }));
    expect(query.mock.calls[1][1][10]).toBe(JSON.stringify([{ summary: 'after' }]));
  });
});

describe('LeadRepository.markEmailResult', () => {
  it('never downgrades an already sent lead when a replay reports a later failure', async () => {
    const now = new Date('2026-04-27T08:00:00.000Z');
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{
        id: 'lead-id',
        session_id: 'session-id',
        name: 'Buyer',
        phone: '+79990000000',
        email: null,
        question: 'Question',
        status: 'sent_email',
        email_provider_response: { ok: true },
        sent_at: now,
        created_at: now
      }]
    });
    const repository = new LeadRepository({ query } as never);

    await repository.markEmailResult('lead-id', 'email_failed', { ok: false });

    expect(query.mock.calls[0][0]).toContain("status = 'sent_email' AND $2 = 'email_failed'");
    expect(query.mock.calls[0][0]).toContain('THEN email_provider_response');
    expect(query.mock.calls[0][1]).toEqual(['lead-id', 'email_failed', { ok: false }]);
  });
});

describe('ConversationRepository turn idempotency', () => {
  const now = new Date('2026-07-10T12:00:00.000Z');

  function turnRow(id: string, clientMessageId: string) {
    return {
      id,
      session_id: 'session-id',
      client_message_id: clientMessageId,
      user_message_id: null,
      assistant_message_id: null,
      status: 'received',
      request_hash: 'same-text-hash',
      stage: 'received',
      error_code: null,
      error_message: null,
      planner_contract: null,
      active_needs_before: null,
      active_needs_after: null,
      execution_owner: null,
      execution_lease_expires_at: null,
      created_at: now,
      updated_at: now
    };
  }

  it('creates distinct turns for distinct client actions with identical text hashes', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [turnRow('turn-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [turnRow('turn-2', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')] });
    const repository = new ConversationRepository({ query } as never);

    const first = await repository.createTurn({
      sessionId: 'session-id',
      clientMessageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      requestHash: 'same-text-hash'
    });
    const second = await repository.createTurn({
      sessionId: 'session-id',
      clientMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      requestHash: 'same-text-hash'
    });

    expect(first.id).toBe('turn-1');
    expect(second.id).toBe('turn-2');
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain('ON CONFLICT (session_id, client_message_id)');
    expect(query.mock.calls[0]?.[0]).not.toContain('WHERE session_id = $1\n         AND request_hash');
  });

  it('returns the same turn when the same client operation is retried', async () => {
    const row = turnRow('turn-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [row] });
    const repository = new ConversationRepository({ query } as never);
    const operation = {
      sessionId: 'session-id',
      clientMessageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      requestHash: 'same-text-hash'
    };

    const first = await repository.createTurn(operation);
    const retry = await repository.createTurn(operation);

    expect(first.id).toBe('turn-1');
    expect(retry.id).toBe('turn-1');
    expect(query.mock.calls[0]?.[0]).toContain('WHERE conversation_turns.request_hash = EXCLUDED.request_hash');
  });

  it('reports the existing active turn when a different client action collides', async () => {
    const query = vi.fn()
      .mockRejectedValueOnce({
        code: '23505',
        constraint: 'conversation_turns_one_active_per_session_idx'
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'active-turn' }] });
    const repository = new ConversationRepository({ query } as never);

    await expect(repository.createTurn({
      sessionId: 'session-id',
      clientMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      requestHash: 'different-message'
    })).rejects.toMatchObject({
      code: 'active_conversation_turn_exists',
      activeTurnId: 'active-turn'
    });
  });

  it('maps execution lease state used to prevent concurrent turn runners', async () => {
    const leaseAt = new Date('2026-07-10T12:01:00.000Z');
    const row = {
      ...turnRow('turn-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      execution_owner: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      execution_lease_expires_at: leaseAt
    };
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [row] });
    const repository = new ConversationRepository({ query } as never);

    const claimed = await repository.claimTurnExecution({
      sessionId: 'session-id',
      turnId: 'turn-1',
      ownerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      leaseMs: 30_000
    });

    expect(claimed).toMatchObject({
      executionOwner: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      executionLeaseExpiresAt: leaseAt.toISOString()
    });
    expect(query.mock.calls[0]?.[0]).toContain('execution_lease_expires_at < now()');
  });

  it('claims at most one recovery attempt atomically before the database deadline', async () => {
    const deadlineAt = new Date('2026-07-10T12:01:00.000Z');
    const row = {
      ...turnRow('turn-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      deadline_at: deadlineAt,
      recovery_attempts: 1
    };
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [row] });
    const repository = new ConversationRepository({ query } as never);

    const claimed = await repository.beginRecoveryAttempt({
      sessionId: 'session-id',
      turnId: 'turn-1',
      maxAttempts: 1
    });

    expect(claimed).toMatchObject({ recoveryAttempts: 1, deadlineAt: deadlineAt.toISOString() });
    expect(query.mock.calls[0]?.[0]).toContain('recovery_attempts = coalesce(recovery_attempts, 0) + 1');
    expect(query.mock.calls[0]?.[0]).toContain('coalesce(recovery_attempts, 0) < $3');
    expect(query.mock.calls[0]?.[0]).toContain('deadline_at > now()');
    expect(query.mock.calls[0]?.[1]).toEqual(['session-id', 'turn-1', 1]);
  });

  it('saves the user message and links it to the turn atomically', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          id: 'message-id',
          session_id: 'session-id',
          role: 'user',
          content: 'да',
          metadata: {},
          created_at: now
        }]
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const repository = new ConversationRepository({ query } as never);

    const message = await repository.addUserMessageForTurn({
      sessionId: 'session-id',
      turnId: 'turn-id',
      content: 'да',
      activeNeedsBefore: []
    });

    expect(message.id).toBe('message-id');
    expect(query.mock.calls[0]?.[0]).toContain('FOR UPDATE');
    expect(query.mock.calls[0]?.[0]).toContain("SELECT locked_turn.session_id, 'user'");
    expect(query.mock.calls[0]?.[0]).toContain('WHERE NOT EXISTS (SELECT 1 FROM existing_message)');
    expect(query.mock.calls[0]?.[0]).toContain('SET user_message_id = (SELECT id FROM chosen_message)');
  });

  it('inserts an assistant message only from the locked existing turn', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          id: 'assistant-message-id',
          session_id: 'session-id',
          role: 'assistant',
          content: 'ответ',
          metadata: {},
          created_at: now
        }]
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const repository = new ConversationRepository({ query } as never);

    await repository.addAssistantMessageForTurn({
      sessionId: 'session-id',
      turnId: 'turn-id',
      content: 'ответ'
    });

    expect(query.mock.calls[0]?.[0]).toContain('FOR UPDATE');
    expect(query.mock.calls[0]?.[0]).toContain("SELECT locked_turn.session_id, 'assistant'");
    expect(query.mock.calls[0]?.[0]).toContain('SET assistant_message_id = (SELECT id FROM chosen_message)');
  });
});

describe('ConversationRepository dialogue ledger compaction', () => {
  it('keeps the newest bounded event window and returns it in chronological order', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const repository = new ConversationRepository({ query } as never);

    await repository.listDialogueLedgerEvents('session-id', 500);

    expect(query.mock.calls[0]?.[0]).toContain('ORDER BY event_seq DESC');
    expect(query.mock.calls[0]?.[0]).toContain('ORDER BY event_seq ASC');
    expect(query.mock.calls[0]?.[0]).not.toContain('ORDER BY created_at ASC\n       LIMIT');
  });

  it('persists a monotonic snapshot cursor with reduced state and recent evidence', async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ session_id: 'session-id', through_event_seq: '81' }]
    });
    const repository = new ConversationRepository({ query } as never);

    await repository.saveDialogueLedgerSnapshot({
      sessionId: 'session-id',
      throughEventSeq: 81,
      eventCount: 81,
      state: { eventIds: ['event-81'] },
      recentEvents: [{ eventId: 'event-81' }]
    });

    expect(query.mock.calls[0]?.[0]).toContain('ON CONFLICT (session_id) DO UPDATE');
    expect(query.mock.calls[0]?.[0]).toContain('dialogue_ledger_snapshots.through_event_seq <= EXCLUDED.through_event_seq');
    expect(query.mock.calls[0]?.[1]?.[3]).toBe(JSON.stringify({ eventIds: ['event-81'] }));
  });
});

describe('LeadRepository partial contact drafts', () => {
  const now = new Date('2026-07-15T12:00:00.000Z');
  const expires = new Date('2026-07-15T12:30:00.000Z');
  const draftRow = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    session_id: '11111111-1111-4111-8111-111111111111',
    origin_turn_id: '22222222-2222-4222-8222-222222222222',
    origin_tool_request_id: 'lead.capture:partial',
    purpose: 'verify generator start method',
    buyer_question: 'Проверьте, есть ли электростартер',
    preferred_contact: 'message',
    name: null,
    phone: '+7 900 000-00-11',
    email: null,
    consent_evidence_hash: 'a'.repeat(64),
    scope_hash: 'b'.repeat(64),
    status: 'pending',
    expires_at: expires,
    consumed_by_turn_id: null,
    consumed_lead_id: null,
    created_at: now,
    updated_at: now
  };

  it('persists the partial contact and cancels other pending scopes without exposing it to dialogue state', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [draftRow] });
    const repository = new LeadRepository({ query } as never);

    const draft = await repository.upsertLeadCaptureDraft({
      sessionId: draftRow.session_id,
      originTurnId: draftRow.origin_turn_id,
      originToolRequestId: draftRow.origin_tool_request_id,
      purpose: draftRow.purpose,
      buyerQuestion: draftRow.buyer_question,
      preferredContact: 'message',
      phone: draftRow.phone,
      consentEvidenceHash: draftRow.consent_evidence_hash,
      scopeHash: draftRow.scope_hash
    });

    expect(query.mock.calls[0]?.[0]).toContain('INSERT INTO lead_capture_drafts');
    expect(query.mock.calls[0]?.[0]).toContain('ON CONFLICT (session_id, origin_turn_id, origin_tool_request_id)');
    expect(query.mock.calls[0]?.[0]).toContain("status = CASE WHEN draft.expires_at <= now() THEN 'expired' ELSE 'cancelled' END");
    expect(query.mock.calls[0]?.[0]).toContain('phone = NULL');
    expect(query.mock.calls[0]?.[1]).toContain(draftRow.buyer_question);
    expect(draft).toMatchObject({
      id: draftRow.id,
      buyerQuestion: draftRow.buyer_question,
      preferredContact: 'message',
      phone: draftRow.phone,
      status: 'pending'
    });
  });

  it('loads only an unexpired pending draft from the active session and anonymizes expired rows', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [draftRow] });
    const repository = new LeadRepository({ query } as never);

    const draft = await repository.getPendingLeadCaptureDraft(draftRow.session_id);

    expect(query.mock.calls[0]?.[0]).toContain("SET status = 'expired'");
    expect(query.mock.calls[0]?.[0]).toContain("session.status = 'active'");
    expect(query.mock.calls[0]?.[0]).toContain('draft.expires_at > now()');
    expect(draft?.id).toBe(draftRow.id);
  });

  it('atomically creates the lead and outbox from the original question before consuming the draft', async () => {
    const leadRow = {
      id: 'lead-id',
      session_id: draftRow.session_id,
      origin_turn_id: draftRow.origin_turn_id,
      origin_tool_request_id: draftRow.origin_tool_request_id,
      name: 'Алексей',
      phone: draftRow.phone,
      email: null,
      question: draftRow.buyer_question,
      status: 'pending_email',
      created_at: now
    };
    const outboxRow = {
      id: 'outbox-id',
      lead_id: 'lead-id',
      session_id: draftRow.session_id,
      turn_id: '33333333-3333-4333-8333-333333333333',
      destination: 'lead_email',
      payload: {
        leadId: 'lead-id',
        purpose: draftRow.purpose,
        question: draftRow.buyer_question,
        preferredContact: 'message'
      },
      status: 'pending',
      attempt_count: 0,
      next_attempt_at: null,
      last_error: null,
      created_at: now,
      updated_at: now
    };
    const consumedDraftRow = {
      ...draftRow,
      status: 'consumed',
      name: null,
      phone: null,
      consumed_by_turn_id: outboxRow.turn_id,
      consumed_lead_id: leadRow.id
    };
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ draft_row: consumedDraftRow, lead_row: leadRow, outbox_row: outboxRow }]
    });
    const repository = new LeadRepository({ query } as never);

    const completed = await repository.completeLeadCaptureDraft({
      draftId: draftRow.id,
      sessionId: draftRow.session_id,
      turnId: outboxRow.turn_id,
      name: 'Алексей',
      preferredContact: 'message'
    });

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('WITH target_draft AS MATERIALIZED');
    expect(sql).toContain('contact.buyer_question');
    expect(sql).toContain('INSERT INTO lead_outbox');
    expect(sql).toContain("outbox.status IN ('pending', 'sending', 'sent', 'failed')");
    expect(sql).toContain("SET status = 'consumed'");
    expect(sql).toContain('existing_completion');
    expect(completed).toMatchObject({
      draft: { status: 'consumed', consumedLeadId: 'lead-id' },
      lead: { id: 'lead-id', question: draftRow.buyer_question },
      outbox: { id: 'outbox-id', status: 'pending' }
    });
  });

  it('atomically completes a public form lead with the pending draft context in its outbox', async () => {
    const leadRow = {
      id: 'public-lead-id',
      session_id: draftRow.session_id,
      client_lead_id: '44444444-4444-4444-8444-444444444444',
      client_request_hash: 'request-hash',
      origin_turn_id: null,
      origin_tool_request_id: null,
      name: 'Алексей',
      phone: draftRow.phone,
      email: null,
      question: 'Контакт из формы',
      status: 'pending_email',
      created_at: now
    };
    const outboxRow = {
      id: 'public-outbox-id',
      lead_id: leadRow.id,
      session_id: draftRow.session_id,
      turn_id: '33333333-3333-4333-8333-333333333333',
      destination: 'lead_email',
      payload: {
        leadId: leadRow.id,
        purpose: draftRow.purpose,
        question: draftRow.buyer_question,
        preferredContact: draftRow.preferred_contact,
        source: 'lead_form'
      },
      status: 'pending',
      attempt_count: 0,
      next_attempt_at: null,
      last_error: null,
      created_at: now,
      updated_at: now
    };
    const consumedDraftRow = {
      ...draftRow,
      status: 'consumed',
      name: null,
      phone: null,
      email: null,
      consumed_by_turn_id: outboxRow.turn_id,
      consumed_lead_id: leadRow.id
    };
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{
        lead_row: leadRow,
        outbox_row: outboxRow,
        draft_row: consumedDraftRow,
        pending_draft_matched: true
      }]
    });
    const repository = new LeadRepository({ query } as never);

    const completed = await repository.createClientLeadWithOutbox({
      sessionId: draftRow.session_id,
      clientLeadId: leadRow.client_lead_id,
      clientRequestHash: leadRow.client_request_hash,
      name: leadRow.name,
      phone: leadRow.phone,
      question: leadRow.question
    });

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('WITH active_session AS MATERIALIZED');
    expect(sql).toContain('ON CONFLICT (session_id, client_lead_id) WHERE client_lead_id IS NOT NULL');
    expect(sql).toContain('leads.client_request_hash = EXCLUDED.client_request_hash');
    expect(sql).toContain('FOR UPDATE OF draft');
    expect(sql).toContain('ORDER BY turn.created_at DESC');
    expect(sql).toContain("'purpose', draft.purpose");
    expect(sql).toContain("'question', draft.buyer_question");
    expect(sql).toContain("'preferredContact', draft.preferred_contact");
    expect(sql).toContain('payload = lead_outbox.payload || EXCLUDED.payload');
    expect(sql).toContain("SET status = 'consumed'");
    expect(sql).toContain('phone = NULL');
    expect(sql).toContain("outbox.status IN ('pending', 'sending', 'sent', 'failed')");
    expect(completed).toMatchObject({
      pendingDraftMatched: true,
      draft: {
        status: 'consumed',
        phone: null,
        consumedLeadId: leadRow.id
      },
      lead: { id: leadRow.id, clientLeadId: leadRow.client_lead_id },
      outbox: {
        id: outboxRow.id,
        payload: {
          purpose: draftRow.purpose,
          question: draftRow.buyer_question,
          preferredContact: 'message'
        }
      }
    });
  });

  it('keeps the public form payload compatible when there is no pending draft', async () => {
    const leadRow = {
      id: 'public-lead-id',
      session_id: draftRow.session_id,
      client_lead_id: '44444444-4444-4444-8444-444444444444',
      client_request_hash: 'request-hash',
      name: 'Алексей',
      phone: draftRow.phone,
      email: null,
      question: 'Нужна доставка',
      status: 'pending_email',
      created_at: now
    };
    const outboxRow = {
      id: 'public-outbox-id',
      lead_id: leadRow.id,
      session_id: draftRow.session_id,
      turn_id: null,
      destination: 'lead_email',
      payload: { leadId: leadRow.id, source: 'lead_form' },
      status: 'pending',
      attempt_count: 0,
      next_attempt_at: null,
      last_error: null,
      created_at: now,
      updated_at: now
    };
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{
        lead_row: leadRow,
        outbox_row: outboxRow,
        draft_row: null,
        pending_draft_matched: false
      }]
    });
    const repository = new LeadRepository({ query } as never);

    const completed = await repository.createClientLeadWithOutbox({
      sessionId: leadRow.session_id,
      clientLeadId: leadRow.client_lead_id,
      clientRequestHash: leadRow.client_request_hash,
      name: leadRow.name,
      phone: leadRow.phone,
      question: leadRow.question
    });

    expect(completed).toMatchObject({
      pendingDraftMatched: false,
      draft: null,
      lead: { id: leadRow.id },
      outbox: { payload: { leadId: leadRow.id, source: 'lead_form' } }
    });
  });

  it('returns null when the public form idempotency key is reused with another payload hash', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const repository = new LeadRepository({ query } as never);

    await expect(repository.createClientLeadWithOutbox({
      sessionId: draftRow.session_id,
      clientLeadId: '44444444-4444-4444-8444-444444444444',
      clientRequestHash: 'different-request-hash',
      name: 'Алексей',
      phone: '+79000000000'
    })).resolves.toBeNull();
  });
});

describe('LeadRepository turn idempotency', () => {
  it('uses the originating turn and tool request as the business idempotency key', async () => {
    const now = new Date('2026-07-10T12:00:00.000Z');
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{
        id: 'lead-id',
        session_id: 'session-id',
        origin_turn_id: 'turn-id',
        origin_tool_request_id: 'lead-request',
        name: 'Алексей',
        phone: '+79000000000',
        email: null,
        question: 'Нужна доставка',
        status: 'pending_email',
        created_at: now
      }]
    });
    const { LeadRepository } = await import('../src/db/repositories.js');
    const repository = new LeadRepository({ query } as never);

    await repository.createLead({
      sessionId: 'session-id',
      originTurnId: 'turn-id',
      originToolRequestId: 'lead-request',
      name: 'Алексей',
      phone: '+79000000000',
      question: 'Нужна доставка'
    });

    expect(query.mock.calls[0]?.[0]).toContain('ON CONFLICT (session_id, origin_turn_id, origin_tool_request_id)');
    expect(query.mock.calls[0]?.[1]).toContain('lead-request');
  });

  it('does not reset an existing outbox delivery state when recovery enqueues the same lead again', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: 'outbox-id' }] });
    const { ConversationRepository } = await import('../src/db/repositories.js');
    const repository = new ConversationRepository({ query } as never);

    await repository.enqueueLeadOutbox({
      leadId: 'lead-id',
      sessionId: 'session-id',
      turnId: null,
      destination: 'lead_email',
      payload: { leadId: 'lead-id' }
    });

    expect(query.mock.calls[0]?.[0]).toContain('status = lead_outbox.status');
    expect(query.mock.calls[0]?.[0]).toContain('next_attempt_at = lead_outbox.next_attempt_at');
    expect(query.mock.calls[0]?.[0]).not.toContain("WHEN lead_outbox.status = 'sent'");
    expect(query.mock.calls[0]?.[1]?.[2]).toBeNull();
  });

  it('reclaims stale sending rows and reports them as degraded outbox health', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          pending: 0,
          sending: 1,
          failed: 0,
          dead: 0,
          stale_sending: 1,
          oldest_backlog_at: null,
          last_sent_at: null
        }]
      });
    const { LeadRepository } = await import('../src/db/repositories.js');
    const repository = new LeadRepository({ query } as never);

    await repository.claimDueLeadOutbox();
    const health = await repository.getLeadOutboxHealth();

    expect(query.mock.calls[0]?.[0]).toContain("status = 'sending'");
    expect(query.mock.calls[0]?.[0]).toContain("interval '15 minutes'");
    expect(health).toMatchObject({ status: 'degraded', sending: 1, staleSending: 1 });
  });
});

function troubleshootingRow() {
  const now = new Date('2026-04-27T08:00:00.000Z');
  return {
    id: 'case-id',
    model: 'АД 30С-Т400-1РКМ1',
    model_key: 'ад30ст4001ркм1',
    fault_codes: ['A25'],
    problem_summary: 'Не глушится, ошибка A25',
    problem_key: 'a25__не_глушится',
    answer: 'Проверить цепь STOP.',
    source_urls: ['https://example.com/manual.pdf'],
    source_titles: ['Manual'],
    confidence: '0.86',
    first_seen_message: 'message',
    hit_count: 2,
    semantic_score: 0.9,
    created_at: now,
    updated_at: now
  };
}

describe('ProductRepository troubleshooting memory', () => {
  it('upserts a verified troubleshooting case', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [troubleshootingRow()] });
    const repository = new ProductRepository({ query } as never);

    const item = await repository.upsertTroubleshootingCase({
      model: 'АД 30С-Т400-1РКМ1',
      modelKey: 'ад30ст4001ркм1',
      faultCodes: ['A25'],
      problemSummary: 'Не глушится, ошибка A25',
      problemKey: 'a25__не_глушится',
      answer: 'Проверить цепь STOP.',
      sourceUrls: ['https://example.com/manual.pdf'],
      sourceTitles: ['Manual'],
      confidence: 0.86,
      firstSeenMessage: 'message'
    }, [0.1, 0.2]);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO troubleshooting_cases'), expect.any(Array));
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT (model_key, problem_key) DO UPDATE');
    expect(item).toMatchObject({
      id: 'case-id',
      faultCodes: ['A25'],
      semanticScore: 0.9
    });
  });

  it('searches troubleshooting cases by model, fault code, text, and embedding', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [troubleshootingRow()] });
    const repository = new ProductRepository({ query } as never);

    const results = await repository.searchTroubleshootingCases({
      query: 'ошибка A25 не глушится',
      modelKeys: ['ад30ст4001ркм1'],
      faultCodes: ['A25'],
      embedding: [0.1, 0.2],
      limit: 3
    });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM troubleshooting_cases'), [
      'ошибка A25 не глушится',
      ['ад30ст4001ркм1'],
      ['A25'],
      '[0.1,0.2]',
      3,
      'text-embedding-3-small'
    ]);
    expect(results[0]).toMatchObject({ modelKey: 'ад30ст4001ркм1' });
  });
});
