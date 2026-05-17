import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function runGate(env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    "import { requireProductionLiveApproval } from './tests/productionLiveGate.mjs'; requireProductionLiveApproval({ scriptName: 'test fixed replay' }); console.log('allowed');"
  ], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

describe('production live gate', () => {
  it('blocks production live scripts by default', () => {
    const result = runGate({
      ALLOW_PRODUCTION_LIVE_TESTS: undefined,
      FINAL_RELEASE_LIVE_GATE: undefined,
      ALLOW_FIXED_PRODUCTION_REPLAY: undefined
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('production_live_tests_not_explicitly_approved');
  });

  it('requires fixed replay approval even after final gate approval', () => {
    const result = runGate({
      ALLOW_PRODUCTION_LIVE_TESTS: '1',
      FINAL_RELEASE_LIVE_GATE: '1',
      ALLOW_FIXED_PRODUCTION_REPLAY: undefined
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('fixed_replay_not_approved');
  });

  it('allows explicitly approved final fixed replay scripts', () => {
    const result = runGate({
      ALLOW_PRODUCTION_LIVE_TESTS: '1',
      FINAL_RELEASE_LIVE_GATE: '1',
      ALLOW_FIXED_PRODUCTION_REPLAY: '1'
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('allowed');
  });
});
