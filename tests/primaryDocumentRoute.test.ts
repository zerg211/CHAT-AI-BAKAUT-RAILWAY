import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Message } from '../src/shared/types.js';
import type { SearchCheckpoint } from '../src/ai/controlledWebSearch.js';
import type { ConversationRepository as Repository } from '../src/db/repositories.js';
import type { PrimaryDocumentIntent } from '../src/ai/primaryDocumentEvidence.js';

const state = vi.hoisted(() => ({ initial: vi.fn(), capture: vi.fn(), query: vi.fn(), commit: vi.fn(), usage: vi.fn(),
  save: vi.fn(), checkpoints: vi.fn(), messages: vi.fn(), webSubmit: vi.fn(), webRead: vi.fn(), webRecord: vi.fn() }));
vi.mock('../src/config.js', () => ({ config: { OPENAI_API_KEY: 'offline-key', OPENAI_PLATFORM_AGENT_ID: 'offline-agent',
  BAKAUT_CATALOG_URL: 'https://catalog-search-production.up.railway.app', BAKAUT_MCP_TOKEN: 'offline-catalog-token',
  CONTROLLED_WEB_SEARCH_ENABLED: true, CONTROLLED_WEB_SEARCH_FEES_APPROVED: true, OPENAI_MONETARY_GUARD_ENABLED: false } }));
vi.mock('../src/db/pool.js', () => ({ pool: { query: state.query,
  connect: async () => ({ query: state.query, release: () => undefined }) } }));
vi.mock('../src/db/repositories.js', () => ({ ConversationRepository: class {
  getTurn = async () => ({ id: 'turn', status: 'answering', deadlineAt: null });
  getSession = async () => ({ id: 'chat', status: 'active', needState: {} });
  claimTurnExecution = async () => ({ id: 'turn' });
  renewTurnExecution = async () => undefined;
  releaseTurnExecution = async () => undefined;
  listMessages = state.messages;
  listTurnCheckpoints = state.checkpoints;
  upsertTurnCheckpoint = state.save;
  addAssistantMessageForTurn = state.commit;
}, LeadRepository: class {} }));
vi.mock('../src/ai/platformAgentClient.js', async () => ({
  ...await vi.importActual<typeof import('../src/ai/platformAgentClient.js')>('../src/ai/platformAgentClient.js'),
  PlatformAgentClient: class { run = state.initial; }
}));
vi.mock('../src/ai/primaryDocumentEvidence.js', async () => ({
  ...await vi.importActual<typeof import('../src/ai/primaryDocumentEvidence.js')>('../src/ai/primaryDocumentEvidence.js'),
  readPrimaryDocument: state.capture
}));
vi.mock('../src/ai/fullCatalogClient.js', async () => ({
  ...await vi.importActual<typeof import('../src/ai/fullCatalogClient.js')>('../src/ai/fullCatalogClient.js'),
  readExactMentionPrefetch: async () => null
}));
vi.mock('../src/ai/openaiUsageGuard.js', () => ({ assertOpenAIUsageBudget: async () => 'reservation',
  bindOpenAIUsageReservation: () => undefined, recordOpenAIUsageOnce: state.usage,
  releaseOpenAIUsageReservation: async () => undefined,
  currentOpenAIUsageContext: () => ({ sessionId: 'chat', turnId: 'turn' }) }));
vi.mock('../src/ai/controlledWebSearchProvider.js', () => ({ ControlledWebSearchProvider: class {
  submit = state.webSubmit; read = state.webRead;
} }));
vi.mock('../src/ai/controlledWebSearchLedger.js', () => ({ controlledWebSearchLedger:
  (input: { sessionId: string; turnId: string; ownerId: string; conversations: Repository }) => ({
    reserve: async () => 'search-reservation', recordUsage: state.webRecord,
    saveCheckpoint: async (payload: SearchCheckpoint) => input.conversations.upsertTurnCheckpoint({
      sessionId: input.sessionId, turnId: input.turnId, executionOwner: input.ownerId,
      checkpoint: payload.step ? `controlled_web_search:${payload.step}` : 'controlled_web_search', status: 'running', payload })
  }) }));

import { PlatformAgentAssistant } from '../src/ai/platformAgentAssistant.js';
import { ConversationRepository } from '../src/db/repositories.js';
import { config } from '../src/config.js';
import { primaryDocumentIntentSchema, unavailablePrimaryDocument, validatePrimaryDocumentReceipt } from '../src/ai/primaryDocumentEvidence.js';
import { outputFormat } from '../src/ai/platformAgentContract.js';

type CaptureInput = Parameters<typeof unavailablePrimaryDocument>[0];
const documentIntent = (suffix = 'one'): PrimaryDocumentIntent => ({ kind: 'primary_document',
  url: `https://source.example.test/${suffix}.pdf`, page_indexes: [0], rationale: 'Прочитать выбранный документ.' });
const answer = (intent: unknown) => ({ answer_contract: 'consultation_receipt_v1', answer: intent ? 'Нужен источник.' : 'Доступные сведения проверены.',
  answer_review: { verdict: 'complete', publication: 'ready', rationale: 'Полезный ответ готов.' }, web_search_intent: intent,
  selected: [], rejected: [], uncertain: [], comparison_ids: [], recommendation_status: 'not_applicable', selection_snapshots: [], availability: null });
const available = (input: CaptureInput) => {
  const bytes = Buffer.from('%PDF-1.4\nroute fixture bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const base = unavailablePrimaryDocument(input, 'pending');
  return validatePrimaryDocumentReceipt({ ...base, status: 'ok', source: { ...base.source, final_url: input.intent.url,
    retrieved_at: '2026-11-15T00:00:00.000Z', sha256, byte_length: bytes.length },
    document: { state: 'available', data_url: `data:application/pdf;base64,${bytes.toString('base64')}`, sha256,
      byte_length: bytes.length, total_pages: 1, local_inspection: { parsed_pages: 1, truncated: false } } });
};

describe('agent-selected primary document route through the real controlled client', () => {
  const entries = new Map<string, Record<string, unknown>>();
  const requests: { path: string; method: string; body: Record<string, unknown> | undefined }[] = [];
  let replies: unknown[] = [];
  let submissions = 0;
  let interruptedReads = 0;
  let history: Message[] = [];
  const responseAnswers = new Map<string, unknown>();
  beforeEach(() => {
    vi.clearAllMocks();
    entries.clear(); requests.length = 0; replies = []; submissions = 0; interruptedReads = 0; history = []; responseAnswers.clear();
    Object.assign(config, { CONTROLLED_WEB_SEARCH_ENABLED: true, CONTROLLED_WEB_SEARCH_FEES_APPROVED: true });
    state.capture.mockReset().mockImplementation(async (input: CaptureInput) => available(input));
    state.initial.mockReset().mockResolvedValue({ sessionId: 'agent-session', turnId: 'resp_intent', model: 'gpt-6-luna',
      answer: JSON.stringify(answer(documentIntent())) });
    state.query.mockImplementation(async () => ({ rows: [{ agent_session_id: 'agent-session' }], rowCount: 1 }));
    state.commit.mockResolvedValue({ id: 'assistant-message' });
    state.messages.mockImplementation(async () => structuredClone(history));
    state.checkpoints.mockImplementation(async () => [...entries].map(([checkpoint, payload]) => ({ checkpoint, payload: structuredClone(payload) })));
    state.save.mockImplementation(async (entry: { checkpoint: string; payload: Record<string, unknown> }) => {
      entries.set(entry.checkpoint, structuredClone(entry.payload));
    });
    state.webSubmit.mockReset().mockResolvedValue('resp_search');
    state.webRead.mockReset().mockResolvedValue({ status: 'ok', responseId: 'resp_search', model: 'gpt-6-luna',
      usage: { total_tokens: 1 }, toolFees: null, findings: 'Источник найден.',
      sources: [{ url: documentIntent().url, title: 'Документ', excerpt: 'Источник' }] });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const path = url.pathname; const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? z.record(z.string(), z.unknown()).parse(JSON.parse(init.body)) : undefined;
      requests.push({ path, method, body });
      if (path === '/v1/agents/offline-agent') return Response.json({ model: 'gpt-6-luna', instructions: 'Offline saved agent.' });
      if (path === '/v1/responses/input_tokens') {
        const stage = entries.get('controlled_web_stage');
        if (stage?.mode === 'primary_document') {
          const step = typeof stage.step === 'number' ? stage.step : 0;
          expect(entries.has(step ? `controlled_primary_document:${step}` : 'controlled_primary_document')).toBe(true);
        }
        return Response.json({ object: 'response.input_tokens', input_tokens: 100 });
      }
      if (path === '/v1/responses' && method === 'POST') {
        expect([...entries.keys()].some(key => key.startsWith('controlled_primary_document')) || state.webSubmit.mock.calls.length > 0).toBe(true);
        const id = `resp_continued_${++submissions}`;
        responseAnswers.set(id, answer(replies.shift() ?? null));
        return Response.json({ id, status: 'queued', model: 'gpt-6-luna' });
      }
      if (path.startsWith('/v1/responses/resp_continued_') && method === 'GET') {
        if (interruptedReads > 0) { interruptedReads -= 1; throw new Error('offline interruption'); }
        const id = path.slice('/v1/responses/'.length);
        return Response.json({ id, model: 'gpt-6-luna', status: 'completed', usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
          output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(responseAnswers.get(id)) }] }] });
      }
      throw new Error(`Unexpected offline transport: ${method} ${path}`);
    }));
  });
  afterEach(() => vi.unstubAllGlobals());
  const generate = () => new PlatformAgentAssistant(new ConversationRepository()).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'Проверьте документ.' });
  const recover = () => new PlatformAgentAssistant(new ConversationRepository()).recoverTurn({ sessionId: 'chat', turnId: 'turn' });

  it('delivers an agent-emitted document intent after durable capture, without inventing search usage', async () => {
    const result = await generate();
    expect(result.usedWebSearch).toBe(false);
    expect(state.capture).toHaveBeenCalledOnce();
    expect(entries.get('controlled_web_stage')).toMatchObject({ mode: 'primary_document', intent: documentIntent() });
    expect(entries.get('controlled_primary_document')).toMatchObject({ intent: documentIntent(),
      receipt: { kind: 'primary_document', status: 'ok', source: { intent_response_id: 'resp_intent', discovery_response_ids: [] } } });
    const count = requests.find(request => request.path.endsWith('/input_tokens'));
    const submit = requests.find(request => request.path === '/v1/responses');
    expect(count?.body?.input).toEqual(submit?.body?.input);
    expect(JSON.stringify(submit?.body?.input)).toContain('input_file');
    expect(JSON.stringify(submit?.body?.input)).toContain('data:application/pdf;base64,');
    expect(state.webSubmit).not.toHaveBeenCalled();
    expect(state.webRecord).not.toHaveBeenCalled();
    expect(state.usage.mock.calls.every(([, , usage]) => !String(usage.id).startsWith('primary_doc_'))).toBe(true);
  });

  it('continues to another document after explicit unavailability', async () => {
    state.capture.mockImplementationOnce(async (input: CaptureInput) => unavailablePrimaryDocument(input, 'size'));
    replies = [documentIntent('two')];
    const result = await generate();
    expect(result.usedWebSearch).toBe(false);
    expect(state.capture).toHaveBeenCalledTimes(2);
    expect(entries.get('controlled_primary_document')).toMatchObject({ receipt: { status: 'unavailable', document: { reason: 'size' } } });
    expect(entries.get('controlled_primary_document:1')).toMatchObject({ intent: documentIntent('two'), receipt: { status: 'ok' } });
    expect(submissions).toBe(2);
    expect(JSON.stringify(requests.filter(request => request.path === '/v1/responses').at(1)?.body?.input)).toContain('size');
  });

  it('reuses the exact durable receipt and known response without recapture or another POST, even if acquisition is disabled', async () => {
    interruptedReads = 1;
    await expect(generate()).rejects.toThrow('transport outcome is unknown');
    const durable = structuredClone(entries.get('controlled_primary_document'));
    Object.assign(config, { CONTROLLED_WEB_SEARCH_ENABLED: false, CONTROLLED_WEB_SEARCH_FEES_APPROVED: false });
    const result = await recover();
    expect(result.usedWebSearch).toBe(false);
    expect(state.capture).toHaveBeenCalledOnce();
    expect(entries.get('controlled_primary_document')).toEqual(durable);
    expect(submissions).toBe(1);
    expect(requests.filter(request => request.path === '/v1/responses/resp_continued_1')).toHaveLength(2);
  });

  it('rejects changed source context before reusing a durable receipt', async () => {
    interruptedReads = 1;
    await expect(generate()).rejects.toThrow('transport outcome is unknown');
    history = [{ id: 'foreign', sessionId: 'chat', role: 'user', content: 'Другой вопрос.', metadata: {}, createdAt: '2026-11-15T00:00:00.000Z' }];
    await expect(recover()).rejects.toThrow('Saved primary document context changed');
    expect(state.capture).toHaveBeenCalledOnce();
    expect(submissions).toBe(1);
  });

  it('rejects changed intent ownership without recapturing the document', async () => {
    interruptedReads = 1;
    await expect(generate()).rejects.toThrow('transport outcome is unknown');
    const checkpoint = entries.get('controlled_primary_document');
    if (!checkpoint) throw new Error('Missing test checkpoint');
    const receipt = validatePrimaryDocumentReceipt(checkpoint.receipt);
    checkpoint.receipt = { ...receipt, source: { ...receipt.source, intent_response_id: 'resp_foreign' } };
    await expect(recover()).rejects.toThrow('Primary document receipt ownership changed');
    expect(state.capture).toHaveBeenCalledOnce();
    expect(submissions).toBe(1);
  });

  it('rejects a lost durable receipt after continuation has started instead of recapturing', async () => {
    interruptedReads = 1;
    await expect(generate()).rejects.toThrow('transport outcome is unknown');
    entries.delete('controlled_primary_document');
    await expect(recover()).rejects.toThrow('Saved primary document receipt is missing');
    expect(state.capture).toHaveBeenCalledOnce();
    expect(submissions).toBe(1);
  });

  it('returns explicit disabled evidence without acquisition', async () => {
    Object.assign(config, { CONTROLLED_WEB_SEARCH_ENABLED: false, CONTROLLED_WEB_SEARCH_FEES_APPROVED: false });
    expect((await generate()).usedWebSearch).toBe(false);
    expect(state.capture).not.toHaveBeenCalled();
    expect(entries.get('controlled_primary_document')).toMatchObject({ receipt: { status: 'unavailable', document: { reason: 'Primary document acquisition is disabled' } } });
    expect(JSON.stringify(requests.find(request => request.path === '/v1/responses')?.body?.input)).not.toContain('input_file');
  });

  it('preserves legacy query intents and links exact discovery URLs without treating documents as search calls', async () => {
    state.initial.mockResolvedValueOnce({ sessionId: 'agent-session', turnId: 'resp_initial', model: 'gpt-6-luna',
      answer: JSON.stringify(answer({ query: 'Документ модели', rationale: 'Найти источник.' })) });
    replies = [documentIntent()];
    expect((await generate()).usedWebSearch).toBe(true);
    expect(state.webSubmit).toHaveBeenCalledOnce();
    expect(state.webRecord).toHaveBeenCalledOnce();
    expect(state.capture).toHaveBeenCalledWith(expect.objectContaining({ intent: documentIntent(), intentResponseId: 'resp_continued_1',
      discoveryResponseIds: ['resp_search'] }), expect.objectContaining({ maxBytes: 8 * 1024 * 1024 }));
    expect(entries.get('controlled_primary_document:1')).toMatchObject({ receipt: { source: { discovery_response_ids: ['resp_search'] } } });
    expect(outputFormat.schema.properties.web_search_intent.anyOf[1]).toEqual({ type: 'object', additionalProperties: false,
      properties: { query: { type: 'string' }, rationale: { type: 'string' } }, required: ['query', 'rationale'] });
  });

  it('reports an exhausted document budget and still allows the agent to choose search', async () => {
    replies = [documentIntent('two'), documentIntent('three'), documentIntent('four'), documentIntent('five'),
      { query: 'Другой источник', rationale: 'PDF недоступен.' }];
    expect((await generate()).usedWebSearch).toBe(true);
    expect(state.capture).toHaveBeenCalledTimes(4);
    expect(entries.get('controlled_primary_document:4')).toMatchObject({ receipt: { status: 'unavailable', document: { reason: 'aggregate_limit' } } });
    expect(state.webSubmit).toHaveBeenCalledOnce();
    expect(entries.has('controlled_web_search:5')).toBe(true);
  });

  it('rejects malformed combined and unsupported document intents before capture', async () => {
    for (const intent of [{ ...documentIntent(), query: 'mixed' }, { ...documentIntent(), page_indexes: [-1] }]) {
      state.initial.mockResolvedValueOnce({ sessionId: 'agent-session', turnId: 'resp_intent', model: 'gpt-6-luna', answer: JSON.stringify(answer(intent)) });
      await expect(generate()).rejects.toThrow();
    }
    expect(state.capture).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect(primaryDocumentIntentSchema.safeParse(documentIntent()).success).toBe(true);
  });
});
