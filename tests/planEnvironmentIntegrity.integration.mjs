import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { expandPlan, verifyPlanEvidence } = require('../evals/acceptance/plan-evidence.cjs');
const root = await mkdtemp(join(tmpdir(), 'bakaut-v4-evidence-'));
const artifactText = 'actual integration receipt\n';
await writeFile(join(root, 'receipt.log'), artifactText);
const digest = createHash('sha256').update(artifactText).digest('hex');

const plan = {
  plan_id: 'environment-integrity',
  cases: [
    { id: 'Y12', levels: ['I'], owner: 'K01' },
    { id: 'Y14', levels: ['I'], owner: 'K08' }
  ],
  mandatory_variants: {
    Y12: ['hidden-mock', 'worker-disabled', 'provider-unavailable'],
    Y14: ['missing-variant', 'wrong-level-or-setup', 'valid-evidence-reuse']
  },
  variant_level_overrides: {}
};
const cells = expandPlan(plan).map(cell => ({ ...cell, status: 'PASS', receiptIds: ['integration'] }));
const receipt = {
  id: 'integration', level: 'I', status: 'PASS', exitCode: 0,
  configurationHash: 'current-config', codeFingerprint: 'current-code',
  coverage: cells.map(({ case_id, variant_id, level }) => ({ case_id, variant_id, level })),
  setup: {
    declaredMode: 'integration', actualMode: 'integration', criticalPathMocked: false,
    capabilities: { worker: true, provider: true }
  },
  artifacts: [{ path: 'receipt.log', sha256: digest }]
};
const verify = (actualCells = cells, actualReceipt = receipt) => verifyPlanEvidence(plan, {
  plan_id: plan.plan_id, cells: structuredClone(actualCells), receipts: [structuredClone(actualReceipt)]
}, { artifactRoot: root, configurationHash: 'current-config', codeFingerprint: 'current-code' });

try {
  assert.equal(verify().status, 'PASS', 'one actual artifact may cover several explicitly asserted variants');

  const missing = cells.filter(cell => cell.variant_id !== 'missing-variant');
  assert.equal(verify(missing).status, 'FAIL', 'an omitted mandatory variant is never inferred from a family label');

  for (const mutate of [
    value => { value.setup.criticalPathMocked = true; },
    value => { value.setup.capabilities.worker = false; value.requiredCapabilities = ['worker']; },
    value => { value.setup.capabilities.provider = false; value.requiredCapabilities = ['provider']; },
    value => { value.setup.actualMode = 'offline'; },
    value => { value.configurationHash = 'stale'; }
  ]) {
    const changed = structuredClone(receipt); mutate(changed);
    assert.equal(verify(cells, changed).status, 'FAIL');
  }

  const providerUnavailableCells = structuredClone(cells);
  providerUnavailableCells.find(cell => cell.case_id === 'Y12' && cell.variant_id === 'provider-unavailable').status = 'NOT_RUN';
  assert.equal(verify(providerUnavailableCells).status, 'INCOMPLETE', 'provider unavailability remains visible instead of becoming a mocked PASS');
  console.log(JSON.stringify({ status: 'PASS', level: 'I', checks: [
    'Y12/hidden-mock', 'Y12/worker-disabled', 'Y12/provider-unavailable',
    'Y14/missing-variant', 'Y14/wrong-level-or-setup', 'Y14/valid-evidence-reuse'
  ], filesystem: 'actual temporary artifact bytes', providerCalls: 0 }));
} finally {
  await rm(root, { recursive: true, force: true });
}
