import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { readPrimaryDocument, primaryDocumentBudget, primaryDocumentContinuation, validatePrimaryDocumentReceipt, unavailablePrimaryDocument } from '../src/ai/primaryDocumentEvidence.js';
import { textPdfPages } from './fixtures/pdfTextFixture.js';

const intent = { kind: 'primary_document' as const, url: 'https://public.example/file', page_indexes: [0, 3], rationale: 'Check the manual' };
const input = { responseId: 'local-id', intent, intentResponseId: 'response-id', discoveryResponseIds: ['search-id'] };
const resolver = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) as never;
const bytes = textPdfPages(['One', 'Two']);
const fetcher = vi.fn(async () => new Response(bytes)) as never;
const inspect = vi.fn(async () => ({ text: 'discarded', totalPages: 2, parsedPages: 2, truncated: false }));
const deps = { resolver, fetcher, inspect };

describe('primary document evidence', () => {
  it('rejects partial HTTP representations before inspection or attachment', async () => {
    const notInspected = vi.fn(inspect);
    for (const [status, range] of [[206, null], [206, 'bytes 0-99/1000'], [200, 'bytes 0-99/1000']] as const) {
      const partialFetch = vi.fn(async () => new Response(bytes, { status,
        headers: range === null ? {} : { 'content-range': range } })) as never;
      const receipt = await readPrimaryDocument({ ...input, intent: { ...intent, page_indexes: [0] } },
        { resolver, fetcher: partialFetch, inspect: notInspected });
      expect(receipt.status).toBe('unavailable');
      expect(receipt.document).toEqual({ state: 'unavailable', reason: 'partial_response' });
      expect(primaryDocumentContinuation(receipt).files).toEqual([]);
    }
    expect(notInspected).not.toHaveBeenCalled();
  });
  it('preserves the complete PDF and marks out-of-range focus pages', async () => {
    const receipt = await readPrimaryDocument(input, deps);
    expect(receipt.status).toBe('partial');
    expect(receipt.unavailable_page_indexes).toEqual([3]);
    expect(receipt.document.state).toBe('available');
    if (receipt.document.state !== 'available') throw new Error('expected PDF');
    expect(Buffer.from(receipt.document.data_url.split(',')[1], 'base64')).toEqual(Buffer.from(bytes));
    const result = primaryDocumentContinuation(receipt);
    expect(result.files[0].file_data).toBe(receipt.document.data_url);
    expect(result.input.content).not.toContain(receipt.document.data_url);
    expect(result.input.content).not.toContain('discarded');
    expect(Object.isFrozen(receipt.intent.page_indexes)).toBe(true);
    expect(Object.isFrozen(receipt.source.discovery_response_ids)).toBe(true);
    expect(() => receipt.intent.page_indexes.push(42)).toThrow();
  });
  it('rejects malformed intent before fetching', async () => {
    const bad = { ...input, intent: { ...intent, page_indexes: [1, 1] } };
    const spy = vi.fn();
    await expect(readPrimaryDocument(bad, { ...deps, fetcher: spy as never })).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
  it('rejects inconsistent or noncanonical PDF evidence and unexpected fields', async () => {
    const receipt = await readPrimaryDocument(input, deps);
    if (receipt.document.state !== 'available') throw new Error('expected PDF');
    for (const document of [
      { ...receipt.document, sha256: 'a'.repeat(64) },
      { ...receipt.document, byte_length: receipt.document.byte_length + 1 },
      { ...receipt.document, data_url: receipt.document.data_url + '=' },
      { ...receipt.document, extra: true }
    ]) expect(() => validatePrimaryDocumentReceipt({ ...receipt, document })).toThrow();
    expect(() => validatePrimaryDocumentReceipt({ ...receipt, source: { ...receipt.source, requested_url: 'https://other.example/' } })).toThrow();
  });
  it('uses the real DNS and redirect guards and byte limit', async () => {
    const privateDns = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]) as never;
    const forbiddenFetch = vi.fn();
    expect((await readPrimaryDocument(input, { resolver: privateDns, fetcher: forbiddenFetch as never, inspect })).document).toEqual({ state: 'unavailable', reason: 'unsafe' });
    expect(forbiddenFetch).not.toHaveBeenCalled();
    const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } })) as never;
    expect((await readPrimaryDocument(input, { resolver, fetcher: redirect, inspect })).document).toEqual({ state: 'unavailable', reason: 'unsafe' });
    const huge = vi.fn(async () => new Response('x', { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } })) as never;
    expect((await readPrimaryDocument(input, { resolver, fetcher: huge, inspect })).document).toEqual({ state: 'unavailable', reason: 'size' });
  });
  it('reports corrupt data and local inspection truncation', async () => {
    const bad = vi.fn(async () => new Response('bad PDF')) as never;
    expect((await readPrimaryDocument(input, { resolver, fetcher: bad, inspect })).document).toEqual({ state: 'unavailable', reason: 'parse_failed' });
    const partial = await readPrimaryDocument({ ...input, intent: { ...intent, page_indexes: [0] } }, { ...deps, inspect: async () => ({ text: '', totalPages: 2, parsedPages: 1, truncated: true }) });
    expect(partial.status).toBe('partial');
  });
  it('rejects a third acquisition without fetching and releases slots after abort', async () => {
    const abort = new AbortController();
    const waiting = vi.fn((_url, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })) as never;
    const first = readPrimaryDocument({ ...input, signal: abort.signal }, { resolver, fetcher: waiting });
    const second = readPrimaryDocument({ ...input, signal: abort.signal }, { resolver, fetcher: waiting });
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledTimes(2));
    expect((await readPrimaryDocument(input, deps)).document).toEqual({ state: 'unavailable', reason: 'busy' });
    abort.abort();
    expect((await first).document).toEqual({ state: 'unavailable', reason: 'aborted' });
    expect((await second).document).toEqual({ state: 'unavailable', reason: 'aborted' });
    expect((await readPrimaryDocument(input, deps)).status).toBe('partial');
  });
  it('opens a genuine PDF with the existing isolated parser', async () => {
    const result = await readPrimaryDocument({ ...input, intent: { ...intent, page_indexes: [0] } }, { resolver, fetcher });
    expect(result.status).toBe('ok');
    expect(result.document.state).toBe('available');
  }, 15000);
  it('produces an explicit disabled receipt without a file', () => {
    expect(primaryDocumentContinuation(unavailablePrimaryDocument(input, 'disabled')).files).toEqual([]);
  });
  it('bounds cumulative available files and ignores valid unavailable history', async () => {
    const receipt = await readPrimaryDocument(input, deps);
    const unavailable = unavailablePrimaryDocument(input, 'disabled');
    const four = [receipt, receipt, receipt, receipt];
    expect(primaryDocumentBudget([...four, unavailable])).toEqual({ remainingFiles: 0, remainingBytes: 16 * 1024 * 1024 - bytes.length * 4 });
    expect(() => primaryDocumentBudget([...four, receipt])).toThrow('budget');
    expect(receipt.document.state).toBe('available');
    expect(primaryDocumentBudget([unavailable, { responseId: 's', model: 'm', status: 'ok', sources: [], findings: '' }])).toEqual({ remainingFiles: 4, remainingBytes: 16 * 1024 * 1024 });
    expect(() => primaryDocumentBudget([{ kind: 'primary_document', document: { state: 'available', byte_length: 1, data_url: 'bad' } }])).toThrow();
  });
  it('accepts exactly 16 MiB and rejects larger totals before decoding the collection', async () => {
    const small = await readPrimaryDocument(input, deps);
    if (small.document.state !== 'available') throw new Error('expected PDF');
    const full = Buffer.alloc(8 * 1024 * 1024);
    full.write('%PDF-');
    const digest = createHash('sha256').update(full).digest('hex');
    const large = { ...small, source: { ...small.source, sha256: digest, byte_length: full.length },
      document: { ...small.document, sha256: digest, byte_length: full.length, data_url: `data:application/pdf;base64,${full.toString('base64')}` } };
    expect(primaryDocumentBudget([large, large])).toEqual({ remainingFiles: 2, remainingBytes: 0 });
    expect(() => primaryDocumentBudget([large, large, small])).toThrow('budget');
    expect(large.document.data_url.length).toBeGreaterThan(full.length);
  }, 15000);
  it('honours the remaining byte budget before and during fetch', async () => {
    const fetchSpy = vi.fn(async () => new Response(bytes)) as never;
    expect((await readPrimaryDocument(input, { resolver, fetcher: fetchSpy, inspect, maxBytes: 0 })).document).toEqual({ state: 'unavailable', reason: 'aggregate_limit' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await readPrimaryDocument(input, { resolver, fetcher: fetchSpy, inspect, maxBytes: bytes.length - 1 })).document).toEqual({ state: 'unavailable', reason: 'aggregate_limit' });
    expect((await readPrimaryDocument(input, { resolver, fetcher: fetchSpy, inspect, maxBytes: bytes.length })).status).toBe('partial');
    await expect(readPrimaryDocument(input, { ...deps, maxBytes: 8 * 1024 * 1024 + 1 })).rejects.toThrow();
  });});
