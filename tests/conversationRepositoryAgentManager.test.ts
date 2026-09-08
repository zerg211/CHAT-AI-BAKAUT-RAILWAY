import { describe, expect, it, vi } from 'vitest';
import { ConversationRepository } from '../src/db/repositories.js';

describe('ConversationRepository agent manager primitives', () => {
  it('upserts ledger events idempotently by session and event id', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: 'row' }] });
    const repository = new ConversationRepository({ query } as never);

    await repository.upsertDialogueLedgerEvent({
      sessionId: 'session-id',
      turnId: 'turn-id',
      executionOwner: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      eventId: 'fact.confirmed:abc',
      eventType: 'fact.confirmed',
      scope: 'dialogue',
      payload: { factKey: 'need.power_kw', value: 5 },
      evidence: 'buyer wrote 5 kW',
      source: 'llm_state_delta',
      status: 'active'
    });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (session_id, event_id)'), expect.any(Array));
    expect(query.mock.calls[0][1][5]).toBe(JSON.stringify({ factKey: 'need.power_kw', value: 5 }));
  });

  it('commits one final assistant result through the execution-owner fence', async () => {
    const now = new Date('2026-05-19T12:00:00.000Z');
    const query = vi.fn().mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        id: 'message-id',
        session_id: 'session-id',
        role: 'assistant',
        content: 'answer',
        metadata: { turnId: 'turn-id' },
        created_at: now
      }]
    });
    const repository = new ConversationRepository({ query } as never);

    const message = await repository.addAssistantMessageForTurn({
      sessionId: 'session-id',
      turnId: 'turn-id',
      content: 'answer',
      metadata: { turnId: 'turn-id' },
      executionOwner: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      answerContract: { answerText: 'answer' },
      review: { verdict: 'pass', issues: [] },
      responsePayload: { answer: 'answer' }
    });

    expect(query.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(query.mock.calls[0][0]).toContain('execution_owner = $3::uuid');
    expect(query.mock.calls[0][0]).toContain('INSERT INTO answer_contracts');
    expect(message).toMatchObject({ id: 'message-id', content: 'answer' });
  });

  it('appends and replays durable turn events from a monotonic cursor', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ session_id: 'session-id', turn_id: 'turn-id', seq: '7', stage: 'tools', event_type: 'tool_started' }]
      })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ session_id: 'session-id', turn_id: 'turn-id', seq: '8', stage: 'answer', event_type: 'contract_created' }]
      });
    const repository = new ConversationRepository({ query } as never);

    await repository.appendTurnEvent({
      sessionId: 'session-id',
      turnId: 'turn-id',
      stage: 'tools',
      eventType: 'tool_started',
      payload: { tool: 'catalog.search' }
    });
    const events = await repository.listTurnEvents('session-id', 'turn-id', 7, 25);

    expect(query.mock.calls[0][0]).toContain('INSERT INTO turn_events');
    expect(query.mock.calls[0][1][4]).toBe(JSON.stringify({ tool: 'catalog.search' }));
    expect(query.mock.calls[1][0]).toContain('seq > $3');
    expect(query.mock.calls[1][0]).toContain('ORDER BY seq ASC');
    expect(query.mock.calls[1][1]).toEqual(['session-id', 'turn-id', 7, 25]);
    expect(events).toEqual([{ session_id: 'session-id', turn_id: 'turn-id', seq: '8', stage: 'answer', event_type: 'contract_created' }]);
  });
});
