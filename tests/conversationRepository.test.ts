import { describe, expect, it, vi } from 'vitest';
import { ConversationRepository } from '../src/db/repositories.js';

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
      expect.objectContaining({ rating: 'negative' })
    ]);
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
