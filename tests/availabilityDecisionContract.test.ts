import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
const leads = vi.hoisted(() => ({ find: vi.fn(), create: vi.fn() }));
vi.mock('../src/db/repositories.js', () => ({ LeadRepository: class {
  findClientLeadWithOutbox = leads.find; createClientLeadWithOutbox = leads.create;
} }));
import { applyPlatformAvailability, availabilityOutputSchema, AvailabilityDecisionRejectedError, availabilityLeadHash } from '../src/ai/platformAvailability.js';
import { AgentAnswerRejectedError } from '../src/ai/agentAnswerRejected.js';
import { normalizeAvailabilityRequest, normalizePublicHistoryMessages } from '../src/shared/publicChatHistory.js';

const productId = 'a'.repeat(24);
const decision = { action: 'offer', continueRequest: false, consentGranted: false, consentQuote: null,
  requestSummary: 'Проверить возможность поставки', productIds: [productId], preferredContact: null };
function input(value: unknown = decision) {
  return { db: { query: vi.fn(async () => { throw new Error('Unexpected SQL'); }) } as unknown as PoolClient,
    sessionId: randomUUID(), turnId: randomUUID(), userMessage: 'Уточните', decision: value, priorMessages: [], knownProductIds: [productId] };
}
beforeEach(() => {
  vi.stubGlobal('fetch', async () => { throw new Error('Network forbidden in contract tests'); });
  leads.find.mockReset(); leads.create.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('availability decision boundary', () => {
  it('passes all verified product IDs structurally when the summary does not name models', async () => {
    const productIds = [productId, 'b'.repeat(24)];
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    leads.find.mockResolvedValue(null); leads.create.mockResolvedValue({ lead: { id: 'lead' }, outbox: { id: 'outbox', status: 'pending' } });
    const result = await applyPlatformAvailability({ ...input({ ...decision, action: 'capture', productIds,
      requestSummary: 'Check availability of these two models', consentGranted: true, consentQuote: 'Напишите мне' }),
      db: { query } as never, knownProductIds: productIds, userMessage: 'Напишите мне на buyer@example.org' });
    expect(result.availabilityReceipt?.outcome).toBe('queued');
    expect(leads.create).toHaveBeenCalledWith(expect.objectContaining({ productIds, question: 'Check availability of these two models' }));
  });
  it.each([undefined, [], [productId]])('fails closed for unknown IDs even without a known-product context: %j', async knownProductIds => {
    const value = { ...input({ ...decision, action: 'capture', productIds: ['b'.repeat(24)], consentGranted: true, consentQuote: 'Напишите мне' }),
      knownProductIds, userMessage: 'Напишите мне на buyer@example.org' };
    await expect(applyPlatformAvailability(value)).rejects.toMatchObject({ reason: 'unknown_product' });
    expect(value.db.query).not.toHaveBeenCalled(); expect(leads.create).not.toHaveBeenCalled();
  });
  it('binds a nonempty product scope into the capture hash while retaining empty legacy hashes', () => {
    const base = { question: 'Check availability', email: 'buyer@example.org' };
    expect(availabilityLeadHash({ ...base, productIds: [] })).toBe(availabilityLeadHash(base));
    expect(availabilityLeadHash({ ...base, productIds: [productId] })).not.toBe(availabilityLeadHash(base));
    expect(availabilityLeadHash({ ...base, productIds: [productId, 'b'.repeat(24)] }))
      .not.toBe(availabilityLeadHash({ ...base, productIds: [productId] }));
  });
  it.each([2424, 3000])('preserves the full %s-code-point scope through offer, history, continuation and lead payload', async length => {
    const tail = ' DO NOT CALL; EMAIL ONLY';
    const summary = 'A'.repeat(length - 600 - Array.from(tail).length) + '🛠'.repeat(600) + tail;
    expect(Array.from(summary)).toHaveLength(length); expect(summary.length).toBeGreaterThan(3000);
    const base = input({ ...decision, requestSummary: summary, preferredContact: 'message' });
    const offered = await applyPlatformAvailability(base);
    expect(offered.availabilityRequest?.question).toBe(summary);
    expect(normalizeAvailabilityRequest({ ...offered.availabilityRequest, question: summary })?.question).toBe(summary);
    const stored = JSON.parse(JSON.stringify(offered.metadata));
    const restored = normalizePublicHistoryMessages([{ role: 'assistant', content: 'Можно уточнить наличие.',
      availabilityRequest: stored.availabilityRequest, availabilityReceipt: stored.availabilityReceipt }])[0];
    expect(restored.availabilityRequest?.question).toBe(summary);
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    leads.find.mockResolvedValue(null); leads.create.mockResolvedValue({ lead: { id: 'lead' }, outbox: { id: 'outbox', status: 'pending' } });
    const result = await applyPlatformAvailability({ ...base, db: { query } as never, turnId: randomUUID(),
      userMessage: 'Напишите мне на buyer@example.org', decision: { ...decision, action: 'capture', continueRequest: true,
        consentGranted: true, consentQuote: 'Напишите мне', requestSummary: 'Не заменяет сохранённый вопрос', preferredContact: null },
      priorMessages: [{ id: 'history', sessionId: base.sessionId, role: 'assistant', content: restored.content,
        createdAt: '2026-11-15T00:00:00Z', metadata: { availabilityRequest: restored.availabilityRequest } }] });
    expect(result).toMatchObject({ leadCreated: true, availabilityReceipt: { outcome: 'queued' } });
    expect(result.availabilityRequest?.question).toBe(summary);
    expect(leads.create).toHaveBeenCalledWith(expect.objectContaining({ question: summary, preferredContact: 'message',
      email: 'buyer@example.org', clientLeadId: offered.availabilityRequest!.id }));
    expect(result.availabilityRequest?.question.endsWith(tail)).toBe(true);
  });
  it('rejects3001-code-point history without truncation and keeps the matching receipt out', () => {
    const question = '🛠'.repeat(2999) + 'AB';
    const request = { id: randomUUID(), state: 'offered', question, productIds: [productId] };
    expect(normalizeAvailabilityRequest(request)).toBeUndefined();
    const restored = normalizePublicHistoryMessages([{ role: 'assistant', content: 'Предложение', availabilityRequest: request,
      availabilityReceipt: { requestId: request.id, outcome: 'offered', warehouseChecked: false } }]);
    expect(restored[0].availabilityRequest).toBeUndefined(); expect(restored[0].availabilityReceipt).toBeUndefined();
  });
  it('redacts contacts without losing the Unicode tail and explicitly rejects redaction overflow', async () => {
    const tail = ' DO NOT CALL; EMAIL ONLY';
    const summary = 'A'.repeat(1800) + '🛠'.repeat(600) + ' buyer@example.org +7 900 000-10-03' + tail;
    const redacted = await applyPlatformAvailability({ ...input({ ...decision, requestSummary: summary }),
      userMessage: 'buyer@example.org +7 900 000-10-03' });
    expect(redacted.availabilityRequest?.question.endsWith(tail)).toBe(true);
    expect(JSON.stringify(redacted.metadata)).not.toContain('buyer@example.org');
    expect(JSON.stringify(redacted.metadata)).not.toContain('900 000-10-03');
    expect(redacted.availabilityRequest?.question).toContain('[контакт скрыт]');
    const email = ' a@b.co';
    const value = input({ ...decision, requestSummary: 'A'.repeat(3000 - email.length) + email });
    await expect(applyPlatformAvailability(value)).rejects.toMatchObject({ reason: 'scope_too_long' });
    expect(value.db.query).not.toHaveBeenCalled(); expect(leads.create).not.toHaveBeenCalled();
  });
  it('publishes the same length and identity constraints that the executor enforces', () => {
    expect(availabilityOutputSchema.properties.requestSummary).toMatchObject({ maxLength: 3000 });
    expect(availabilityOutputSchema.properties.consentQuote).toMatchObject({ maxLength: 3000 });
    expect(availabilityOutputSchema.properties.productIds.items).toMatchObject({ pattern: '^[0-9a-f]{24}$' });
  });
  it.each([['requestSummary', 'x'], ['consentQuote', 'x'], ['requestSummary', '😀'], ['consentQuote', '😀']])('accepts3000 and explicitly rejects3001 for %s with %s without SQL', async (field, symbol) => {
    const valid = input({ ...decision, [field]: symbol.repeat(3000) });
    expect(await applyPlatformAvailability(valid)).toMatchObject({ leadCreated: false,
      availabilityReceipt: { outcome: 'offered', warehouseChecked: false } });
    const invalid = input({ ...decision, [field]: symbol.repeat(3001) });
    await expect(applyPlatformAvailability(invalid)).rejects.toBeInstanceOf(AgentAnswerRejectedError);
    expect(valid.db.query).not.toHaveBeenCalled(); expect(invalid.db.query).not.toHaveBeenCalled();
    expect(leads.create).not.toHaveBeenCalled();
  });
  it.each(['', 'a'.repeat(23), 'a'.repeat(25), 'A'.repeat(24), 'g'.repeat(24), '00000000-0000-4000-8000-000000000001'])('rejects malformed product ID %s before capture', async id => {
    const value = input({ ...decision, action: 'capture', consentGranted: true, consentQuote: 'Свяжитесь со мной', productIds: [id] });
    value.userMessage = 'Свяжитесь со мной +7 900 000-10-03';
    await expect(applyPlatformAvailability(value)).rejects.toMatchObject({ reason: 'invalid_shape' });
    expect(value.db.query).not.toHaveBeenCalled(); expect(leads.find).not.toHaveBeenCalled(); expect(leads.create).not.toHaveBeenCalled();
  });
  it.each([null, undefined, { ...decision, action: 'none', requestSummary: '', productIds: [] }])('keeps no-action %j inactive', async decision => {
    const value = input(); value.decision = decision;
    expect(await applyPlatformAvailability(value)).toEqual({ leadRequested: false, leadCreated: false, metadata: {} });
    expect(value.db.query).not.toHaveBeenCalled(); expect(leads.create).not.toHaveBeenCalled();
  });
  it.each([{}, false, 'offer', { ...decision, action: 'none', productIds: ['invalid'] }, { ...decision, extra: 'private' }])('rejects malformed non-null decisions %j', async decision => {
    const value = input(decision);
    await expect(applyPlatformAvailability(value)).rejects.toBeInstanceOf(AvailabilityDecisionRejectedError);
    expect(value.db.query).not.toHaveBeenCalled(); expect(leads.create).not.toHaveBeenCalled();
  });
  it('rejects a well-formed but unknown product and empty scope explicitly', async () => {
    const unknown = input({ ...decision, productIds: ['b'.repeat(24)] });
    await expect(applyPlatformAvailability(unknown)).rejects.toMatchObject({ reason: 'unknown_product' });
    const empty = input({ ...decision, requestSummary: '   ' });
    await expect(applyPlatformAvailability(empty)).rejects.toMatchObject({ reason: 'empty_scope' });
    const invalidId = { ...input(), turnId: 'invalid' };
    await expect(applyPlatformAvailability(invalidId)).rejects.toMatchObject({ reason: 'invalid_request_id' });
    for (const value of [unknown, empty, invalidId]) expect(value.db.query).not.toHaveBeenCalled();
    expect(leads.create).not.toHaveBeenCalled();
  });
  it('keeps invalid details out of the propagated error', async () => {
    const value = input({ ...decision, requestSummary: 'private-contact-canary'.repeat(300) });
    try { await applyPlatformAvailability(value); throw new Error('Expected rejection'); }
    catch (error) {
      expect(error).toBeInstanceOf(AgentAnswerRejectedError);
      expect(String(error)).not.toContain('private-contact-canary');
      expect(JSON.stringify(error)).not.toContain('private-contact-canary');
    }
  });
  it('keeps current-turn consent and durable capture checks in force', async () => {
    const value = input({ ...decision, action: 'capture', consentGranted: true, consentQuote: 'Несуществующее согласие' });
    value.userMessage = '+7 900 000-10-03';
    expect(await applyPlatformAvailability(value)).toMatchObject({ leadCreated: false, availabilityReceipt: { outcome: 'consent_required' } });
    expect(leads.create).not.toHaveBeenCalled(); expect(value.db.query).not.toHaveBeenCalled();
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    leads.find.mockResolvedValue(null); leads.create.mockResolvedValue({ lead: { id: 'lead' }, outbox: { id: '', status: 'pending' } });
    const failed = await applyPlatformAvailability({ ...value, db: { query } as never, userMessage: 'Свяжитесь со мной +7 900 000-10-03',
      decision: { ...decision, action: 'capture', consentGranted: true, consentQuote: 'Свяжитесь со мной' } });
    expect(failed).toMatchObject({ leadCreated: false, availabilityReceipt: { outcome: 'failed', warehouseChecked: false } });
    expect(query.mock.calls.map(call => call[0])).toContain('ROLLBACK TO SAVEPOINT platform_availability_capture');
  });
});
