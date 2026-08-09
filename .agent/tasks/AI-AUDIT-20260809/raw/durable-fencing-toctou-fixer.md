# H1/H6/M1 durable fencing and TOCTOU fixer evidence

Date: 2026-08-09 (Europe/Moscow)

Mode: BUILD. This is raw builder evidence, not a verifier verdict.

## Owned scope

Production changes were limited to:

- `src/db/repositories.ts`: `ConversationRepository` lifecycle section only (through `addUserMessageForTurn`; `ProductRepository` starts later and was not edited for this tranche).
- `src/ai/agentManagerOrchestrator.ts`: execution-owner propagation into turn-owned durable writes and final-checkpoint handoff.
- `src/routes/chat.ts`: atomic message-acceptance capability handoff, atomic close, and non-disclosing unavailable-session mapping.
- `src/client/chatStream.ts`, `src/client/main.tsx`: definitive pre-acceptance 4xx typing and identity-safe 404 rollback.
- Directly coupled tests: `tests/conversationRepository.test.ts`, `tests/conversationRepositoryAgentManager.test.ts`, `tests/chatSessionLifecycle.test.ts`, `tests/chatStream.test.ts`, and the lifecycle fake in `tests/agentManagerOrchestrator.test.ts`.

No ProductRepository/catalog/verified-fact migration work was touched. No commit, push, deploy, database migration, external write, or production live test was performed.

## Implemented behavior

### H1: durable mutation fencing

- Added typed `TurnMutationFenceError` (`turn_mutation_not_owner_or_not_live`). Zero-row fenced mutations reject instead of silently continuing.
- `updateNeedState`, ledger event, ledger snapshot, turn checkpoint, tool artifact, draft/rejected answer contract, legacy user-message linking, owner-scoped `updateTurn`, and final assistant commit now check in their own SQL statement:
  - active `conversation_sessions` row;
  - exact `execution_owner`;
  - active turn status;
  - unexpired execution lease;
  - unexpired absolute deadline.
- Each fence locks the active session row before the turn row, so close/final/intermediate mutations use the same lock order and cannot pass only a pre-await guard.
- Same-owner retries remain idempotent through the existing event/checkpoint/artifact/contract upserts. Snapshot replacement retains the monotonic cursor predicate `through_event_seq <= EXCLUDED.through_event_seq`.
- The `assistant_message_saved` checkpoint moved into the already-fenced final answer/message/turn statement. There is no post-terminal unfenced checkpoint write after `execution_owner` is cleared.
- `AgentManagerOrchestrator` now supplies the claimed `executionOwner` to every directly coupled durable writer.

Ledger event, derived need state, and ledger snapshot remain separate statements. They were not expanded into a new multi-operation transaction in this bounded tranche; each statement is independently owner/lifecycle-fenced and the snapshot cursor is monotonic, which is the explicitly allowed minimum in the assignment.

### H6: atomic session lifecycle gate

- `createTurnWithUserMessage` now requires the exact visitor capability and locks a session that is simultaneously `active` and within the heartbeat window before expired-turn cleanup, turn insertion, user-message insertion/linking, and heartbeat touch can execute.
- Empty authorization returns typed `ConversationSessionUnavailableError`; payload conflict remains distinguishable only after exact capability authorization, avoiding a cross-session existence oracle.
- Unique-active-turn readback is also capability/status/heartbeat scoped.
- `closeSession` now takes the visitor capability and performs, in one SQL statement, exact capability + heartbeat authorization, active-turn terminalization, execution-owner/lease revocation, pending-draft anonymization, and session close.
- Final assistant commit first locks an active session and then the owned turn. A close that wins the session lock prevents final persistence; a final that wins completes while the session is still active, after which close serializes behind it.
- Claim, recovery-attempt bookkeeping, renewal, and owner-scoped turn update also require an active session.

### M1: definitive pre-acceptance rollback

- `ChatMessageNotAcceptedError` now carries the HTTP status. Every pre-stream 4xx is treated as not accepted; 409 still carries `activeTurnId` only when recovery is possible.
- The existing optimistic user/assistant pair rollback and input restoration now also apply to 404.
- A 404 clears only the exact session used by that failed request: storage clearing uses `abandonSavedChat` identity matching, and React state is cleared only when its current value still equals `attemptedSessionId`. A newer raced session is preserved.

## RED proof

Command:

```text
npm.cmd test -- tests/conversationRepository.test.ts tests/conversationRepositoryAgentManager.test.ts tests/chatSessionLifecycle.test.ts tests/chatStream.test.ts
```

Initial result before implementation: exit 1; 4 files; 12 failed, 53 passed (65 total). Expected failures covered missing SQL fences, non-atomic close/create capability handoff, missing active-session final gate/checkpoint atomicity, missing typed repository errors, and generic 404 client handling.

The first connected orchestrator run after removing the unsafe legacy message fallback also exposed one directly coupled test fake without `addUserMessageForTurn`:

```text
npm.cmd test -- tests/agentManagerOrchestrator.test.ts tests/agentManagerComparisonResearch.test.ts tests/agentManagerSearchBeforeSpecialistIntegration.test.ts tests/chatHistory.test.ts tests/leadRoutes.test.ts tests/leadSubmit.test.ts tests/promptfooProvider.test.ts
```

Intermediate result: exit 1; 1 failed, 224 passed. Exact failure: `TypeError: this.conversations.addUserMessageForTurn is not a function` in the sequential-turn lifecycle fixture. The fixture was updated to implement the production atomic user-message contract; the production fallback to unfenced `addMessage` was not restored.

## Fresh GREEN checks

Targeted H1/H6/M1:

```text
npm.cmd test -- tests/conversationRepository.test.ts tests/conversationRepositoryAgentManager.test.ts tests/chatSessionLifecycle.test.ts tests/chatStream.test.ts
```

Result: exit 0; 4 files passed; 65 tests passed.

Connected orchestrator/history/lead/provider contracts:

```text
npm.cmd test -- tests/agentManagerOrchestrator.test.ts tests/agentManagerComparisonResearch.test.ts tests/agentManagerSearchBeforeSpecialistIntegration.test.ts tests/chatHistory.test.ts tests/leadRoutes.test.ts tests/leadSubmit.test.ts tests/promptfooProvider.test.ts
```

Result: exit 0; 7 files passed; 225 tests passed.

Typecheck:

```text
npm.cmd run typecheck
```

Result: exit 0; both client and server TypeScript projects completed with no diagnostics.

Regex guard:

```text
npm.cmd run lint:no-regex
```

Final result after the concurrent H7 owner removed their unrelated new regex: exit 0; `No new regex constructs. Legacy baseline: 508.`

Owned-file diff hygiene:

```text
git diff --check -- src/db/repositories.ts src/ai/agentManagerOrchestrator.ts src/routes/chat.ts src/client/chatStream.ts src/client/main.tsx tests/conversationRepository.test.ts tests/conversationRepositoryAgentManager.test.ts tests/chatSessionLifecycle.test.ts tests/chatStream.test.ts
```

Result: exit 0. Git emitted only line-ending conversion warnings; no whitespace errors.

## Validation boundaries and follow-up

- No live two-connection PostgreSQL barrier test exists in the current test stack, so lock ordering and same-statement SQL fencing are proven by contract/SQL-shape tests and code inspection, not by a real database race reproduction. A disposable-DB concurrency fixture remains useful verifier follow-up.
- No full repository suite was run in this tranche; directly connected local coverage is 290 passing tests plus typecheck and regex guard.
- No production widget check was run because this task explicitly forbade commit/push/live changes. Production behavior is therefore not claimed validated.
- Cheap review of the requested lead-hydration gap found no existing durable public-history signal for a successful local lead form submission. `publicHistoryMessage` exposes `leadRequested` from the assistant offer contract, while lead submission does not update that assistant history row; `restoreSavedChatSession` can therefore see only the old offer. Correctly suppressing the form after reload requires a server/public-history contract that exposes a capability-scoped durable lead-created/lead-consumed marker (or updates the originating message). That schema/API expansion was deliberately left as a follow-up rather than adding a client-only guess.
