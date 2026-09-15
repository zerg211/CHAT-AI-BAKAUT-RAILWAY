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
| AC10 | IN PROGRESS | PRs #26-#27 and their exact Railway deployments passed. Dialogues #2186-#2187 exposed two distinct finalization defects; the second corrective branch is under local verification before publication and a fresh clean-session dialogue. |

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

## Second production checkpoint and canonical-evidence correction

- PR #27 merged as `d5b1f5573318efa46f8167710b23dfc2707229c7`; Railway deployment `5c7ca768-944b-4580-b231-01fd5bca2c9a` reached SUCCESS at that exact SHA, and both public health markers matched it.
- The second clean production-widget dialogue was conversation `#2187`, session `96948942-ee02-400d-9ba7-65b0478aa6d0`. It produced no assistant message; the buyer again saw `Не удалось завершить ответ. Текст вашего вопроса остался в чате.` Captures are `raw/production-dialogue-2026-09-15-failed2-admin.json`, `raw/production-dialogue-2026-09-15-failed2-answer-contracts.json` and `raw/production-dialogue-2026-09-15-failed2-turn-artifacts.json`.
- The first reserve correction did its job: continuation stopped with 68.15 seconds left and the initial writer completed. Review found exactly three attribute mismatches because the aggregate `totalRunningKw=2.9` cited three component `runningKw` items, despite the calculator's canonical `payload.profile.totalRunningKw=2.9` being present.
- Repair then started with 31.359 seconds, below the full writer/review/operation budget, and timed out. The new correction binds the canonical calculator total without duplicating calculator semantics and changes repair admission to `remaining > 47,000 ms`.
- Focused verification of the new correction — PASS: 196/196 tests; TypeScript, production build and the no-new-regex guard also PASS. The critic independently repeated 196/196 tests, found no blocking defect and returned PASS. Publication and a fresh production dialogue remain pending at this checkpoint.

## Third production checkpoint and durable-memory correction

- PR #28 merged as `984cbf7eba8fd736848f79995df3cc10aaa8cc7f`; Railway deployment `050492ad-7e20-404e-add1-f014bffa4d06` reached SUCCESS at that exact SHA and both public health markers matched.
- Production dialogue `#2188`, session `355fccf1-14f5-493e-b5d2-5640416cca07`, completed the initial buyer turn. The follow-up turn `81ecd066-ddec-495b-bc04-b855e3dc1a2d` failed as `agent_manager_recovery_failed / wall_time_budget_exceeded` after deterministic review rejected memory-projected A-iPower facts with no item IDs. The admin and database captures are `raw/production-dialogue-2026-09-15-failed3-admin.json` and `raw/production-dialogue-2026-09-15-failed3-turn-artifacts.json`.
- The correction adds a non-backfilled durable exact-evidence marker, stable verified-row evidence IDs, fail-closed legacy URL reuse, exact unique auto-binding, and required value-compatible bindings for nonnumeric tool claims.
- Root/critic dispute completed with one shared opinion. The critic corrected the real `facts` + `coverage` duplicate and retained ambiguity for a separate fresh fact. The repository mutation boundary rejects new unvalidated web/manual rows.
- Fresh focused verification — PASS: 285/285 tests. Final direct root verification — PASS: 40/40. TypeScript, no-new-regex and production build PASS. The isolated generated dialogue-ledger suite passed 24/24. The full-suite run passed 1,509 tests, skipped one, and recorded the removed remote PDF fixture plus two resource timeouts; the two generated-sequence timeouts passed on the isolated 24/24 rerun. One obsolete binder assertion failed only because the critic updated its production-shaped fixture while that long run was already in progress; the finalized test passes in both the critic's and root's fresh runs.
- Raw focused output is `raw/verified-memory-focused-2026-09-15.log`. Publication and a new clean-session production dialogue remain pending.

## Fourth production checkpoint and multi-gap wording correction

- PR #29 merged as `f841e15bebb01718ac0cf1a5b0819e6158edd7dd`; required GitHub workflow run `34967180040` passed the complete 1,514-test suite, migration/knowledge checks on isolated PostgreSQL, backend acceptance and build. Railway deployment `971c29e1-cc57-45a2-a78a-aded93a90218` reached SUCCESS at the exact merge SHA and the public backend marker matched.
- A read-only production database check confirmed `verified_product_facts.evidence_verified_exact boolean NOT NULL DEFAULT false`; all 30,978 legacy rows remained false, proving that migration did not promote historical evidence.
- Production dialogue `#2189`, session `80225914-da24-4917-8ab8-1def299725e7`, turn `deca26dd-1fe2-41a7-a0e9-3f15387decd5`, produced a grounded preliminary draft but no assistant message. The buyer saw the generic completion error. Captures are `raw/production-dialogue-2026-09-15-failed4-admin.json` and `raw/production-dialogue-2026-09-15-failed4-turn-artifacts.json`.
- Calculator evidence correctly listed three unresolved startup loads. The draft preserved all three initially, then incorrectly called the pump nameplate the one fact needed for exact selection. The semantic factual reviewer correctly blocked this as `research_guidance_uncertainty_mismatch`. Repair remained closed below the proven 47-second full writer/review boundary.
- Root and critic agreed not to weaken review, lower the repair threshold or add phrase matching. The correction passes the complete `missingStartingLoads` list to the writer and tells both writer and reviewer that one focused question is only the next step while any other blocker remains.
- Focused verification — PASS: 33/33 tests; broader orchestrator/evidence regression — PASS: 232/232; TypeScript, no-new-regex and build PASS. The critic independently inspected the final diff, repeated 33/33 tests and returned PASS. Publication and another clean-session production dialogue remain pending.

## Fifth production checkpoint and atomic-fact correction

- PR #30 merged as `b19b2dfa7055c05ae152b73324e38d02c6962565`; Railway deployment `b7d67533-23a7-4113-b4f7-c39e665c184e` reached SUCCESS at the exact SHA. Conversation #2190 proved the multi-gap wording correction but failed because repair mixed canonical calculator IDs with display-path separators.
- PR #31 merged as `be7a6b43a900342802f3338312f61ad6c8034253`; required GitHub workflow run `34972603941` passed and Railway deployment `d4e1ff15-1b22-4cc9-9eb9-10e33b254028` reached SUCCESS at the exact SHA. Public health matched the merge.
- Clean production conversation #2191, session `f02ea0e8-a2b8-482b-b66a-b8a5200a4fec`, turn `01feb77f-fc67-4c8f-88cc-509c2933226b`, used canonical evidence addresses. It still committed no assistant message because the writer grouped different values/attributes into three composite `factsUsed`; deterministic review correctly blocked eleven binding issues. Captures are `raw/production-dialogue-2026-09-15-failed6-admin.json` and `raw/production-dialogue-2026-09-15-failed6-turn-artifacts.json`.
- The correction constrains writer output to one evidence item per atomic fact, teaches the same rule to initial and repair calls, keeps exact issue evidence in untrusted user JSON, and replaces internal `расчётный профиль` wording with customer-facing calculation language without banning useful source attribution.
- Focused verification — PASS: 228/228 tests. The #2191 composites remain blocked; the seven atomic canonical facts pass with exact bindings. TypeScript and the no-new-regex guard pass. Publication, Railway readback and the final clean adaptive production dialogue remain pending.

## Known scoped limits

- The deterministic validator proves structured `factsUsed` bindings. Exhaustive extraction of every factual statement from free-form answer text remains under the semantic factual reviewer.
- Raw first-party page evidence is intentionally bounded to 20 addressable chunks; continuation remains responsible for later page sections.
- Exact retry effort/goal lineage needs a new LLM-declared relation contract and was deliberately excluded from this patch. The observed empty-retry trigger is handled by fail-soft external reads, and every turn is now visible in admin.
- The current dependency audit reports one moderate `csv-parse` advisory whose available update is breaking. The configured release boundary is high severity, so it does not invalidate this task's gate.
- The repository's live PDF test depends on a removed `bakautprof.ru/documents/hours.pdf` fixture and cannot currently prove production PDF parsing until that fixture or a stable equivalent is restored.
