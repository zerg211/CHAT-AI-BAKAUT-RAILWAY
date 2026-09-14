# Dialogue adversarial correctness — evidence

Task: `2026-09-14-dialogue-adversarial`
Baseline: `4a8edb186ad7086fb2a302782993ff3713141116`
Branch: `codex/dialogue-adversarial-correctness`

## Review and dispute

- The independent production-dialogue review is preserved in `subagent-audit.md`.
- The critic's correction pass, the root agent's four objections, the critic's responses, and the final shared position are preserved in `subagent-corrections.md`.
- The shared verdict requires exact numeric token matching, exact product identity, validated web evidence, bounded evidence ordering, fail-soft external reads, honest partial outcomes, seller-visible failed turns, and contact visibility controlled by the latest valid assistant authorization.

## Acceptance status before publication

| Criterion | Status | Evidence |
|---|---|---|
| AC1 | PASS | `taskOutcome` derives research gaps for every readiness state; unit fixtures cover partial/timed-out research and unresolved facts. |
| AC2 | PASS | `requiredToolResultSatisfied` distinguishes answered, partial, exhausted, and failed required research. |
| AC3 | PASS | Stable claim evidence items bind exact value, product and attribute; substring, related-model, stale nested catalog and unverified-web bypasses are rejected. |
| AC4 | PASS | External-read allowance exhaustion persists a non-fact-bearing artifact and continues to the writer; hard budgets keep their boundary. |
| AC5 | PASS | Exact curated manufacturer registry recognizes `fubag.group` and subdomains while rejecting suffix lookalikes. |
| AC6 | PASS | Evidence-only technical follow-ups reject historical calculator replay; current selection work remains allowed. |
| AC7 | PASS | Admin detail renders turn status/error/build, current readiness, task outcome, unresolved facts, required-tool/research diagnostics and warnings. |
| AC8 | PASS | Contact panel follows the latest valid assistant `leadRequested`; sending/error placeholders cannot create or revoke authorization. |
| AC9 | PASS | All local proof below passed without a local OpenAI call. |
| AC10 | PENDING | GitHub merge, Railway marker and the new adaptive production-widget dialogue follow after this pre-publication proof. |

## Fresh verification

Commands and results:

- `npm run typecheck` — PASS.
- `npm run lint:no-regex` — PASS; no new regex constructs, legacy baseline 203.
- `npm test -- --maxWorkers=1` — PASS; 126 files passed, 1 skipped; 1502 tests passed, 1 skipped.
- `npm run build` — PASS.
- `npm run verify` — PASS. The gate independently passed 213 offline oracle/transport checks, all seeded mutation checks, dependency audit at its configured high-severity boundary, TypeScript, the full serial suite (1502 passed, 1 skipped), and production build. It correctly reports `REAL_AGENT_ACCEPTANCE=NOT_RUN` before deployment.
- Critic focused verification — PASS: 139 tests, then 76 post-dispute tests, then 26 final focused tests; TypeScript and diff check passed.

Raw logs are stored in `raw/`. The first parallel timeout run and its clean sequential recovery are described in `problems.md` rather than being omitted.

## Known scoped limits

- The deterministic validator proves structured `factsUsed` bindings. Exhaustive extraction of every factual statement from free-form answer text remains under the semantic factual reviewer.
- Raw first-party page evidence is intentionally bounded to 20 addressable chunks; continuation remains responsible for later page sections.
- Exact retry effort/goal lineage needs a new LLM-declared relation contract and was deliberately excluded from this patch. The observed empty-retry trigger is handled by fail-soft external reads, and every turn is now visible in admin.
- The current dependency audit reports one moderate `csv-parse` advisory whose available update is breaking. The configured release boundary is high severity, so it does not invalidate this task's gate.
