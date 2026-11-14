import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// This exporter must run in an empty working directory with a scrubbed environment.
if (process.env.BAKAUT_OFFLINE_EXPORT !== '1' || existsSync(path.resolve('.env'))) throw new Error('Offline export environment required');
const outputIndex = process.argv.indexOf('--output');
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
if (!outputPath || !path.isAbsolute(outputPath)) throw new Error('An absolute output path is required');
const scenarioIndex = process.argv.indexOf('--scenario');
const scenario = scenarioIndex >= 0 ? process.argv[scenarioIndex + 1] : undefined;
if (scenario !== 'shown_two' && scenario !== 'all_twelve') throw new Error('An explicit offline scenario is required');
globalThis.fetch = async () => { throw new Error('Network is forbidden in offline export'); };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/dpu6555-local-originals.json'), 'utf8'));
if (fixture.revision_kind !== 'fixture_not_live_catalog' || fixture.items.length !== 12) throw new Error('Invalid offline source fixture');
const batch = spawnSync('python', ['-X', 'utf8', '-B', path.join(root, 'tests/fixtures/dpu6555_batch.py')],
  { cwd: root, encoding: 'utf8', maxBuffer: 8_000_000 });
if (batch.status !== 0) throw new Error('Offline catalog fixture failed');
const page = JSON.parse(batch.stdout);
const { config } = await import('../src/config.js');
Object.assign(config, { BAKAUT_CATALOG_URL: 'https://catalog-search-production.up.railway.app', BAKAUT_MCP_TOKEN: 'offline-export-placeholder',
  CONTROLLED_WEB_SEARCH_ENABLED: false, CONTROLLED_WEB_SEARCH_FEES_APPROVED: false });
const { readFullKnownProducts } = await import('../src/ai/fullCatalogClient.js');
const { ControlledResponsesClient } = await import('../src/ai/controlledResponsesClient.js');
const ids = fixture.items.map((item: { product_id: string }) => item.product_id);
const prefetch = await readFullKnownProducts({ source_revision: fixture.revision, product_ids: ids }, undefined,
  async () => Response.json(page));
const calls: string[] = [];
const transport: typeof fetch = async (url, init) => {
  const endpoint = new URL(String(url)).pathname;
  const method = init?.method ?? 'GET';
  calls.push(`${method} ${endpoint}`);
  if (method === 'GET' && endpoint === '/v1/agents/offline-agent') return Response.json({ model: 'gpt-6-luna', instructions: 'OFFLINE MOCK SAVED AGENT INSTRUCTIONS',
    reasoning: { effort: 'medium' }, service_tier: 'default' });
  if (method === 'POST' && endpoint === '/v1/responses/input_tokens') return Response.json({ object: 'response.input_tokens', input_tokens: 1000 });
  throw new Error(`Unexpected offline provider endpoint: ${endpoint}`);
};
const firstQuestion = 'Есть виброплиты Wacker Neuson DPU 6555?';
const firstAnswer = 'Показываю две модификации DPU 6555. Наличие необходимо уточнить на складе.';
const currentQuestion = scenario === 'shown_two'
  ? 'В чём между ними разница и какие из них подойдут для траншеи шириной 700 мм?'
  : 'Чем отличаются все известные модификации DPU 6555 и какие подойдут для траншеи шириной 700 мм?';
const history = [
  { id: 'offline-user-1', sessionId: 'offline-session', role: 'user' as const, content: firstQuestion,
    createdAt: '2026-11-13T00:00:00Z', metadata: {} },
  { id: 'offline-assistant-1', sessionId: 'offline-session', role: 'assistant' as const, content: firstAnswer,
    createdAt: '2026-11-13T00:00:01Z', metadata: { knownProducts: { source_revision: fixture.revision, product_ids: ids },
      productCards: ids.slice(0, 2).map((id: string) => ({ id })) } },
  { id: 'offline-user-2', sessionId: 'offline-session', role: 'user' as const, content: currentQuestion,
    createdAt: '2026-11-13T00:00:02Z', metadata: {} }
];
const client = new ControlledResponsesClient('offline-provider-placeholder', 'offline-agent', transport);
const plan = await client.prepare({ message: currentQuestion, history, prefetch });
if (calls.join(',') !== 'GET /v1/agents/offline-agent,POST /v1/responses/input_tokens') throw new Error('Unexpected provider calls');
const requestJson = JSON.stringify(plan.request);
if (['offline-provider-placeholder', 'offline-export-placeholder'].some(value => requestJson.includes(value))) throw new Error('Credential placeholder leaked');
const artifact = { kind: 'offline_runtime_request_export', scenario, live_model_quality: 'NOT_RUN', live_provider: 'NOT_RUN',
  source: { label: fixture.source, revision: fixture.revision, revision_kind: fixture.revision_kind,
    originals: fixture.items.map((item: { product_id: string; source_file: string; source_sha256: string }) => ({
      product_id: item.product_id, source_file: item.source_file, source_sha256: item.source_sha256 })) },
  mock_context: { history_is_synthetic: true, saved_agent_metadata_is_mock: true, token_count_is_mock: true,
    mocked_token_count: plan.inputTokens, provider_calls: calls,
    generation_posts: calls.filter(call => call === 'POST /v1/responses').length, credentials_exported: false },
  runtime_request_sha256: createHash('sha256').update(requestJson).digest('hex'), request: plan.request };
const serialized = JSON.stringify(artifact, null, 2) + '\n';
writeFileSync(outputPath, serialized, 'utf8');
console.log(JSON.stringify({ artifact: outputPath, artifact_sha256: createHash('sha256').update(serialized).digest('hex'),
  request_sha256: artifact.runtime_request_sha256, original_count: ids.length, live: 'NOT_RUN' }));
