# Problems found by independent verification

Date: 2026-07-11
Current status: all local blockers below are fixed and reverified; production proof remains pending.

## P1 — paused-need constraints leaked into the active topic

The ledger snapshot retained legacy `selectionState`/semantic budget and exposed facts/rejections from paused needs globally. A generator budget could therefore filter plate cards after a topic switch.

Resolution:

- snapshot global facts/constraints/selection are now scoped to the current need;
- legacy semantic/selection state is reset once the durable ledger is authoritative;
- paused needs retain their own state for later resume without affecting current card filtering;
- answered/closed questions are removed from their need;
- budget lookup reads only the focused need and recognizes the structured ledger budget keys.

Proof: `tests/dialogueLedgerReducer.test.ts`, `tests/agentManagerOrchestrator.test.ts`, final full gate.

## P1 — unsupported strict hard constraints failed open

The planner could emit a new strict kind such as `noise_max_db`, while deterministic code only checked a known subset. A selected product with no noise evidence could remain visible.

Resolution:

- strict requirements are classified before product evidence reaches the writer;
- unsupported, unverifiable or invalid strict requirements suppress all answer products and final cards;
- known numeric/phase/quantity and mechanically verifiable material forms remain supported;
- the planner is explicitly told that a real hard constraint must not be downgraded to bypass this gate.

Proof: new unknown-kind and invalid-value regressions in `tests/agentManagerCardSelection.test.ts`; orchestrator pre-writer enforcement; final full gate.

## P2 — literal AC1 proof stopped at repository identity

Repository tests proved distinct `clientMessageId` values, but did not show the same surface text traversing two sequential manager turns with different context.

Resolution: an orchestrator integration sends identical `Да` actions twice and proves two user records, two assistant saves, distinct turn/event IDs and writer histories containing one then two buyer turns.

## P2 — long-memory proof counted events rather than real messages

The initial >80 regression proved reducer event replay but not the complete 80+ message requirement or contact/source retention.

Resolution: a 90-message orchestrator regression loads a persisted snapshot plus tail and asserts current objective, hard budget/facts, open question, selected/rejected products, contact approval, source URL/evidence and newest-80 planner context.

## P2 — dead production flags and unfinished security ledger

`DYNAMIC_SALES_POLICY_ENABLED` and `DYNAMIC_SALES_POLICY_SHADOW_MODE` were parsed but had no effect on the mandatory AgentManager runtime. The security coverage ledger still labeled all rows temporary `open_frontier`.

Resolution:

- dead env flags removed; unreachable legacy compatibility uses explicit local defaults;
- all 27 security coverage rows finalized with concrete dispositions, candidates, controls and disclosed residuals consistent with validation/attack-path reports.

## P1 — catalog facts could bypass semantic verification

The writer could recommend a real selected product but invent its price or specification while returning `factsUsed=[]`. In risk mode this could skip the reviewer, and a partial mechanical rewrite could preserve the false claim.

Resolution:

- current catalog products and selected IDs now force semantic fact review in risk mode;
- reviewer instructions require an independent comparison of every stated product attribute even when `factsUsed=[]`;
- every semantic rewrite is independently rechecked and fails closed;
- selected IDs absent from writer evidence block the answer.

## P1 — selected cards were not durable semantic state

The initial LLM ledger delta runs before tools and cannot know final validated card IDs. Without a post-selection event, a structured `reusePreviousCards=true` turn normally had no allowed IDs and discarded all previous cards.

Resolution:

- actual final visible IDs are persisted as an idempotent `system_reducer` need event after the final deadline gate;
- final answer contract, visible cards and need ledger use the same IDs;
- no-card technical/commercial follow-ups do not clear the prior selection;
- a three-turn integration proves select, resume and no-card preservation behavior.

## P1 — provider budget used logical estimates instead of request ceilings

The old budget counted fixed per-stage costs and output reservations but not every physical retry, actual serialized input, embeddings or hosted web reserves. Catalog products were also duplicated in writer/reviewer request bodies.

Resolution:

- the central OpenAI wrapper now reserves every physical request prospectively using a conservative UTF-8 byte upper bound, output limit and versioned price ceiling;
- unknown pricing or missing output limits fail closed;
- global daily reservations reuse the same total estimate;
- model-facing catalog artifacts omit the duplicate product array while durable artifacts remain exact;
- coherent operational limits and boundary regressions cover input/output/total/cost and retry paths.

## P1 — late wall deadline could downgrade a committed answer

A final wall-time assertion ran after durable answer/assistant work. Crossing the deadline during finalization could mark an already committed turn failed.

Resolution:

- the final deadline gate now runs before selection persistence and final commit;
- after final contract commit, a wall abort recovers that exact payload rather than producing `budget_stopped`;
- regressions cover pre-commit timeout, deadline crossing during commit and post-commit delivery failure.

## P2 — strict tool schemas exposed legacy universal test fixtures

Per-tool schemas correctly rejected generic foreign fields, but one comparison-research suite still generated old universal fixture args. Early rejection left queued research mocks and caused a misleading cascade.

Resolution: the suite now modernizes fixtures at its test boundary while production validation remains strict; the complete comparison-research suite passes 17/17.

## Reverification

- focused semantic/card/orchestrator suite: PASS;
- typecheck: PASS;
- no-regex delta: PASS;
- final independent `npm run verify`: 105 files, 918 tests PASS; 251 agentic eval tests PASS; typecheck, no-regex, build and production audit PASS.
