'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), { createHash } = require('node:crypto');
const { expandPlan, verifyPlanEvidence } = require('../../evals/acceptance/plan-evidence.cjs');
const plan = { plan_id: 'bounded-plan', cases: [{ id: 'case', levels: ['D', 'I'], owner: 'K08' }],
  mandatory_variants: { case: ['first', 'second'] }, variant_level_overrides: { case: { second: ['I'] } } };
function fixture() {
  const cells = expandPlan(plan).map(cell => ({ ...cell, status: 'PASS', receiptIds: [cell.level] }));
  const artifacts = [{ path: 'raw/pass.log', sha256: createHash('sha256').update('executed assertions').digest('hex') }];
  const receipts = ['D', 'I'].map(level => ({ id: level, level, status: 'PASS', exitCode: 0, configurationHash: 'config', codeFingerprint: 'code',
    coverage: cells.filter(cell => cell.level === level), artifacts,
    setup: { declaredMode: level === 'D' ? 'offline' : 'integration', actualMode: level === 'D' ? 'offline' : 'integration', criticalPathMocked: false } }));
  return { plan_id: plan.plan_id, cells, receipts };
}
const verify = evidence => verifyPlanEvidence(plan, evidence, { artifactRoot: process.cwd(), configurationHash: 'config', codeFingerprint: 'code', readArtifact: () => Buffer.from('executed assertions') });
test('expands mandatory variants and their exact level overrides', () => assert.equal(expandPlan(plan).length, 3));
test('accepts explicit reuse only when the actual receipt covers both variants', () => assert.equal(verify(fixture()).status, 'PASS'));
test('rejects a missing variant even if all remaining cells pass', () => { const e = fixture(); e.cells.pop(); assert.equal(verify(e).status, 'FAIL'); });
test('rejects incorrect level, hidden mocks and stale configuration', () => {
  for (const mutate of [r => { r.level = 'D'; }, r => { r.setup.actualMode = 'offline'; },
    r => { r.setup.criticalPathMocked = true; }, r => { r.configurationHash = 'old'; }, r => { r.codeFingerprint = 'old'; }]) {
    const e = fixture(); mutate(e.receipts[1]); assert.equal(verify(e).status, 'FAIL');
  }
});
test('rejects receipt reuse for a variant that its assertions did not cover', () => { const e = fixture(); e.receipts[1].coverage.pop(); assert.equal(verify(e).status, 'FAIL'); });
test('rejects disabled required workers and altered or escaped raw artifacts', () => {
  for (const mutate of [r => { r.requiredCapabilities = ['worker']; r.setup.capabilities = { worker: false }; },
    r => { r.requiredCapabilities = ['provider']; r.setup.capabilities = { provider: false }; },
    r => { r.artifacts[0].sha256 = 'invented'; }, r => { r.artifacts[0].path = '../outside.log'; }]) {
    const e = fixture(); mutate(e.receipts[1]); assert.equal(verify(e).status, 'FAIL');
  }
});
test('preserves NOT_RUN as incomplete and never substitutes D evidence for S or L', () => {
  const e = fixture(); e.cells[0].status = 'NOT_RUN'; assert.equal(verify(e).status, 'INCOMPLETE');
  for (const level of ['S', 'L']) {
    const semanticPlan = { ...plan, cases: [{ id: 'case', levels: [level] }], mandatory_variants: {}, variant_level_overrides: {} };
    const cell = { case_id: 'case', variant_id: 'default', level, status: 'PASS', receiptIds: ['D'] };
    const evidence = fixture(); evidence.cells = [cell]; evidence.receipts[0].level = level; evidence.receipts[0].coverage = [cell];
    assert.equal(verifyPlanEvidence(semanticPlan, evidence, { artifactRoot: process.cwd(), configurationHash: 'config', codeFingerprint: 'code', readArtifact: () => Buffer.from('executed assertions') }).status, 'FAIL');
  }
});
