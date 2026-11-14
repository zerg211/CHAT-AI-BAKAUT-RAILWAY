import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('offline DPU runtime request export', () => {
  it.each(['shown_two', 'all_twelve'] as const)('exports %s as a second request with synthetic history and mocked metadata and counter', scenario => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const tmpRoot = path.resolve(os.tmpdir());
    const dir = mkdtempSync(path.join(tmpRoot, 'dpu-export-'));
    const output = path.join(dir, 'request.json');
    try {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR, TEMP: dir, TMP: dir, BAKAUT_OFFLINE_EXPORT: '1' };
      const child = spawnSync(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'),
        path.join(root, 'scripts/export_dpu_runtime_request.ts'), '--scenario', scenario, '--output', output], { cwd: dir, env, encoding: 'utf8', maxBuffer: 5_000_000 });
      expect(child.status, child.stderr).toBe(0);
      const summary = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
      const bytes = readFileSync(output);
      const artifact = JSON.parse(bytes.toString('utf8'));
      expect(summary.artifact_sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(artifact.runtime_request_sha256).toBe(createHash('sha256').update(JSON.stringify(artifact.request)).digest('hex'));
      expect(artifact).toMatchObject({ scenario, live_model_quality: 'NOT_RUN', live_provider: 'NOT_RUN',
        mock_context: { history_is_synthetic: true, saved_agent_metadata_is_mock: true, token_count_is_mock: true,
          provider_calls: ['GET /v1/agents/offline-agent', 'POST /v1/responses/input_tokens'], generation_posts: 0, credentials_exported: false } });
      const fixture = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/dpu6555-local-originals.json'), 'utf8'));
      expect(artifact.source.revision).toBe(fixture.revision);
      expect(artifact.source.originals).toHaveLength(12);
      const messages = artifact.request.input.map((message: { content: Array<{ text: string }> }) => message.content.map(part => part.text).join(''));
      expect(messages[0]).toContain('Есть виброплиты Wacker Neuson DPU 6555?');
      expect(messages[0]).toContain('Наличие необходимо уточнить на складе.');
      expect(messages[2]).toContain('траншеи шириной 700 мм');
      expect(messages[2]).toContain(scenario === 'shown_two' ? 'между ними' : 'все известные модификации');
      const savedHistory = JSON.parse(messages[0].slice(messages[0].indexOf('[')));
      expect(savedHistory.find((message: { role: string }) => message.role === 'assistant').shown_product_ids)
        .toEqual(fixture.items.slice(0, 2).map((item: { product_id: string }) => item.product_id));
      const delivered = JSON.parse(messages[1].slice(messages[1].indexOf('{')));
      expect(delivered.products).toHaveLength(12);
      for (let i = 0; i < 12; i++) expect(delivered.products[i].original_card).toEqual(fixture.items[i].original);
      expect(artifact.request.text.format.schema.required).toEqual(expect.arrayContaining(['answer_review', 'web_search_intent', 'availability',
        'comparison_ids', 'recommendation_status']));
      expect(artifact.request.text.format.schema.properties.answer_review.required).toContain('publication');
      expect(artifact.request.tools[0]).toMatchObject({ type: 'mcp', server_label: 'bakaut_catalog' });
      expect(artifact.request.tools[0]).not.toHaveProperty('authorization');
      expect(artifact.request.truncation).toBe('disabled');
      expect(bytes.toString('utf8')).not.toContain('offline-provider-placeholder');
      expect(bytes.toString('utf8')).not.toContain('offline-export-placeholder');
      const toy = spawnSync('python', ['-X', 'utf8', '-B', '-c',
        "import sys,json;sys.path.insert(0,'scripts');import adversarial_eval_runner as r;print(json.dumps(r.make_request(r.cases()[0]),ensure_ascii=False))"],
        { cwd: root, env, encoding: 'utf8', maxBuffer: 2_000_000 });
      expect(toy.status, toy.stderr).toBe(0);
      const toyRequest = JSON.parse(toy.stdout);
      expect(toyRequest).not.toHaveProperty('tools');
      expect(toyRequest).not.toHaveProperty('text');
      expect(toyRequest.input).toHaveLength(1);
      expect(messages).toHaveLength(3);
      expect(artifact.request.instructions).not.toBe(toyRequest.instructions);
      if (process.env.DPU_SAVE_RUNTIME_EXPORT === '1') {
        const name = scenario === 'shown_two' ? 'followup-runtime-shown-two.json' : 'followup-runtime-all-twelve.json';
        writeFileSync(path.join(root, '.agent/tasks/full-cards-availability-20261112/raw', name), bytes);
      }
    } finally {
      if (path.dirname(path.resolve(dir)) !== tmpRoot || !path.basename(dir).startsWith('dpu-export-')) throw new Error('Unexpected temporary path');
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('refuses a missing offline marker and a working directory containing an env file', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const tmpRoot = path.resolve(os.tmpdir());
    const dir = mkdtempSync(path.join(tmpRoot, 'dpu-export-'));
    const output = path.join(dir, 'must-not-exist.json');
    try {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR, TEMP: dir, TMP: dir };
      const args = [path.join(root, 'node_modules/tsx/dist/cli.mjs'), path.join(root, 'scripts/export_dpu_runtime_request.ts'),
        '--scenario', 'shown_two', '--output', output];
      expect(spawnSync(process.execPath, args, { cwd: dir, env, encoding: 'utf8' }).status).not.toBe(0);
      expect(existsSync(output)).toBe(false);
      writeFileSync(path.join(dir, '.env'), 'EXAMPLE=placeholder\n');
      expect(spawnSync(process.execPath, args, { cwd: dir, env: { ...env, BAKAUT_OFFLINE_EXPORT: '1' }, encoding: 'utf8' }).status).not.toBe(0);
      expect(existsSync(output)).toBe(false);
    } finally {
      if (path.dirname(path.resolve(dir)) !== tmpRoot || !path.basename(dir).startsWith('dpu-export-')) throw new Error('Unexpected temporary path');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
