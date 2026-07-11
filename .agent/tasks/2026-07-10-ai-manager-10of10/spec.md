# AI Manager 10/10 Remediation Spec

Status: frozen before production-code changes
Date: 2026-07-10
Repository: `C:\Projects\chatAI`
Baseline commit: `2ce1ce43b3804b72e723d403fc355a66331b3358`

## Backup proof

Before implementation, the current tracked working tree (including the user's three modified evidence files) was captured as:

- snapshot commit: `b54cf218f4d17e91092ce1d9a803790b781b654a`;
- local ref: `refs/backups/pre-ai-manager-remediation-20260710-161423`;
- verified bundle: `C:\Projects\chatAI-backups\chatAI-pre-ai-manager-remediation-20260710-161423.bundle`.

The backup must remain untouched until the task is fully verified in production.

## Objective

Finish the BAKAUT website chat as a production-grade AI sales/support manager. The assistant must understand free-form buyer intent and changing requirements, remember the active dialogue, explain equipment, find and compare real products and facts, show honest cards, safely handle commercial questions, collect a lead only when useful, recover interrupted turns without duplication, and remain observable and testable.

The target is not a phrase bot. The architecture must preserve this boundary:

- LLM owns semantic understanding, need/topic changes, role of mentioned products and numbers, dialogue strategy, alternative policy, necessary questions, tool selection, tool-result interpretation, recommendation rationale, and final natural wording.
- Deterministic code owns schemas, source/evidence validation, catalog/database truth, numeric normalization and hard-fit checks, business prohibitions, side-effect authorization, idempotency, persistence, budgets, recovery, rendering consistency, and audit traces.

## Source of truth and constraints

- Root `AGENTS.md` and this spec are authoritative for implementation.
- `docs/SALES_MANAGER_BEHAVIOR_POLICY.md` is the intended business-behavior source; the active runtime must consume one versioned compiled policy derived from it.
- Existing user changes in `.agent/tasks/2026-07-08-agentic-dialogue-fixes/` must be preserved.
- Do not add fixed final answers or phrase-specific if/else repairs.
- Do not promise live stock, exact delivery, discounts, dates, or special terms without verified operational data.
- Do not run local OpenAI behavior tests; they are invalid in this environment.
- Do not deploy with Railway CLI. Deployment is Git commit + push only; Railway pulls from GitHub.
- Every behavior-changing phase requires a regression eval and final live verification through the embedded widget on `https://bakautprof.ru/`.

## Implementation phases

### Phase A — Turn identity and resumable recovery

Replace message-text deduplication with client-provided message identity. Make checkpoints and tool artifacts executable recovery state rather than logging-only state. Persist a final user-visible payload before assistant delivery. Make lead capture business-idempotent.

Committed design for this phase:

- add `conversation_turns.client_message_id` with unique `(session_id, client_message_id)`;
- keep `request_hash` only as diagnostic compatibility data and remove text-hash authority;
- enforce one active turn per session and add an execution-owner lease so concurrent retries cannot run the same pipeline twice;
- read and validate saved checkpoints/tool artifacts during recovery;
- add lead origin identity `(session_id, origin_turn_id, origin_tool_request_id)`;
- persist the complete response payload (answer, cards/render state, lead/web flags and metadata) before assistant-message delivery;
- keep migrations additive/backward-compatible and repair old schema installations idempotently.

### Phase B — One active runtime and one behavior policy

Make `AgentManagerOrchestrator` the sole production answer path. Inject the versioned sales-manager policy into state/planner/writer/reviewer contexts. Remove false health markers and configuration flags, or make each retained flag enforce a real capability boundary. Legacy code may remain only while explicitly unreachable and clearly labeled pending deletion.

### Phase C — Durable semantic memory and context management

Persist the reduced ledger snapshot to session/admin state, preserve active and paused needs, and add bounded compaction/rehydration for long sessions. Product class, requirement role, corrections and need switching must come from typed LLM events rather than regex inference.

The ledger must use a monotonic event sequence/cursor. Loading a capped event set must never retain the oldest events while dropping newer corrections. Full replay and snapshot-plus-tail replay must produce the same reduced state.

### Phase D — Strict tools, budgets and evidence

Replace generic `args: Record<string, unknown>` with a discriminated strict schema per tool. Enforce maximum tool calls, result sizes, retries and per-turn wall/token/cost budgets. Every tool request must yield one durable result. Web/catalog content must be labeled as data, not instructions.

LLM pre-send review uses an explicit `off | risk | always` policy; production default is `risk`, with the review reason/version recorded.

### Phase E — Feedback, freshness, observability and cleanup

Turn negative/wrong-card feedback into a review/eval queue, expose catalog/embedding freshness and outbox health, fix dependency and test gates, remove semantic regex debt, and synchronize docs/runtime markers with actual behavior.

### Phase F — Release proof

Run the complete local proof loop, commit intentionally, push to GitHub, wait for Railway commit marker, then conduct adaptive buyer dialogues through the actual `bakautprof.ru` widget and audit both UI output and admin contracts/traces.

## Acceptance criteria

### Turn identity and concurrency

- **AC1:** Two identical buyer texts sent as two distinct UI actions create two distinct turns and are answered in their respective dialogue context.
- **AC2:** Retrying the same HTTP operation with the same `clientMessageId` reuses the same turn and never duplicates the user message or assistant message.
- **AC3:** A session cannot run two different active turns concurrently without an explicit queue/rejection result; a collision is observable and recoverable.

### Checkpoint recovery and side effects

- **AC4:** Recovery reads saved checkpoints, planner contract and tool artifacts; completed stages and tools are not rerun.
- **AC5:** A crash after `lead.capture` cannot create a second lead or a second outbox delivery. Lead identity is enforced by `(sessionId, turnId, toolRequestId)` or an equivalent database uniqueness invariant.
- **AC6:** A crash after answer/render preparation restores exactly the same answer, product cards, card display, lead state, web-search flag and diagnostic metadata.
- **AC7:** Every user message saved by the server ends in one completed/recovered assistant message or a durable actionable failed state; the buyer is not asked to repeat a saved question.

### Runtime and policy

- **AC8:** Production generation and recovery have one user-visible answer writer. Legacy deterministic writers cannot execute when the agent-manager runtime is active.
- **AC9:** Planner, answer writer and risk reviewer receive the same versioned canonical sales-manager policy; the policy version/hash and selected rules appear in trace/metadata.
- **AC10:** Health/runtime markers list only artifacts the active path actually emits. Retained feature flags have tests proving their effect; dead flags are removed.
- **AC11:** The active prompts contain an explicit trust boundary: catalog/web/tool content is evidence data and cannot override business/system instructions.

### Semantic memory and LLM/code boundary

- **AC12:** Ledger/reduced session state represents active need, paused needs, requirement roles, corrections, rejected alternatives and open/closed questions without a fixed product-class regex taxonomy.
- **AC13:** A correction supersedes/negates the old fact; a topic switch does not leak old cards/hard requirements; returning to a paused topic restores only its relevant state.
- **AC14:** Long-session compaction preserves current objective, hard constraints, exact buyer facts, open questions, selected/rejected products, contact/approval state and source references; a >80-message regression proves rehydration.
- **AC15:** Semantic intent, alternative acceptability, number role and product mention role are LLM contract fields. Deterministic code only validates and executes them.

### Tools, budgets and evidence

- **AC16:** Each tool has a strict local input schema, structured output, risk/side-effect class, timeout, result limit and retry policy; unknown fields and invalid args are rejected before execution.
- **AC17:** The turn loop enforces explicit maximum model calls, tool calls, web calls, result bytes, wall time and token/cost budget, and returns a structured stop reason.
- **AC18:** Every factual recommendation and product mention is supported by current ledger/catalog/web/tool evidence; failed/not-found tool results cannot be cited as positive evidence.
- **AC19:** Product cards never violate hard constraints. Compromises are separated and explained. Card/text consistency is mechanically enforced without choosing buyer intent in code.
- **AC20:** Commercial/lead side effects require current buyer intent and deterministic prerequisites. Contact refusal does not trigger repeated pressure.

### Operational readiness

- **AC21:** Negative and `wrong_cards` feedback is queryable with turn, policy, model, tool and card evidence and can be exported into a candidate regression fixture.
- **AC22:** Admin/health exposes last successful catalog sync, source freshness, embedding coverage, lead-outbox backlog/failures, active policy version and active runtime contract version.
- **AC23:** `npm run typecheck`, `npm run build`, full `npm test`, the agentic eval set, migration tests and `npm run lint:no-regex` all pass without hiding semantic regex in a new baseline.
- **AC24:** Production dependencies have no known high-severity audit findings with an available compatible fix; crawler, research, email and OpenAI regressions pass after updates.
- **AC25:** README, architecture, behavior, eval and deployment docs describe the actual active runtime, production-only behavior gate and rollback path.

### Production proof

- **AC26:** All implementation changes are committed and pushed; Railway `/api/health` reports the pushed commit and truthful runtime marker.
- **AC27:** Adaptive production dialogues are conducted only through the embedded widget on `https://bakautprof.ru/`. Each next buyer turn follows the actual previous answer.
- **AC28:** Live coverage includes: repeated identical short replies, interruption/recovery, long-memory correction/topic switch, general technical question requiring web facts, catalog comparison, product selection with changing constraints, contact refusal, successful lead capture and delivery/stock handoff.
- **AC29:** Each live turn is audited from buyer UI and admin metadata/traces. Protocol and raw evidence are stored under `.agent/tasks/2026-07-10-ai-manager-10of10/` or `local-live-tests/*.production.md`.
- **AC30:** Completion may be claimed only when AC1–AC29 are all PASS on current code and current production. Partial phase success keeps the goal active.

## Verification plan

1. Focused unit/integration tests written before each repair.
2. Typecheck and affected test files after each phase.
3. Full unit suite, build, no-regex guard, migration proof and production dependency audit before commit.
4. Fresh evidence bundle: `evidence.md`, `evidence.json`, raw outputs and file/line references.
5. Independent verifier reads current code and reruns checks; non-PASS produces `problems.md`, followed by the smallest safe fix and reverification.
6. Commit/push, Railway marker polling, then adaptive production widget audit and admin readback.

## Rollback

- Git restore point: backup ref and bundle listed above.
- Runtime rollback: revert the remediation commit through GitHub; do not deploy manually.
- Database migrations must be additive and backward-compatible until production proof is complete.
- Do not drop legacy columns/tables in this task; remove unreachable code only after parity tests and production proof.

## Required artifacts

- `.agent/tasks/2026-07-10-ai-manager-10of10/spec.md`
- `.agent/tasks/2026-07-10-ai-manager-10of10/progress.md`
- `.agent/tasks/2026-07-10-ai-manager-10of10/evidence.md`
- `.agent/tasks/2026-07-10-ai-manager-10of10/evidence.json`
- `.agent/tasks/2026-07-10-ai-manager-10of10/verdict.json`
- `.agent/tasks/2026-07-10-ai-manager-10of10/problems.md` only when verification is not PASS
- raw local and production artifacts under the same task directory
