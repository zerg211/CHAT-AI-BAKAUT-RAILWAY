// Controlled mutations of application paths, never the evaluator. Isolated PostgreSQL only.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = new URL(process.env.DATABASE_URL || 'file:///missing');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.pathname.startsWith('/bakaut_acceptance_'));
const output = path.resolve(process.argv[2] || path.join(root, '.private/acceptance/production-mutations'));
fs.mkdirSync(output, { recursive: true });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const reports = [], backups = new Map();
function replaceOne(text, from, to) {
  assert.equal(text.split(from).length, 2, 'Mutation anchor must be unique');
  return text.replace(from, to);
}
const variants = [
  { id: 'UNKNOWN_USAGE_FREE', file: 'src/ai/openaiUsageGuard.ts', test: 'tests/usageReservation.integration.mjs',
    edit: text => replaceOne(text, 'if (reservationId && usage.totalTokens !== null)', 'if (reservationId)') },
  { id: 'UNKNOWN_RESERVE_EXPIRES_EARLY', file: 'src/ai/openaiUsageGuard.ts', test: 'tests/usageReservation.integration.mjs',
    edit: text => replaceOne(text, 'const reservationTtlMinutes = 24 * 60;', 'const reservationTtlMinutes = 15;') },
  { id: 'STALE_PAGE_BACKFILL', file: 'src/db/repositories.ts', test: 'tests/catalogPageRevision.integration.mjs',
    edit: text => replaceOne(text, 'source_content_hash = $5 AND is_active IS NOT FALSE', '$5::text=$5::text AND is_active IS NOT FALSE') },
  { id: 'PRICE_WRITER_GUARD', test: 'tests/priceWriterCoherence.integration.mjs', trigger: true },
  { id: 'STALE_PUBLICATION_LEASE', file: 'src/db/repositories.ts', test: 'tests/enrichmentPublication.integration.mjs', edit: text => {
    const start = text.indexOf('  async publishVerifiedFactEnrichmentGroup('), end = text.indexOf('  async upsertVerifiedProductFact(', start);
    assert.ok(start >= 0 && end > start);
    const section = text.slice(start, end); assert.equal(section.split('lease_token=$2').length, 4);
    return text.slice(0, start) + section.replaceAll('lease_token=$2', '$2::uuid=$2::uuid') + text.slice(end);
  } },
  { id: 'POISON_STOPS_BATCH', file: 'src/ai/knowledgeEnrichment.ts', test: 'tests/enrichmentPublication.integration.mjs',
    edit: text => replaceOne(text, 'if (handled.has(index)) continue;', "if (outcomes.some(item => item.status === 'rejected')) break;\n      if (handled.has(index)) continue;") },
  { id: 'NOOP_PUBLICATION', file: 'src/db/repositories.ts', test: 'tests/enrichmentPublication.integration.mjs',
    edit: text => replaceOne(text, 'const saved = await this.upsertVerifiedProductFact(fact, db);',
      'const saved = await Promise.resolve<VerifiedProductFact | null>(null);') },
  { id: 'DROP_PUBLIC_DISCOVERY', file: 'src/ai/productComparisonResearch.ts', test: 'tests/productComparisonResearch.test.ts', name: 'discovers and reads public company',
    edit: text => replaceOne(text, '  const sourceTextCache = createSourceTextCache();',
      "  if (input.products.length === 0) return { usedWebSearch: false, facts: [], conflicts: [], warnings: [], summaryForAnswer: '', answerGuidance: { directAnswer: '', completeness: 'not_answered', coverage: [] } };\n  const sourceTextCache = createSourceTextCache();") },
  { id: 'SOURCE_PREFIX_ONLY', file: 'src/ai/siteFirstParty.ts', test: 'tests/companyKnowledgePublication.integration.mjs',
    edit: text => replaceOne(text, 'const fullText = pdfText ?? extractReadableSourceText($);', 'const fullText = (pdfText ?? extractReadableSourceText($)).slice(0, 8000);') },
  { id: 'AMBIGUOUS_FIRST_ROW', file: 'src/db/repositories.ts', test: 'tests/exactIdentityCandidates.integration.mjs',
    edit: text => replaceOne(text, 'return candidates.length === 1 ? candidates[0]! : null;', 'return candidates.length >= 1 ? candidates[0]! : null;') },
  { id: 'DROP_MODEL_SOURCE_EVIDENCE', file: 'src/ai/agentManagerModelContext.ts', test: 'tests/productComparisonResearch.test.ts', name: 'discovers and reads public company',
    edit: text => replaceOne(text, 'return toolResults.map((result) => {', "return toolResults.map((result) => {\n    if (result.tool === 'web.researchProductFacts') return { ...result, payload: { ...result.payload, facts: [] } };") },
  { id: 'DELETE_DURING_ACCEPTANCE', file: 'src/db/repositories.ts', test: 'tests/sessionMaintenance.integration.mjs', edit: text => {
    const clause = "         AND s.last_heartbeat_at < now() - interval '30 minutes'";
    assert.equal(text.split(clause).length, 3); return text.replaceAll(clause, '');
  } },
  { id: 'OVERLAPPING_OUTBOX_BATCHES', file: 'src/ai/leadOutbox.ts', test: 'tests/leadHttpSinkLifecycle.integration.mjs',
    edit: text => replaceOne(text, 'if (stopped || inFlight) return;', 'if (stopped) return;') }
];
function run(variant, phase) {
  const args = variant.name ? [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', variant.test, '-t', variant.name] : ['--import', 'tsx', variant.test];
  const result = spawnSync(process.execPath, args, { cwd: root, env: { ...process.env, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 40000, maxBuffer: 4 * 1024 * 1024 });
  const raw = String(result.stdout || '') + String(result.stderr || '');
  fs.writeFileSync(path.join(output, `${variant.id}.${phase}.log`), raw);
  return { exit: result.status, assertion: raw.includes('AssertionError'), infrastructureError: Boolean(result.error) ||
    ['SyntaxError:', 'Cannot find module', 'TypeError:'].some(marker => raw.includes(marker)) };
}
process.on('exit', () => { for (const [file, original] of backups) fs.writeFileSync(file, original); });
try {
  const selected = process.argv[3] ? variants.filter(variant => process.argv[3].split(',').includes(variant.id)) : variants;
  assert.ok(selected.length, 'No matching mutation selected');
  for (const variant of selected) {
    const control = run(variant, 'control');
    if (control.exit !== 0) throw new Error(`${variant.id}: baseline control failed`);
    const file = variant.file ? path.join(root, variant.file) : null;
    if (file) { const original = fs.readFileSync(file, 'utf8'); backups.set(file, original); fs.writeFileSync(file, variant.edit(original)); }
    let mutant;
    try {
      if (variant.trigger) await pool.query('ALTER TABLE products DISABLE TRIGGER a_product_price_observation');
      mutant = run(variant, 'mutant');
    } finally {
      if (variant.trigger) await pool.query('ALTER TABLE products ENABLE TRIGGER a_product_price_observation');
      if (file) { fs.writeFileSync(file, backups.get(file)); backups.delete(file); }
    }
    const restored = run(variant, 'restored');
    const killed = mutant.exit === 1 && mutant.assertion && !mutant.infrastructureError && restored.exit === 0;
    reports.push({ id: variant.id, test: variant.test, control, mutant, restored, killed });
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ status: 'IN_PROGRESS', scope: 'application-path mutations; no semantic/live certification', reports }, null, 2));
    console.log(`${killed ? 'KILLED' : 'FAIL'} ${variant.id}`);
    if (!killed) throw new Error(`${variant.id}: invalid or surviving mutation`);
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ status: 'PASS', scope: 'application-path mutations; no semantic/live certification', reports }, null, 2));
} finally { await pool.end(); }
