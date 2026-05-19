# Task Spec: agent-manager-harness

## Metadata

- Task ID: `agent-manager-harness`
- Frozen: 2026-05-19T21:41:49+03:00
- Repo root: `C:\Projects\chatAI`
- Status: working harness slice implemented locally; production rollout/live verification pending
- Primary implementation spec: `docs/plans/agent-manager-harness-implementation-spec.md`
- Primary implementation spec SHA256: `C14FA60B1B290A751019E16B946946918F95FD54D795CB04D4A76FA08507068B`
- Root-cause report: `local-live-tests/2026-05-19-dialog-1057-code-root-cause-report.md`
- Production evidence source: dialogue `#1057`, session `24f862af-6364-4e12-8a77-6feba6f38cd7`

## Objective

Implement the AI-manager harness described in `docs/plans/agent-manager-harness-implementation-spec.md` so the BAKAUT iframe chat behaves as an intelligent sales/support manager, not as deterministic templates, regex routes, append-only state, or generic fallbacks.

## Frozen Working Documents

Work must be performed from these documents:

1. `docs/plans/agent-manager-harness-implementation-spec.md`
   - Implementation source of truth.
   - Contains target architecture, DB schemas, TypeScript contracts, prompt contracts, tool contracts, recovery policy, migration phases, acceptance criteria, tests, rollout, rollback, and done definition.
2. `local-live-tests/2026-05-19-dialog-1057-code-root-cause-report.md`
   - Root-cause and rationale document.
   - Explains dialogue #1057 failures and why the implementation spec exists.
3. This file: `.agent/tasks/agent-manager-harness/spec.md`
   - Frozen task entrypoint for repo-task-proof-loop.
   - Pins the implementation spec by SHA256.

If the implementation spec changes, this task spec must be updated with the new hash before implementation continues.

Historical task folders under `.agent/tasks/*` are not implementation sources for this work. They can be used only as old evidence if explicitly referenced from the active spec.

## Non-Negotiable Constraints

- LLM owns semantic understanding, dialogue strategy, tool-result evaluation, comparison logic, and final wording.
- Code owns durable state, typed tool execution, calculations, schema validation, policy enforcement, idempotency, checkpoints, and persistence.
- Code must not choose buyer intent with regex and render final text.
- Deterministic technical templates must not be user-visible for enabled capabilities.
- If buyer message is saved, generation failure must recover the same turn from checkpoints; do not ask the buyer to repeat the question and do not show generic error.
- Delivery, exact stock, discounts, dates, services, and special terms require specialist/logistics/manager verification unless backed by an internal authoritative fact.
- Old fast paths cannot coexist as alternative user-visible answer writers for the same enabled capability.
- No manual Railway deploy unless explicitly requested by the user.

## Implementation Phases

Implement phases exactly as specified in the primary implementation spec:

1. Phase 0: Spec freeze.
2. Phase 1: Contracts and schemas.
3. Phase 2: DialogueLedger reducer.
4. Phase 3: AgentOrchestrator shell.
5. Phase 4: LLM answer step for generator technical answers.
6. Phase 5: Turn checkpoint recovery.
7. Phase 6: AnswerContract and reviewer.
8. Phase 7: Catalog and comparison research.
9. Phase 8: Lead outbox.
10. Phase 9: Admin trace and evals.

Do not start later behavior-changing phases until earlier acceptance criteria pass.

## Acceptance Criteria

The acceptance criteria are the `AC*` items in `docs/plans/agent-manager-harness-implementation-spec.md`.

This task is complete only when:

- every phase AC passes;
- unit, integration, and regression eval tests pass;
- behavior-changing phases have production widget live protocols saved under `local-live-tests/*.production.md`;
- old user-visible deterministic paths are disabled or deleted for enabled capabilities;
- saved-turn generic error is not user-visible;
- admin trace can explain why the bot asked, selected, compared, researched, recovered, or created a lead.

## Required Evidence

Implementation evidence must be saved under `.agent/tasks/agent-manager-harness/`:

- `evidence.md`
- `evidence.json`
- raw command outputs and live-test protocols or links to them
- verifier result
- `problems.md` if verification is not PASS

## First Implementation Slice

The first implementation slice must be limited to:

- Phase 1 contracts and schemas;
- DB migration scaffolding for core tables;
- Phase 2 `DialogueLedgerReducer`;
- tests for contract validation, event idempotency, fact supersede/negate, and question closing.

Do not change production behavior in the first slice.
