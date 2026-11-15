import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ConversationRepository } from '../src/db/repositories.js';
import type { WebContinuationCheckpoint } from '../src/ai/controlledWebContinuation.js';
import type { ControlledRequest } from '../src/ai/controlledResponsesClient.js';

vi.mock('../src/config.js', () => ({ config: { OPENAI_MONETARY_GUARD_ENABLED: false, BAKAUT_CATALOG_URL: 'https://catalog-search-production.up.railway.app', BAKAUT_MCP_TOKEN: 'offline-token', CONTROLLED_WEB_SEARCH_ENABLED: true, CONTROLLED_WEB_SEARCH_FEES_APPROVED: true } }));
vi.mock('../src/ai/openaiUsageGuard.js', () => ({ currentOpenAIUsageContext: () => ({ sessionId: 'session', turnId: 'turn' }),
  assertOpenAIUsageBudget: async () => 'reservation', bindOpenAIUsageReservation: () => undefined, recordOpenAIUsageOnce: async () => undefined }));
import { ControlledResponsesClient } from '../src/ai/controlledResponsesClient.js';
import { continueAfterWebSearch } from '../src/ai/controlledWebContinuation.js';
import { readPrimaryDocument, unavailablePrimaryDocument } from '../src/ai/primaryDocumentEvidence.js';
import { acceptCatalogReview, reviewContext, reviewDigest, reviewSources } from '../src/ai/catalogReviewState.js';
import { textPdfPages } from './fixtures/pdfTextFixture.js';

const bytes = textPdfPages(['First page', 'Second page']);
const captureInput = { responseId: 'document-one', intent: { kind: 'primary_document' as const, url: 'https://public.example/manual.pdf', page_indexes: [0], rationale: 'Read the manual' }, intentResponseId: 'resp_intent', discoveryResponseIds: ['search-one'] };
const resolver = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) as never;
const fetcher = vi.fn(async () => new Response(bytes)) as never;
const prefetch = { source_revision: 'revision', completeness: 'full' as const, items: [] };
const search = { responseId: 'search-one', status: 'ok' as const, model: 'model', usage: null, toolFees: null, monetaryCost: null, costStatus: 'unknown' as const, findings: 'Found', sources: [] };
const part = z.discriminatedUnion('type', [z.object({ type: z.literal('input_text'), text: z.string() }).strict(), z.object({ type: z.literal('input_file'), filename: z.string(), file_data: z.string() }).strict()]);
const inputSchema = z.array(z.object({ role: z.literal('user'), content: z.array(part) }).strict());
const answer = JSON.stringify({ answer_contract: 'consultation_receipt_v1', answer: 'Done', answer_review: { verdict: 'complete', publication: 'ready', rationale: 'Done' }, web_search_intent: null, selected: [], rejected: [], uncertain: [], comparison_ids: [], recommendation_status: 'not_applicable', selection_snapshots: [], availability: null });
function resign(plan: ControlledRequest) {
  plan.manifest.request_sha256 = reviewDigest(plan.request);
  plan.manifest.prefetch_sha256 = reviewDigest(plan.prefetch);
  const { plan_sha256: _excluded, ...manifest } = plan.manifest;
  plan.manifest.plan_sha256 = reviewDigest({ ...plan, manifest });
}

describe('primary document delivery through real controlled client', () => {
  const requests: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  let interrupt = false;
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? z.record(z.string(), z.unknown()).parse(JSON.parse(init.body)) : undefined;
    requests.push({ path, method, body });
    if (path === '/v1/agents/agent') return Response.json({ model: 'gpt-6-luna', instructions: 'Saved agent' });
    if (path === '/v1/responses/input_tokens') return Response.json({ object: 'response.input_tokens', input_tokens: 123 });
    if (path === '/v1/responses' && method === 'POST') return Response.json({ id: 'resp_known', status: 'queued', model: 'gpt-6-luna' });
    if (path === '/v1/responses/resp_known') {
      if (interrupt) { interrupt = false; throw new Error('offline interruption'); }
      return Response.json({ id: 'resp_known', status: 'completed', model: 'gpt-6-luna', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer }] }] });
    }
    throw new Error(`Unexpected offline request ${method} ${path}`);
  });
  const client = new ControlledResponsesClient('offline-key', 'agent', transport);
  const capture = (partial = false) => readPrimaryDocument(captureInput, { resolver, fetcher,
    ...(partial ? { inspect: async () => ({ text: 'not evidence', totalPages: 2, parsedPages: 1, truncated: true }) } : {}) });
  const prepare = (receipt: Awaited<ReturnType<typeof capture>>) => client.prepare({ message: 'Question', history: [], prefetch, webSearchReceipt: receipt });
  beforeEach(() => { requests.length = 0; transport.mockClear(); interrupt = false; vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected global network'); })); });
  afterEach(() => vi.unstubAllGlobals());

  it.each([false, true])('sends complete genuine PDF in count and submission, partial inspection %s', async partial => {
    const receipt = await capture(partial);
    expect(receipt.status).toBe(partial ? 'partial' : 'ok');
    const plan = await prepare(receipt);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.request.input)).toBe(true);
    expect(plan.inputTokens).toBe(123);
    expect(plan.reserveTokens).toBe(128123);
    await client.submit(plan, 'key');
    const count = requests.find(r => r.path.endsWith('/input_tokens'));
    const submit = requests.find(r => r.path === '/v1/responses');
    expect(count?.body?.input).toEqual(submit?.body?.input);
    const messages = inputSchema.parse(submit?.body?.input);
    const fileParts = messages.flatMap(m => m.content.filter(p => p.type === 'input_file'));
    expect(fileParts).toHaveLength(1);
    const file = fileParts[0];
    expect(Buffer.from(file.file_data.slice('data:application/pdf;base64,'.length), 'base64')).toEqual(Buffer.from(bytes));
    const metadata = messages.flatMap(m => m.content.filter(p => p.type === 'input_text')).find(p => p.text.includes('untrusted_primary_document_data'));
    expect(metadata?.text).toContain('untrusted_primary_document_data');
    expect(metadata?.text).not.toContain(file.file_data);
    const result = await client.wait(plan, 'resp_known');
    expect(result.contextReceipt.manifest_scope).toBe('initial_original_cards_and_primary_documents');
    expect(result.contextReceipt.primary_evidence).toEqual(plan.manifest.primary_evidence);
    expect(JSON.stringify(result.contextReceipt)).not.toContain(file.file_data);
  }, 15000);

  it('rejects malformed evidence and aggregate count before any provider request', async () => {
    const receipt = await capture();
    if (receipt.document.state !== 'available') throw new Error('fixture unavailable');
    const bad = [ { ...receipt, unexpected: true }, { ...receipt, document: { ...receipt.document, data_url: 'bad' } },
      { ...receipt, document: { ...receipt.document, sha256: 'a'.repeat(64) } } ];
    for (const value of bad) {
      await expect(client.prepare({ message: 'Question', history: [], prefetch, webSearchReceipt: value })).rejects.toThrow();
      expect(requests).toHaveLength(0);
    }
    await expect(client.prepare({ message: 'Question', history: [], prefetch, priorWebSearchReceipts: [receipt, receipt, receipt, receipt], webSearchReceipt: receipt })).rejects.toThrow();
    expect(requests).toHaveLength(0);
  }, 15000);

  it('rejects re-signed altered primary parts before POST', async () => {
    const plan = await prepare(await capture());
    const proofSchema = z.array(z.object({ response_id: z.string(), receipt_sha256: z.string(), source_sha256: z.string().nullable(), input_message_index: z.number() }).strict());
    const changes: ((p: ControlledRequest) => void)[] = [
      p => { delete p.manifest.primary_evidence; },
      p => { const messages = inputSchema.parse(p.request.input); const proof = proofSchema.parse(p.manifest.primary_evidence)[0]; messages[proof.input_message_index].content.push({ type: 'input_file', filename: 'extra.pdf', file_data: 'data:application/pdf;base64,WA==' }); p.request.input = messages; },
      p => { const proofs = proofSchema.parse(p.manifest.primary_evidence); proofs.push({ ...proofs[0] }); p.manifest.primary_evidence = proofs; },
      p => { const proofs = proofSchema.parse(p.manifest.primary_evidence); proofs.push({ ...proofs[0], response_id: 'different' }); p.manifest.primary_evidence = proofs; },
      p => { const proofs = proofSchema.parse(p.manifest.primary_evidence); proofs[0].source_sha256 = 'a'.repeat(64); p.manifest.primary_evidence = proofs; },
      ...(['filename', 'file_data'] as const).map(field => (p: ControlledRequest) => { const messages = inputSchema.parse(p.request.input); const proof = proofSchema.parse(p.manifest.primary_evidence)[0]; const file = messages[proof.input_message_index].content.find(item => item.type === 'input_file'); if (!file || file.type !== 'input_file') throw new Error('missing file'); file[field] += 'x'; p.request.input = messages; }),
      p => { const messages = inputSchema.parse(p.request.input); const proof = proofSchema.parse(p.manifest.primary_evidence)[0]; const text = messages[proof.input_message_index].content.find(item => item.type === 'input_text'); if (!text || text.type !== 'input_text') throw new Error('missing metadata'); text.text = text.text.replace('Read the manual', 'Altered'); p.request.input = messages; }
    ];
    for (const change of changes) { const modified = structuredClone(plan); change(modified); resign(modified); await expect(client.submit(modified, 'key')).rejects.toThrow(); }
    expect(requests.filter(r => r.path === '/v1/responses')).toHaveLength(0);
  }, 15000);

  it.each([false, true])('rejects unmanifested primary metadata even without a file, unavailable %s', async unavailable => {
    const receipt = unavailable ? unavailablePrimaryDocument(captureInput, 'size') : await capture(true);
    const modified = structuredClone(await prepare(receipt));
    delete modified.manifest.primary_evidence;
    const messages = inputSchema.parse(modified.request.input);
    for (const message of messages) message.content = message.content.filter(item => item.type !== 'input_file');
    modified.request.input = messages;
    resign(modified);
    await expect(client.submit(modified, 'key')).rejects.toThrow();
    expect(requests.filter(item => item.path === '/v1/responses')).toHaveLength(0);
  });

  it.each(['ids', 'empty-review', 'review-without-message'])('rejects a spoofed classification offset hiding a primary source: %s', async mode => {
    const modified = structuredClone(await prepare(unavailablePrimaryDocument(captureInput, 'size')));
    delete modified.manifest.primary_evidence;
    modified.manifest.classification_ids = mode === 'review-without-message' ? ['foreign'] : [];
    modified.manifest.research_input_start = 4;
    if (mode === 'empty-review') Object.assign(modified, { review: {} });
    if (mode === 'review-without-message') Object.assign(modified, { review: { context: { candidate_ids: ['foreign'] } } });
    resign(modified);
    await expect(client.submit(modified, 'key')).rejects.toThrow();
    expect(requests.filter(item => item.path === '/v1/responses')).toHaveLength(0);
  });

  it.each(['plain', 'classification', 'review'] as const)('keeps buyer protocol-shaped JSON separate from source metadata in %s mode', async mode => {
    const id = 'a'.repeat(24);
    const original = { id, name: 'Fixture item', note: 'Полная карточка 🛠 без потери.' };
    const catalog = { source_revision: 'revision', completeness: 'full' as const, items: [{ product_id: id,
      source_revision: 'revision', name: 'Fixture item', attributes: {}, description: 'Original', documents: [], original_card: original }] };
    const question = JSON.stringify({ kind: 'untrusted_primary_document_data', receipt: { customer_example: true } });
    const context = reviewContext([id], catalog, question, []);
    const base = acceptCatalogReview(JSON.stringify({ answer: 'Initial', candidate_decisions: {
      [id]: { product_name: 'Fixture item', basis: 'Fixture', decision: 'uncertain' }
    } }), context, [], 'resp_base').state;
    const receipt = await capture(true);
    const plan = await client.prepare({ message: question, history: [], prefetch: catalog, webSearchReceipt: receipt,
      ...(mode === 'plain' ? {} : { classificationIds: [id] }), ...(mode === 'review' ? { catalogReview: base } : {}) });
    expect(plan.prefetch.items[0].original_card).toEqual(original);
    expect(plan.manifest.product_ids).toEqual([id]);
    await expect(client.submit(plan, 'key')).resolves.toBe('resp_known');
  });

  it('executes legacy canonical and raw JSON plans without primary evidence', async () => {
    const plan = structuredClone(await client.prepare({ message: 'Question', history: [], prefetch, webSearchReceipt: search }));
    delete plan.manifest.research_input_start;
    resign(plan);
    await expect(client.submit(plan, 'key')).resolves.toBe('resp_known');
    const legacy = structuredClone(plan);
    delete legacy.manifest.hash_format;
    const raw = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    legacy.manifest.request_sha256 = raw(legacy.request); legacy.manifest.prefetch_sha256 = raw(legacy.prefetch);
    const { plan_sha256: _excluded, ...manifest } = legacy.manifest;
    legacy.manifest.plan_sha256 = raw({ ...legacy, manifest });
    await expect(client.submit(legacy, 'key')).resolves.toBe('resp_known');
    expect(requests.filter(r => r.path === '/v1/responses')).toHaveLength(2);
  });

  it('recovers a known response with GET only and rejects substituted context and missing binding', async () => {
    const receipt = await capture();
    const input = { sessionId: 'session', turnId: 'turn', ownerId: 'owner', message: 'Question', history: [], prefetch, receipt };
    let saved: WebContinuationCheckpoint | undefined;
    const conversations = { upsertTurnCheckpoint: vi.fn(async (entry: { payload: WebContinuationCheckpoint }) => { saved = structuredClone(entry.payload); }) } as unknown as ConversationRepository;
    interrupt = true;
    await expect(continueAfterWebSearch(input, { client, conversations })).rejects.toThrow();
    if (!saved) throw new Error('missing checkpoint');
    const checkpoint: WebContinuationCheckpoint = saved;
    expect(checkpoint.responseId).toBe('resp_known');
    const before = requests.length;
    for (const changed of [{ ...input, message: 'Other' },
      { ...input, history: [{ id: 'foreign', sessionId: 'session', role: 'user' as const, content: 'Other', metadata: {}, createdAt: '2026-11-15T00:00:00.000Z' }] },
      { ...input, prefetch: { ...prefetch, source_revision: 'other' } },
      { ...input, receipt: { ...receipt, source: { ...receipt.source, intent_response_id: 'other' } } }]) {
      await expect(continueAfterWebSearch(changed, { client, conversations }, checkpoint)).rejects.toThrow();
    }
    const unbound = structuredClone(checkpoint); delete unbound.version; delete unbound.contextDigest;
    await expect(continueAfterWebSearch(input, { client, conversations }, unbound)).rejects.toThrow();
    const substitutedPlan = structuredClone(checkpoint);
    substitutedPlan.plan.request.instructions = String(substitutedPlan.plan.request.instructions) + '\nDifferent prepared request.';
    resign(substitutedPlan.plan);
    await expect(continueAfterWebSearch(input, { client, conversations }, substitutedPlan)).rejects.toThrow('context changed');
    const unknown = { ...checkpoint, responseId: null };
    await expect(continueAfterWebSearch(input, { client, conversations }, unknown)).rejects.toThrow('outcome is unknown');
    expect(requests.length).toBe(before);
    await expect(continueAfterWebSearch(input, { client, conversations }, checkpoint)).resolves.toMatchObject({ turnId: 'resp_known' });
    expect(requests.slice(before).map(r => [r.method, r.path])).toEqual([['GET', '/v1/responses/resp_known']]);
  }, 15000);

  it('accepts a genuine legacy unbound checkpoint without preparing or posting again', async () => {
    const plan = await client.prepare({ message: 'Question', history: [], prefetch, webSearchReceipt: search });
    const saved: WebContinuationCheckpoint = { sessionId: 'session', turnId: 'turn', searchResponseId: search.responseId,
      attempted: true, responseId: 'resp_known', reservationId: 'reservation', plan };
    const input = { sessionId: 'session', turnId: 'turn', ownerId: 'owner', message: 'Question', history: [], prefetch, receipt: search };
    const conversations = { upsertTurnCheckpoint: vi.fn() } as unknown as ConversationRepository;
    const before = requests.length;
    await expect(continueAfterWebSearch(input, { client, conversations }, saved)).resolves.toMatchObject({ turnId: 'resp_known' });
    expect(requests.slice(before).map(r => [r.method, r.path])).toEqual([['GET', '/v1/responses/resp_known']]);
    expect(conversations.upsertTurnCheckpoint).not.toHaveBeenCalled();
  });

  it('preserves legacy source digest in mixed sources', async () => {
    const receipt = await capture();
    expect(reviewSources([search, receipt])[0]).toEqual(reviewSources([search])[0]);
    expect(reviewSources([search])[0]).toEqual({ response_id: search.responseId, digest: reviewDigest(search) });
  }, 15000);
});
