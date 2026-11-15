import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const io = vi.hoisted(() => ({ blocked: vi.fn(), wire: vi.fn() }));
vi.mock('undici', () => ({ fetch: io.wire }));
vi.mock('../src/db/pool.js', () => ({ pool: { query: io.blocked, connect: io.blocked } }));
vi.mock('../src/config.js', () => ({ config: { EMAIL_HTTP_URL: 'https://api.resend.com/emails', EMAIL_HTTP_METHOD: 'POST',
  EMAIL_FROM: 'fixture@example.org', LEADS_TO_EMAIL: 'manager@example.org', EMAIL_HTTP_TIMEOUT_MS: 1000 } }));
import { applyPlatformAvailability } from '../src/ai/platformAvailability.js';
import { LeadRepository } from '../src/db/repositories.js';
import { processLeadOutboxItem } from '../src/ai/leadOutbox.js';

beforeEach(() => {
  io.blocked.mockImplementation(async () => { throw new Error('External network or PostgreSQL forbidden'); });
  io.wire.mockResolvedValue(Response.json({ id: 'offline-delivery' }));
  vi.stubGlobal('fetch', io.blocked);
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('verified product identity from capture to email snapshot', () => {
  it('executes actual capture, repository mapping and outbox serialization with multiple IDs and generic summary', async () => {
    const productIds = ['a'.repeat(24), 'b'.repeat(24)];
    const sessionId = randomUUID(), turnId = randomUUID(), leadId = randomUUID(), outboxId = randomUUID();
    let stored: { lead_row: Record<string, unknown>; outbox_row: Record<string, unknown> } | undefined;
    const query = vi.fn(async (sql: string, args: unknown[] = []) => {
      if (sql.startsWith('SAVEPOINT') || sql.startsWith('RELEASE SAVEPOINT')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM leads lead JOIN lead_outbox')) return { rows: stored ? [stored] : [], rowCount: stored ? 1 : 0 };
      if (sql.includes('INSERT INTO lead_outbox')) {
        expect(sql).toContain("'productIds', $12::jsonb"); expect(JSON.parse(String(args[11]))).toEqual(productIds);
        stored = { lead_row: { id: leadId, session_id: args[0], client_lead_id: args[1], client_request_hash: args[2],
          name: args[3], phone: args[4], email: args[5], question: args[6], status: 'pending_email', created_at: new Date() },
          outbox_row: { id: outboxId, lead_id: leadId, session_id: sessionId, turn_id: turnId, destination: 'lead_email',
            payload: { leadId, question: args[6], preferredContact: args[7], purpose: args[9], source: args[10], productIds: JSON.parse(String(args[11])) },
            status: 'pending', attempt_count: 1, created_at: new Date(), updated_at: new Date() } };
        return { rows: [stored], rowCount: 1 };
      }
      if (sql.includes('SET request_snapshot = COALESCE')) {
        expect(stored).toBeDefined(); stored!.outbox_row.request_snapshot ??= JSON.parse(String(args[2]));
        return { rows: [stored!.outbox_row], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL-mock statement: ${sql.slice(0, 60)}`);
    });
    const result = await applyPlatformAvailability({ db: { query } as never, sessionId, turnId,
      userMessage: 'Напишите мне на buyer@example.org', knownProductIds: productIds, priorMessages: [],
      decision: { action: 'capture', continueRequest: false, consentGranted: true, consentQuote: 'Напишите мне',
        requestSummary: 'Check availability of these two models', productIds, preferredContact: 'message' } });
    expect(result.availabilityReceipt?.outcome).toBe('queued');
    const repository = new LeadRepository({ query } as never);
    const completion = await repository.findClientLeadWithOutbox(sessionId, turnId);
    if (!completion) throw new Error('Missing SQL-mock completion');
    expect(completion.outbox.payload.productIds).toEqual(productIds);
    const leads = { getLead: vi.fn(async () => completion.lead), prepareLeadOutboxDispatch: repository.prepareLeadOutboxDispatch.bind(repository),
      markLeadOutboxSent: vi.fn(async () => ({ id: outboxId })), markLeadOutboxFailed: vi.fn(async () => ({ id: outboxId })) };
    expect(await processLeadOutboxItem({ item: { ...completion.outbox, status: 'sending', leaseToken: 'offline-lease' }, leads: leads as never,
      conversations: { getSession: async () => ({ id: sessionId, conversationNumber: 1, title: 'Offline fixture' }), listMessages: async () => [] } as never }))
      .toEqual({ ok: true });
    const snapshot = stored!.outbox_row.request_snapshot as { productIds: string[]; body: string };
    expect(snapshot.productIds).toEqual(productIds);
    const wire = JSON.parse(snapshot.body);
    expect(wire.text).toContain('Исходный вопрос покупателя: Check availability of these two models');
    expect(wire.text).toContain(`Товары заявки (ID каталога):\n- ${productIds[0]}\n- ${productIds[1]}`);
    expect(Object.keys(wire).sort()).toEqual(['from', 'subject', 'text', 'to']);
    expect(io.wire).toHaveBeenCalledTimes(1); expect(io.wire.mock.calls[0][1].body).toBe(snapshot.body);
    expect(io.blocked).not.toHaveBeenCalled();
  });
});
