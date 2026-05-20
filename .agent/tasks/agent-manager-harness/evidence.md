# Evidence: agent-manager-harness

Date: 2026-05-20

## Scope Completed

Local implementation now covers the full harness slice needed before feature-flag rollout:

- default-off agent-manager feature flags;
- DB schema and repair-schema coverage for `dialogue_ledger_events`, `turn_checkpoints`, `tool_artifacts`, `answer_contracts`, `lead_outbox`, `agent_traces`, and `data_quality_issues`;
- typed Zod contracts for ledger delta, intent, tool request/result, answer contract, and pre-send review;
- stable deterministic ledger event ids that ignore LLM-provided event ids;
- single reducer for ledger state with idempotency, supersede/negate, and question closing;
- read-only legacy `needState` snapshot derived from the active ledger for the new contour;
- `AgentManagerOrchestrator` routed behind `AGENT_MANAGER_HARNESS_ENABLED`;
- old user-visible answer writers gated when the harness flag is enabled;
- checkpoint resume from saved user message and from final answer contract;
- same-turn route recovery before buyer-visible error in harness path;
- local lead capture separated from external delivery through `lead_outbox`;
- retry worker for external lead delivery failure without asking the buyer to repeat contacts;
- product comparison research flow using web search when facts are missing or conflicting;
- data-quality issue recording for catalog/web conflicts;
- pre-send mechanical invariants:
  - no asking for a contact already provided;
  - no closed/redundant questions;
  - no answer fact source absent from ledger/tool artifacts;
  - no unknown tool-result references;
  - no contact confirmation without successful local lead/outbox capture;
  - high-risk source disagreement is blocked for adjudication;
  - unsupported/unverified claim risk flags are blocked;
- admin trace storage, admin API exposure, and compact trace rendering in the admin conversation detail UI.

## Verification

Commands run after the latest code changes:

```text
npm test -- --run tests/dialogueLedgerReducer.test.ts tests/agentManagerOrchestrator.test.ts tests/agentManagerComparisonResearch.test.ts
PASS: 3 files, 12 tests

npm test -- --run tests/agentManagerIntegrationSource.test.ts
PASS: 1 file, 6 tests

npm run typecheck
PASS

npm test
PASS: 57 files, 493 tests

npm run build
PASS

npm run migrate
PASS: Migrations completed

git diff --check
PASS: no whitespace errors; line-ending warnings only
```

## Key Proof Points

- `tests/dialogueLedgerReducer.test.ts`: proves AC2.1-AC2.4 behavior, including read-only `needState` derivation from ledger.
- `tests/agentManagerOrchestrator.test.ts`: proves ledger-derived active context, checkpoint recovery, final-answer-contract resume, lead capture before confirmation, unsupported-source blocking, and adjudication blocking.
- `tests/agentManagerComparisonResearch.test.ts`: proves visible comparison targets bind to catalog products, web research runs, and conflicts create data-quality issues.
- `tests/leadOutbox.test.ts`: proves external lead delivery failure remains in outbox for retry without buyer action.
- `tests/agentManagerIntegrationSource.test.ts`: proves assistant/chat routes are wired through the harness flag, saved-turn recovery is attempted before buyer-visible error in the harness path, admin trace UI rendering is present, and health exposes a runtime deploy marker.

## Production Status

No production widget live test was run for this local code slice. The new behavior is still behind default-off feature flags and is not active on `https://bakautprof.ru/` until branch push, Railway auto-deploy, and explicit flag enablement.

Therefore local code verification is `PASS`; full task done definition remains `PENDING_PRODUCTION_LIVE_VERIFICATION`.
