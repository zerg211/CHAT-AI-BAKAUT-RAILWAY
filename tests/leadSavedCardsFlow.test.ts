import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../src/shared/types.js';
const mocks = vi.hoisted(() => ({ create: vi.fn(), find: vi.fn(), restore: vi.fn(), messages: vi.fn(), pending: vi.fn(), query: vi.fn(), wire: vi.fn(), blocked: vi.fn() }));
vi.mock('../src/config.js', () => ({ config: { EMAIL_HTTP_URL: 'https://api.resend.com/emails', EMAIL_HTTP_METHOD: 'POST',
  EMAIL_FROM: 'fixture@example.org', LEADS_TO_EMAIL: 'manager@example.org', EMAIL_HTTP_TIMEOUT_MS: 1000 } }));
vi.mock('../src/db/pool.js', () => ({ pool: { query: mocks.blocked, connect: async () => ({ query: mocks.query, release: vi.fn() }) } }));
vi.mock('undici', () => ({ fetch: mocks.wire }));
vi.mock('../src/db/repositories.js', () => ({
  LeadRepository: vi.fn(function() { return { createClientLeadWithOutbox: mocks.create, findClientLeadWithOutbox: mocks.find }; }),
  ConversationRepository: vi.fn(function() { return { restoreSession: mocks.restore, listMessages: mocks.messages, getLatestUnansweredTurn: mocks.pending }; })
}));
import { applyPlatformAvailability } from '../src/ai/platformAvailability.js';
import { registerLeadRoutes } from '../src/routes/leads.js';
import { processLeadOutboxItem } from '../src/ai/leadOutbox.js';
import type { LeadEmailRequestSnapshot } from '../src/email/httpEmail.js';

beforeEach(() => {
  vi.clearAllMocks(); mocks.blocked.mockImplementation(() => { throw new Error('External network/SQL forbidden'); });
  vi.stubGlobal('fetch', mocks.blocked); mocks.find.mockResolvedValue(null); mocks.pending.mockResolvedValue(null);
  mocks.restore.mockResolvedValue({ id: 'active', status: 'active' }); mocks.query.mockResolvedValue({ rows: [{ id: 'locked' }] });
  mocks.wire.mockResolvedValue(Response.json({ id: 'offline-delivery' }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('saved product references through both capture channels and new email dispatch', () => {
  it('keeps a legacy unattempted outbox ID-only even when current history has a card', async () => {
    const id = 'a'.repeat(24), sourceId = randomUUID();
    let saved: LeadEmailRequestSnapshot | undefined;
    const leads = { getLead: async () => ({ id: 'legacy-lead', sessionId: 'session', question: 'Legacy question' }),
      prepareLeadOutboxDispatch: async ({ snapshot }: { snapshot: LeadEmailRequestSnapshot }) => {
        saved = structuredClone(snapshot); return { requestSnapshot: saved };
      }, markLeadOutboxSent: async () => ({ id: 'legacy' }), markLeadOutboxFailed: vi.fn() };
    expect(await processLeadOutboxItem({ item: { id: 'legacy', leadId: 'legacy-lead', sessionId: 'session', turnId: randomUUID(),
      destination: 'lead_email', status: 'sending', attemptCount: 1, leaseToken: 'legacy-lease', payload: { productIds: [id] },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, leads: leads as never,
      conversations: { getSession: async () => ({ id: 'session', conversationNumber: 1, title: 'Legacy' }),
        listMessages: async () => [{ id: sourceId, role: 'assistant', content: 'Card', metadata: {
          runtimeMode: 'openai_responses_saved_agent', catalogRevision: 'current-v2',
          knownProducts: { source_revision: 'current-v2', product_ids: [id] },
          productCards: [{ id, name: 'NEVER ENRICH THIS LEGACY ITEM', sourceUrl: 'https://bakautprof.ru/catalog/new/' }] } }] } as never }))
      .toEqual({ ok: true });
    expect(saved?.productReferences).toBeUndefined();
    expect(JSON.parse(saved!.body).text).toContain(`Товары заявки (ID каталога):\n- ${id}`);
    expect(saved!.body).not.toContain('NEVER ENRICH'); expect(mocks.blocked).not.toHaveBeenCalled();
  });

  it.each(['chat', 'form'])('freezes the historical card for %s, keeps missing IDs and formats a new wire snapshot', async channel => {
    const sessionId = randomUUID(), requestId = randomUUID(), sourceId = randomUUID(), leadId = randomUUID();
    const ids = ['a'.repeat(24), 'b'.repeat(24)];
    const name = 'Модель ' + '🛠'.repeat(250), url = 'https://bakautprof.ru/catalog/vibroplity/historical/';
    const scope = { id: requestId, state: 'offered', question: 'Проверить наличие обеих моделей 🛠', productIds: ids };
    const source: Message = { id: sourceId, sessionId, role: 'assistant', content: 'Сохранённая карточка', createdAt: new Date().toISOString(), metadata: {
      runtimeMode: 'openai_responses_saved_agent', catalogRevision: 'historical-v1',
      knownProducts: { source_revision: 'historical-v1', product_ids: ids }, productCards: [{ id: ids[0], name, sourceUrl: url }] } };
    const history = [source, { ...source, id: randomUUID(), createdAt: new Date(Date.parse(source.createdAt) + 1000).toISOString(), metadata: { availabilityRequest: scope } },
      { ...source, id: randomUUID(), createdAt: new Date(Date.parse(source.createdAt) + 2000).toISOString(), metadata: { ...source.metadata, catalogRevision: 'new-v2',
        knownProducts: { source_revision: 'new-v2', product_ids: ids }, productCards: [{ id: ids[0], name: 'NEW catalog name', sourceUrl: url }] } }];
    mocks.messages.mockResolvedValue(history);
    const lead = { id: leadId, sessionId, question: scope.question, email: 'buyer@example.org', status: 'pending_email', createdAt: new Date().toISOString() };
    mocks.create.mockResolvedValue({ lead, outbox: { id: 'outbox', status: 'pending' } });
    if (channel === 'chat') {
      const result = await applyPlatformAvailability({ db: { query: mocks.query } as never, sessionId, turnId: randomUUID(),
        userMessage: 'Напишите мне на buyer@example.org', knownProductIds: ['c'.repeat(24)], priorMessages: history,
        decision: { action: 'capture', continueRequest: true, requestSummary: 'Changed summary', productIds: [], preferredContact: 'message',
          consentGranted: true, consentQuote: 'Напишите мне' } });
      expect(result.availabilityReceipt?.outcome).toBe('queued');
    } else {
      const app = Fastify({ logger: false }); await app.register(rateLimit); await registerLeadRoutes(app);
      try {
        const result = await app.inject({ method: 'POST', url: '/api/leads', headers: { 'x-bakaut-visitor-id': 'offline-visitor-capability' },
          payload: { sessionId, clientLeadId: requestId, availabilityRequestId: requestId, email: 'buyer@example.org', question: 'Client text ignored' } });
        expect(result.statusCode).toBe(200);
      } finally { await app.close(); }
    }
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const captured = mocks.create.mock.calls[0][0];
    expect(captured.productIds).toEqual(ids); expect(captured.question).toBe(scope.question);
    const expected = [{ productId: ids[0], status: 'saved_card', name, sourceUrl: url, sourceMessageId: sourceId, catalogRevision: 'historical-v1' },
      { productId: ids[1], status: 'unavailable', reason: 'missing_card' }];
    expect(captured.productReferences).toEqual(expected);
    let frozen: LeadEmailRequestSnapshot | undefined;
    const leads = { getLead: async () => lead,
      prepareLeadOutboxDispatch: async ({ snapshot }: { snapshot: LeadEmailRequestSnapshot }) => {
        expect(mocks.wire).not.toHaveBeenCalled(); frozen = structuredClone(snapshot); return { requestSnapshot: frozen };
      }, markLeadOutboxSent: async () => ({ id: 'outbox' }), markLeadOutboxFailed: vi.fn() };
    const outcome = await processLeadOutboxItem({ item: { id: 'outbox', leadId, sessionId, turnId: requestId, destination: 'lead_email',
      status: 'sending', attemptCount: 1, leaseToken: 'offline-lease', payload: JSON.parse(JSON.stringify(captured)),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, leads: leads as never,
      conversations: { getSession: async () => ({ id: sessionId, conversationNumber: 1, title: 'Fixture' }), listMessages: async () => history } as never });
    expect(outcome).toEqual({ ok: true }); expect(frozen?.productReferences).toEqual(expected);
    const wire = JSON.parse(frozen!.body);
    expect(wire.text).toContain(`- ${ids[0]}\n  Название: ${name}\n  Карточка: ${url}`);
    expect(wire.text).toContain(`- ${ids[1]}\n  Название: нет достоверного названия\n  Карточка: нет достоверной ссылки`);
    expect(wire.text).not.toContain('NEW catalog name'); expect(Object.keys(wire).sort()).toEqual(['from', 'subject', 'text', 'to']);
    expect(mocks.wire).toHaveBeenCalledTimes(1); expect(mocks.wire.mock.calls[0][1].body).toBe(frozen!.body);
    expect(mocks.blocked).not.toHaveBeenCalled();
  });
});
