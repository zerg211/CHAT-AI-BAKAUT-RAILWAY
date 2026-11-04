import { beforeEach, expect, it, vi } from 'vitest';
import { runWithDiagnostics, type DiagnosticEvent } from '../src/observability/diagnostics.js';
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../src/email/httpEmail.js', () => ({ sendPreparedLeadEmail: mocks.send, prepareLeadEmailRequest: vi.fn() }));
import { processLeadOutboxItem } from '../src/ai/leadOutbox.js';

beforeEach(() => vi.clearAllMocks());
it('isolates concurrent outbox executions and records unknown outcomes without request or error contents', async () => {
  const events: DiagnosticEvent[] = [];
  mocks.send.mockResolvedValue({ ok: false, error: 'PRIVATE_EMAIL_ERROR_CANARY' });
  const item = (id: string) => ({ id, leadId: '00000000-0000-4000-8000-000000000003', sessionId: '00000000-0000-4000-8000-000000000004',
    turnId: '00000000-0000-4000-8000-000000000005', leaseToken: 'PRIVATE_LEASE_CANARY', attemptCount: 1,
    requestSnapshot: { version: 1, url: 'https://private.example/PRIVATE_URL_CANARY', method: 'POST', body: 'PRIVATE_EMAIL_BODY_CANARY',
      idempotencyKey: 'PRIVATE_KEY_CANARY', provider: 'resend' }, payload: { question: 'PRIVATE_QUESTION_CANARY' } });
  const leads = { prepareLeadOutboxDispatch: vi.fn(async ({ snapshot }) => ({ requestSnapshot: snapshot })),
    markLeadOutboxFailed: vi.fn(async () => ({ status: 'failed' })) };
  const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
  const results = await runWithDiagnostics({}, () => Promise.all(ids.map(id => processLeadOutboxItem({
    item: item(id) as never, conversations: {} as never, leads: leads as never
  }))), event => events.push(event));
  expect(results.every(result => !result.ok)).toBe(true);
  expect(mocks.send).toHaveBeenCalledTimes(2);
  const attempts = events.filter(event => event.name === 'outbox.attempt');
  expect(attempts).toHaveLength(2);
  expect(new Set(attempts.map(event => event.executionId)).size).toBe(2);
  expect(new Set(attempts.map(event => event.jobId)).size).toBe(2);
  expect(attempts.map(event => event.outboxId)).toEqual(ids);
  expect(events.filter(event => event.name === 'outbox.dispatch.result').every(event => event.outcome === 'unknown')).toBe(true);
  expect(events.filter(event => event.name === 'outbox.failure.recorded').every(event => event.nextRetryMs === 60000)).toBe(true);
  expect(JSON.stringify(events)).not.toContain('PRIVATE_');
});
