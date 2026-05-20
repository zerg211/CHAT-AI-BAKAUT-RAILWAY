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
- production-widget opt-in activation through page URL query `?agentHarness=1`, while global harness flag remains default-off;
- `/api/health` runtime marker now exposes the harness flag state and URL opt-in parameter;
- chat route recovery now uses the same session-aware activation check as answer generation;
- legacy catalog/commercial fast writers no longer make the semantic decision or render deterministic user-visible text: an LLM route contract selects the path and an LLM answer contract writes the response;
- after a local lead is created, the LLM answer step receives the saved `autoLead` context and explicit "contact already saved" guidance; post-answer verification blocks repeated contact requests after created leads.

## Verification

Commands run after the latest code changes:

```text
npm test -- --run tests/agentManagerOrchestrator.test.ts tests/agentManagerIntegrationSource.test.ts tests/agentManagerContracts.test.ts tests/agentManagerConfig.test.ts tests/assistantFallback.test.ts
PASS: 5 files, 47 tests

npm test -- --run tests/agentManagerOrchestrator.test.ts tests/agentManagerIntegrationSource.test.ts tests/agentManagerContracts.test.ts
PASS: 3 files, 25 tests

npm run typecheck
PASS

npm test
PASS: 58 files, 510 tests

git diff --check
PASS: no whitespace errors; line-ending warnings only

EXPECTED_PRODUCTION_COMMIT=afdfc62 node local-live-tests/agent-manager-optin-live-runner.mjs
PASS: real widget on https://bakautprof.ru/?agentHarness=1
```

## Key Proof Points

- `tests/dialogueLedgerReducer.test.ts`: proves AC2.1-AC2.4 behavior, including read-only `needState` derivation from ledger.
- `tests/agentManagerOrchestrator.test.ts`: proves ledger-derived active context, checkpoint recovery, final-answer-contract resume, lead capture before confirmation, unsupported-source blocking, and adjudication blocking.
- `tests/agentManagerComparisonResearch.test.ts`: proves visible comparison targets bind to catalog products, web research runs, and conflicts create data-quality issues.
- `tests/leadOutbox.test.ts`: proves external lead delivery failure remains in outbox for retry without buyer action.
- `tests/agentManagerRuntime.test.ts`: proves default-off runtime behavior and production widget URL opt-in through `?agentHarness=1`.
- `tests/assistantFallback.test.ts` and `tests/assistantControlPlaneGenerate.test.ts`: prove catalog/commercial fast-path semantics and wording now pass through LLM route/answer contracts, recovery continues the saved turn through LLM when deterministic commercial recovery is disabled, and local lead creation preserves the LLM-written contact-received confirmation.
- `tests/postAnswerVerifier.test.ts`: proves repeated contact requests are blocked and repairable after a lead/contact has already been created.
- `tests/agentManagerIntegrationSource.test.ts`: proves assistant/chat routes use session-aware harness activation, saved-turn recovery is attempted before buyer-visible error in the harness path, admin trace UI rendering is present, and health exposes runtime deploy/opt-in markers.

## Production Status

Production widget live verification is `PASS` through the real iframe on `https://bakautprof.ru/?agentHarness=1`.

Latest verified code commit: `afdfc62 Route technical orientation through LLM tools`.
Latest production marker after evidence-only commit: `5d1e310 Record LLM embedding intent evidence`.

Live session: `d0898323-c5c3-455e-9502-d93a050d5b87`.
Protocol: `local-live-tests/2026-05-20-agent-manager-harness-optin.production.md`.

Buyer-visible result:

- no schema/runtime/recovery error;
- no old household leakage;
- generator sizing stayed around the known load and unknown fridge caveat instead of jumping to 9.5-13 kW;
- catalog retrieval returned generator cards instead of cross-class embedding noise;
- product cards were filtered against the answer and current product intent;
- buyer contact was accepted once and the bot confirmed follow-up on availability/delivery.

The harness is still globally default-off and enabled for production verification by URL opt-in `?agentHarness=1`.

Done definition for this slice: `PASS`.
