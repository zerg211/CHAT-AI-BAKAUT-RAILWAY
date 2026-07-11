# Evidence — AI Manager 10/10 remediation

Date: 2026-07-11
Baseline: `2ce1ce43b3804b72e723d403fc355a66331b3358`
Current verdict: **PENDING_PRODUCTION_PROOF**

The current tree passes the complete local release gate. This is not a completion claim: AC26–AC29 require the pushed Railway build and adaptive production-widget evidence, so AC30 remains pending.

## Intent reconstructed from the repository

The intended product is not an FAQ or keyword bot. It is a BAKAUT sales/support manager that interprets free-form buyer intent, preserves and revises multiple needs, verifies product and technical facts, recommends only defensible catalog items, explains compromises, observes commercial boundaries, captures a lead only with current authorization, and resumes interrupted work without duplicating side effects.

The implementation now makes the architecture boundary explicit:

- the LLM owns semantic intent, topic/requirement change, product and number roles, alternative strategy, tool planning, recommendation rationale and natural language;
- deterministic code owns schema validation, evidence/source checks, catalog truth, hard constraints, business prohibitions, side-effect authorization, idempotency, persistence, budgets and render consistency.

## What was incomplete or misleading before remediation

- Message text doubled as request identity, so repeated short answers and HTTP retries were conflated.
- Checkpoints/tool artifacts were mostly diagnostic and recovery could rerun expensive or side-effecting work.
- The legacy assistant contained overlapping semantic fallbacks and could obscure which writer actually produced the answer.
- Dialogue state lacked durable snapshot-plus-tail semantics for long conversations and corrections.
- Tool calls used broad payloads and had incomplete aggregate limits.
- Feedback, catalog freshness and health markers were not a complete operational learning/readiness loop.
- External fetching, public endpoints, exports and full-catalog mutation paths needed stronger trust, resource and concurrency boundaries.
- Several local deploy/predeploy scripts and the PDF parser path were unused or unsafe relative to the actual GitHub-to-Railway workflow and were removed.

## Acceptance evidence matrix

| AC | Status | Current-code evidence |
|---|---|---|
| AC1 | PASS_LOCAL | UI creates a UUID per action; repository uniqueness is `(session_id, client_message_id)`; repository/stream tests plus a sequential orchestrator integration prove two identical `Да` actions produce two turns, two assistant messages and writer histories containing one then two buyer turns. |
| AC2 | PASS_LOCAL | `beginTurn` conflict/reuse behavior and payload-hash mismatch protection in `src/db/repositories.ts`; retries preserve `clientMessageId` in `src/client/chatStream.ts`; repository and stream regressions pass. |
| AC3 | PASS_LOCAL | Partial unique active-turn invariant plus execution-owner lease in migration 011 and repository acquire/release methods; collision/recovery tests pass. |
| AC4 | PASS_LOCAL | `AgentManagerOrchestrator` loads and schema-validates saved checkpoints and `listToolArtifacts`, then reuses completed stage/tool outputs; recovery tests in `tests/agentManagerOrchestrator.test.ts` pass. |
| AC5 | PASS_LOCAL | Unique lead origin `(session_id, origin_turn_id, origin_tool_request_id)` and idempotent upsert; outbox sent-state is monotonic on replay; repository/lead/email tests pass. |
| AC6 | PASS_LOCAL | Complete final response payload is saved before delivery and restored with answer/cards/render/lead/web/diagnostics; recovery equality regressions pass. |
| AC7 | PASS_LOCAL | Durable turn status, actionable failure state, exact completed-response replay and route recovery behavior are covered by repository/orchestrator/route tests. |
| AC8 | PASS_LOCAL | `AgentManagerOrchestrator` is the production runtime in `src/ai/agentManagerRuntime.ts`; active dispatch returns before the legacy writer in `src/ai/assistant.ts`; source integration/runtime tests prove the boundary. |
| AC9 | PASS_LOCAL | Canonical compiled policy/version/hash is injected into planner, answer writer and reviewer; policy metadata/rule IDs are recorded; policy/source integration tests pass. |
| AC10 | PASS_LOCAL | Versioned `AI_MANAGER_RUNTIME_MANIFEST`; public health exposes only deployment markers while authenticated admin health exposes real operational artifacts; app/integration tests pass. |
| AC11 | PASS_LOCAL | A shared prompt boundary explicitly labels dialogue, catalog, web and tool payloads as untrusted evidence that cannot override instructions; source integration tests assert every model stage receives it. |
| AC12 | PASS_LOCAL | Typed ledger events/reducer model active and paused needs, requirements and roles, corrections, rejected products and questions without a fixed product-class taxonomy. |
| AC13 | PASS_LOCAL | Reducer supersession, need switch/pause/return and card isolation regressions pass. A real three-turn regression proves validated card IDs are persisted, only the current need's selected card is restored on resume, and a no-card follow-up does not erase that selection. Paused generator facts/budgets cannot leak into a newly active plate need. |
| AC14 | PASS_LOCAL | Monotonic sequence and persisted snapshots are covered by reducer equivalence plus an orchestrator regression with 90 real messages and snapshot+tail. It preserves objective, budget/hard facts, open question, selected/rejected products, contact approval and source evidence while planner history stays bounded to the newest 80 messages. |
| AC15 | PASS_LOCAL | Intent contract includes selection/alternative/need action, mention roles, grounding and selected IDs; missing semantic contract fails closed instead of inferring buyer intent from phrases. |
| AC16 | PASS_LOCAL | `src/ai/agentManagerToolRegistry.ts` defines strict discriminated schemas plus risk, timeout, retry and result caps; unknown/invalid fields regressions pass. |
| AC17 | PASS_LOCAL | `src/ai/agentManagerTurnBudget.ts` enforces model/tool/web/result-byte/wall/token/cost limits with structured stop reasons. Every physical provider request is conservatively estimated from UTF-8 bytes, output reservation and versioned tariff ceilings; daily usage reservations reuse the same estimate. Catalog products are deduplicated only at the model boundary. |
| AC18 | PASS_LOCAL | Evidence registry and reviewer require current scoped ledger/catalog/web/tool support. Failed, low-confidence, conflicting, unrelated or paused-need evidence cannot become a positive claim. Catalog fact review is mandatory in risk mode even when the writer returns `factsUsed=[]`, and rewritten claims are independently rechecked. |
| AC19 | PASS_LOCAL | LLM-selected IDs are mechanically checked and final contract/card/ledger IDs are identical. Known hard constraints fail on missing product facts; unsupported/invalid strict kinds fail closed before writer evidence and at card selection. A strict ceramic-material regression proves incompatible catalog products never reach the writer. |
| AC20 | PASS_LOCAL | Lead/commercial actions require structured current-turn semantics and exact deterministic contact evidence; refusal and idempotency regressions pass. |
| AC21 | PASS_LOCAL | Migration 013 and feedback queue store turn/policy/model/tool/card evidence; export only accepts negative/wrong-card queue entries, requires PII acknowledgement and writes under gitignored `.private/`; tests pass. |
| AC22 | PASS_LOCAL | Authenticated `/api/admin/health` reports catalog/source/embedding/outbox/policy/runtime detail; public `/api/health` intentionally stays minimal; app/admin tests pass. |
| AC23 | PASS_LOCAL | Fresh independent `npm run verify`: 105 files/918 tests, 251 agentic evals, typecheck, build and no-regex gate all PASS; focused migration/freshness 25/25 PASS. |
| AC24 | PASS_LOCAL | Fresh `npm audit --audit-level=low`: 0 vulnerabilities; catalog/research/outbound/email/OpenAI regressions remain inside the 918-test full suite. |
| AC25 | PASS_LOCAL | README plus architecture, behavior, catalog, eval, local-live and Railway docs describe the active runtime, health split, GitHub-only deployment and production-only behavior proof. |
| AC26 | PENDING | Requires intentional commit/push and Railway `/api/health` marker for that exact commit. |
| AC27 | PENDING | Requires an adaptive dialogue through the embedded widget on `https://bakautprof.ru/` after deployment. |
| AC28 | PENDING | Required live coverage matrix has not yet been executed against the new production build. |
| AC29 | PENDING | Production UI/admin trace protocol and raw artifacts do not exist yet. |
| AC30 | PENDING | Cannot pass until AC26–AC29 pass. |

## Security evidence

- `security/threat_model.md` — repository-specific trust boundaries, assets and abuse cases.
- `security/repository_coverage_ledger.md` — reviewed security-sensitive scope.
- `security/validation_report.md` — all 59 unique discovery candidates preserved and dispositioned; no current reportable/deferred survivor.
- `security/attack_path_analysis_report.md` — public OpenAI cost exhaustion, SSRF, lead/email amplification, catalog integrity and external-evidence poisoning paths are interrupted by current controls.

Important controls include strict CORS/session/body/rate limits, database-backed OpenAI reservations, SSRF-safe DNS/IP/redirect/byte/time validation, exact-origin catalog crawling, CSV limits, global catalog mutation locks with heartbeat and incomplete-discovery fail-closed behavior, protected admin health and private feedback export boundaries.

## Fresh checks

Exact outputs are in `raw-local-checks.md`:

- final independent `npm run verify` — PASS, 105/105 files and 918/918 tests;
- `npm audit --audit-level=low` — 0 vulnerabilities;
- `npm run lint:no-regex` — PASS, no new regex constructs;
- focused migrations/freshness — 25/25 PASS;
- `git diff --check` — PASS.

## Remaining required proof

1. Exact staged-scope audit excluding the user's three pre-existing evidence changes.
2. Git commit and push; Railway marker readback.
3. Adaptive embedded-widget dialogues covering the full AC28 matrix.
4. Per-turn buyer UI and authenticated admin metadata/trace audit saved as production evidence.
