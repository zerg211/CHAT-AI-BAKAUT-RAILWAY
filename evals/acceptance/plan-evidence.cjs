'use strict';
const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
const key = cell => [cell.case_id, cell.variant_id, cell.level].join('/');
function expandPlan(plan) {
  return plan.cases.flatMap(item => (plan.mandatory_variants?.[item.id] || ['default']).flatMap(variant =>
    (plan.variant_level_overrides?.[item.id]?.[variant] || item.levels).map(level =>
      ({ case_id: item.id, variant_id: variant, level, owner: item.owner }))));
}
function verifyPlanEvidence(plan, evidence, options) {
  const expected = expandPlan(plan), errors = [], missing = [], accepted = [];
  if (evidence.plan_id !== plan.plan_id) errors.push('wrong_plan');
  const cells = new Map(), receipts = new Map();
  for (const cell of evidence.cells || []) {
    if (cells.has(key(cell))) errors.push('duplicate_cell:' + key(cell));
    cells.set(key(cell), cell);
  }
  for (const receipt of evidence.receipts || []) {
    if (!receipt.id || receipts.has(receipt.id)) errors.push('duplicate_or_missing_receipt_id');
    receipts.set(receipt.id, receipt);
  }
  const expectedKeys = new Set(expected.map(key));
  for (const actualKey of cells.keys()) if (!expectedKeys.has(actualKey)) errors.push('unexpected_cell:' + actualKey);
  const root = path.resolve(options.artifactRoot);
  function validReceipt(receipt, cell) {
    if (!receipt || receipt.exitCode !== 0 || receipt.status !== 'PASS' || receipt.level !== cell.level ||
      !(receipt.coverage || []).some(covered => key(covered) === key(cell))) return false;
    if (typeof options.configurationHash !== 'string' || !options.configurationHash ||
      typeof options.codeFingerprint !== 'string' || !options.codeFingerprint ||
      receipt.configurationHash !== options.configurationHash || receipt.codeFingerprint !== options.codeFingerprint) return false;
    const setup = receipt.setup || {};
    if (setup.declaredMode !== setup.actualMode) return false;
    if (cell.level === 'D' && setup.actualMode !== 'offline') return false;
    if (cell.level === 'I' && (setup.actualMode !== 'integration' || setup.criticalPathMocked !== false)) return false;
    if (cell.level === 'S' && (setup.actualMode !== 'semantic' || setup.providerMocked !== false || !(setup.providerCalls > 0))) return false;
    if (cell.level === 'L' && (setup.actualMode !== 'production_widget' || setup.providerMocked !== false ||
      setup.origin !== 'https://bakautprof.ru' || setup.adaptiveDialogueAudited !== true || setup.adminMetadataAudited !== true)) return false;
    for (const capability of receipt.requiredCapabilities || []) if (setup.capabilities?.[capability] !== true) return false;
    if (!receipt.artifacts?.length) return false;
    for (const artifact of receipt.artifacts) {
      if (typeof artifact.path !== 'string' || !artifact.path || path.isAbsolute(artifact.path)) return false;
      const resolved = path.resolve(root, artifact.path), relative = path.relative(root, resolved);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return false;
      try {
        const bytes = (options.readArtifact || fs.readFileSync)(resolved);
        if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) return false;
      } catch { return false; }
    }
    return true;
  }
  for (const expectedCell of expected) {
    const cell = cells.get(key(expectedCell));
    if (!cell) { errors.push('missing_cell:' + key(expectedCell)); continue; }
    if (cell.status !== 'PASS') { missing.push(key(cell)); continue; }
    if (!Array.isArray(cell.receiptIds) || !cell.receiptIds.length ||
      !cell.receiptIds.some(id => validReceipt(receipts.get(id), cell))) {
      errors.push('unproven_pass:' + key(cell)); continue;
    }
    accepted.push(key(cell));
  }
  return { status: errors.length ? 'FAIL' : missing.length ? 'INCOMPLETE' : 'PASS',
    expected: expected.length, accepted, missing, errors };
}
module.exports = { expandPlan, verifyPlanEvidence };
if (require.main === module) {
  const [planFile, evidenceFile] = process.argv.slice(2);
  if (!planFile || !evidenceFile) throw new Error('Usage: plan-evidence.cjs PLAN.json EVIDENCE.json');
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8')), evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  const verdict = verifyPlanEvidence(plan, evidence, { artifactRoot: path.dirname(evidenceFile),
    configurationHash: evidence.configurationHash, codeFingerprint: evidence.codeFingerprint });
  console.log(JSON.stringify(verdict, null, 2)); process.exitCode = verdict.status === 'PASS' ? 0 : 1;
}
