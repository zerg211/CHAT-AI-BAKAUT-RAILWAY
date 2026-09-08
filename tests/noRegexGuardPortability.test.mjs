import { it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

it('preserves the same baseline across Git LF/CRLF conversion but rejects a changed expression', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bakaut-regex-portability-'));
  const script = path.resolve('scripts/no-regex-guard.mjs');
  const run = (...args) => spawnSync(process.execPath, [script,...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NO_REGEX_BASELINE_PATH: 'scripts/no-regex-baseline.json' }
  });
  try {
    fs.mkdirSync(path.join(root,'src','ai'), { recursive: true }); fs.mkdirSync(path.join(root,'scripts'));
    const file = path.join(root,'src','ai','agentManagerOrchestrator.ts');
    const lines = ['const normalize = text => text', '  .trim()', '  .replace(/a/g, "b");'];
    fs.writeFileSync(file, lines.join('\r\n'));
    expect(run('--update-baseline').status).toBe(0);
    fs.writeFileSync(file, lines.join('\n'));
    expect(run().status).toBe(0);
    fs.writeFileSync(file, lines.join('\n').replace('/a/g','/c/g'));
    expect(run().status).toBe(1);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
