import { expect, it, vi } from 'vitest';
import { runWithDiagnostics, type DiagnosticEvent } from '../src/observability/diagnostics.js';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), safeFetch: vi.fn() }));
vi.mock('undici', () => ({ fetch: mocks.fetch }));
vi.mock('../src/security/outboundHttp.js', () => ({ safeFetchBytes: mocks.safeFetch, outboundText: vi.fn() }));
vi.mock('../src/config.js', () => ({ config: { EMAIL_HTTP_URL: 'https://private.example/PRIVATE_URL_CANARY', EMAIL_HTTP_METHOD: 'POST', EMAIL_HTTP_TIMEOUT_MS: 1000, CATALOG_MAX_RESPONSE_BYTES: 10000 } }));
import { readSitePriceObservation } from '../src/catalog/currentSitePrice.js';
import { sendPreparedLeadEmail } from '../src/email/httpEmail.js';

it('records swallowed site-price failures without source, product, or error contents', async () => {
  const events: DiagnosticEvent[] = [];
  mocks.safeFetch.mockRejectedValueOnce(new TypeError('PRIVATE_PRICE_ERROR_CANARY'));
  const result = await runWithDiagnostics({}, () => readSitePriceObservation({ id: 'PRIVATE_PRODUCT_ID_CANARY',
    name: 'PRIVATE_PRODUCT_NAME_CANARY', sourceUrl: 'https://bakautprof.ru/catalog/PRIVATE_URL_CANARY' } as never), event => events.push(event));
  expect(result.status).toBe('unknown');
  expect(events.some(event => event.name === 'catalog.price.failed')).toBe(true);
  expect(JSON.stringify(events)).not.toContain('PRIVATE_');
  expect(mocks.safeFetch).toHaveBeenCalledTimes(1);
});

it('keeps email transport failure as unknown without leaking the immutable request or error', async () => {
  const events: DiagnosticEvent[] = [];
  mocks.fetch.mockRejectedValueOnce(new Error('PRIVATE_EMAIL_ERROR_CANARY'));
  const result = await runWithDiagnostics({}, () => sendPreparedLeadEmail({ version: 1, url: 'https://private.example/PRIVATE_URL_CANARY',
    method: 'POST', body: 'PRIVATE_EMAIL_BODY_CANARY', idempotencyKey: 'PRIVATE_KEY_CANARY', provider: 'other' }), event => events.push(event));
  expect(result.ok).toBe(false);
  expect(result.error).toContain('PRIVATE_EMAIL_ERROR_CANARY'); // Business return stays unchanged.
  expect(events.find(event => event.name === 'email.dispatch.failed')?.knownOutcome).toBe('unknown');
  expect(JSON.stringify(events)).not.toContain('PRIVATE_');
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});
