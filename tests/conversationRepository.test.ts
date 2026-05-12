import { describe, expect, it, vi } from 'vitest';
import { ConversationRepository, ProductRepository } from '../src/db/repositories.js';

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
      expect.any(String)
    ]);
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
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValue({ rowCount: 1, rows: [turnRow] });
    const repository = new ConversationRepository({ query } as never);

    await repository.createTurn({
      sessionId: 'session-id',
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

    expect(query.mock.calls[1][1][5]).toBe(JSON.stringify([{ summary: 'before' }]));
    expect(query.mock.calls[2][1][8]).toBe(JSON.stringify({ taskType: 'product_selection_with_availability' }));
    expect(query.mock.calls[2][1][10]).toBe(JSON.stringify([{ summary: 'after' }]));
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
      3
    ]);
    expect(results[0]).toMatchObject({ modelKey: 'ад30ст4001ркм1' });
  });
});
