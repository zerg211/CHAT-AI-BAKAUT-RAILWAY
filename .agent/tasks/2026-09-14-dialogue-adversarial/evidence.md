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
| AC10 | IN PROGRESS | PR #26 and Railway deployment passed. The first production dialogue #2186 exposed a finalization deadline defect; the corrective branch is verified locally and awaits merge, deployment and a fresh clean-session dialogue. |

## Fresh verification

Commands and results:

- `npm run typecheck` — PASS.
- `npm run lint:no-regex` — PASS; no new regex constructs, legacy baseline 203.
- `npm test -- --maxWorkers=1` — PASS; 126 files passed, 1 skipped; 1502 tests passed, 1 skipped.
- `npm run build` — PASS.
- `npm run verify` — PASS. The gate independently passed 213 offline oracle/transport checks, all seeded mutation checks, dependency audit at its configured high-severity boundary, TypeScript, the full serial suite (1502 passed, 1 skipped), and production build. It correctly reports `REAL_AGENT_ACCEPTANCE=NOT_RUN` before deployment.
- Critic focused verification — PASS: 139 tests, then 76 post-dispute tests, then 26 final focused tests; TypeScript and diff check passed.

Raw logs are stored in `raw/`. The first parallel timeout run and its clean sequential recovery are described in `problems.md` rather than being omitted.

## Production checkpoint and corrective verification

- PR #26 merged as `22d519e581e87e5a06f80d73b046138695600dc8`; Railway deployment `67a170b4-833c-46dc-9bbb-05adace182b4` reached SUCCESS at that exact SHA and the public health marker matched.
- The first clean production-widget dialogue was conversation `#2186`, session `76513e9c-98ed-4563-ab0c-885b00d7522d`. It produced no assistant message; the buyer saw `Не удалось завершить ответ. Текст вашего вопроса остался в чате.` The redacted admin capture is `raw/production-dialogue-2026-09-15-failed-admin.json`.
- Trace cause: calculator and catalog completed; web research consumed 45.846 seconds; optional observation/read work left about 36.5 seconds, so the writer received about 21 seconds before the hard 15-second review reserve and timed out.
- Corrective focused verification — PASS: 205/205 tests. TypeScript, no-new-regex guard and production build also PASS. The independent critic's final review is PASS.
- Fresh full suite — 1501 tests PASS, one intentional skip, two failures. The chat-route timeout passed on focused retry. The remaining PDF integration test uses a live URL that now returns HTTP 404. The release gate passed oracle, mutation, regex, configured dependency audit, TypeScript and build, but honestly remained BLOCKED by its full-suite phase because of that external PDF fixture and one generated-sequence timeout; the complete generated-sequence file then passed 24/24 in isolation. See `problems.md` P4-P5.

## Known scoped limits

- The deterministic validator proves structured `factsUsed` bindings. Exhaustive extraction of every factual statement from free-form answer text remains under the semantic factual reviewer.
- Raw first-party page evidence is intentionally bounded to 20 addressable chunks; continuation remains responsible for later page sections.
- Exact retry effort/goal lineage needs a new LLM-declared relation contract and was deliberately excluded from this patch. The observed empty-retry trigger is handled by fail-soft external reads, and every turn is now visible in admin.
- The current dependency audit reports one moderate `csv-parse` advisory whose available update is breaking. The configured release boundary is high severity, so it does not invalidate this task's gate.
- The repository's live PDF test depends on a removed `bakautprof.ru/documents/hours.pdf` fixture and cannot currently prove production PDF parsing until that fixture or a stable equivalent is restored.
