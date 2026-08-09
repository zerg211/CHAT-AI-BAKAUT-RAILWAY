# Session/turn lifecycle builder evidence

Task: `AI-AUDIT-20260809`
Builder scope: P0 session capability, atomic user-message/turn persistence, pending-turn history and widget hydration/recovery, stale orphan terminalization, honest second-message/error handling, and directly coupled lead/Promptfoo producers.
Mode: BUILD. This artifact is builder evidence only and does not claim the task-wide verifier verdict.

## Implemented contract

- All session-scoped chat routes (`history`, `heartbeat`, `send`, `recover`, `close`, `feedback`) require the exact `x-bakaut-visitor-id` capability before route-owned side effects. Missing, wrong, inactive, and nonexistent sessions receive the same 404 shape.
- Lead capture requires the same capability before lead/draft writes. The widget lead producer sends it.
- The Promptfoo chat producer retains the exact visitor ID used for session creation and sends it on `send`, `recover`, and `close`; it does not put the capability in result output.
- `ConversationRepository.restoreSession` includes visitor identity in the locked candidate query, so a wrong capability cannot touch, expire, or otherwise mutate a foreign session.
- `createTurnWithUserMessage` creates/gets the turn, inserts/gets the user message, links both, touches the session, and terminalizes expired active turns in one SQL statement. The old route-level turn-without-message path was removed.
- Idempotent replay preserves an already progressed/completed turn's `stage` and `active_needs_before`; the reachable legacy `addUserMessageForTurn` path has the same preservation rule.
- History exposes only the typed pending-turn allowlist: `turnId`, `status`, `stage`, `deadlineAt`, `terminal`, and `resultState`. Expired unanswered turns are atomically marked terminal failed before being returned.
- Widget hydration restores pending/result-ready turns by their persisted `turnId`, uses the completed result path, and blocks interaction while hydration/recovery is active.
- An active-turn conflict carries `activeTurnId`; the optimistic second user/assistant pair is removed, the unsent text is restored to the input, and recovery/history uses the active turn.
- Generic transport errors no longer claim that an unconfirmed message was persisted.
- Lead form auto-open is driven only by the most recent assistant message; an old lead offer no longer reopens after a newer assistant response.

## Test-first evidence

Initial RED regressions, before implementation:

1. `npm.cmd test -- --run tests/conversationRepository.test.ts tests/chatSessionLifecycle.test.ts`
   - Exit 1: 6 failed, 30 passed.
   - Demonstrated missing capability guards/side-effect ordering, missing atomic repository contract, and unsafe restore candidate behavior.
2. `npm.cmd test -- --run tests/conversationRepository.test.ts tests/chatHistory.test.ts`
   - Exit 1: 2 failed, 45 passed.
   - Demonstrated missing stale-orphan/latest-unanswered query and missing typed `pendingTurn` response.
3. `npm.cmd test -- --run tests/chatHistory.test.ts tests/chatStream.test.ts tests/leadSubmit.test.ts`
   - Exit 1: 8 failed, 26 passed.
   - Demonstrated missing capability headers, active-turn typed error/recovery consumer, pending hydration state, and honest client error contract.
4. `npm.cmd test -- --run tests/conversationRepository.test.ts`
   - Exit 1: 2 failed, 31 passed.
   - Demonstrated that both atomic replay and the reachable legacy user-message linker would unconditionally downgrade `stage` to `user_message_saved`.
5. `npm.cmd test -- --run tests/chatHistory.test.ts`
   - Exit 1: 1 failed, 17 passed.
   - Demonstrated that any historical assistant lead offer incorrectly reopened the form.
6. `npm.cmd test -- --run tests/promptfooProvider.test.ts`
   - Exit 1: 1 failed, 7 passed.
   - Demonstrated missing visitor capability on Promptfoo `send`, `recover`, and `close`.

Final GREEN checks against the current shared worktree:

1. Targeted lifecycle suite:
   - Command: `npm.cmd test -- --run tests/conversationRepository.test.ts tests/chatSessionLifecycle.test.ts tests/chatHistory.test.ts tests/chatStream.test.ts tests/leadRoutes.test.ts tests/leadSubmit.test.ts tests/chatRouteAbort.test.ts tests/promptfooProvider.test.ts`
   - Exit 0: 8 files passed, 94 tests passed.
2. Connected route/client/orchestrator/provider suite:
   - Command: `npm.cmd test -- --run tests/app.test.ts tests/promptfooProvider.test.ts tests/agentManagerOrchestrator.test.ts tests/chatSse.test.ts tests/chatRouteAbort.test.ts tests/chatHistory.test.ts tests/chatStream.test.ts tests/chatSessionLifecycle.test.ts tests/conversationRepository.test.ts tests/leadRoutes.test.ts tests/leadSubmit.test.ts`
   - Exit 0: 11 files passed, 245 tests passed.
3. TypeScript producer/consumer contracts:
   - Command: `npm.cmd run typecheck`
   - Exit 0 (`tsconfig.json` and `tsconfig.server.json`).
4. Production build:
   - Command: `npm.cmd run build`
   - Exit 0; Vite client build and server TypeScript emit completed.
5. Regex guard:
   - Command: `npm.cmd run lint:no-regex`
   - Exit 0: `No new regex constructs. Legacy baseline: 508.`
6. Patch hygiene:
   - Command: `git diff --check`
   - Exit 0. Output contained only existing Windows LF-to-CRLF notices, no whitespace errors.

## Files in builder scope

- `src/routes/chat.ts`
- `src/routes/leads.ts`
- session/turn methods in `src/db/repositories.ts`
- `src/client/chatStream.ts`
- `src/client/chatHistory.ts`
- `src/client/main.tsx`
- `src/client/leadSubmit.ts`
- `evals/promptfoo/chat-app-provider.cjs`
- `tests/conversationRepository.test.ts`
- `tests/chatSessionLifecycle.test.ts`
- `tests/chatHistory.test.ts`
- `tests/chatStream.test.ts`
- `tests/leadRoutes.test.ts`
- `tests/leadSubmit.test.ts`
- `tests/chatRouteAbort.test.ts` (validation only)
- `tests/promptfooProvider.test.ts`

## Boundaries and remaining proof

- No catalog, enrichment, ledger, or orchestrator production code was edited by this builder. Other agents' concurrent worktree changes were preserved.
- SQL atomicity and state-transition contracts are covered by focused repository tests and SQL inspection; this builder did not run a real PostgreSQL integration transaction/fault-injection test.
- The full repository unit suite was not run by this builder; the bounded connected suite above was run. Task-wide AC10 remains for the root builder/verifier.
- No OpenAI call, commit, push, Railway deployment, production marker readback, or embedded `bakautprof.ru` widget test was performed. Production/live acceptance remains unverified until the repository proof loop reaches those stages.
- No secret values were read, logged, added to fixtures, or included in this artifact.

Local contract signal: met for the scoped implementation and listed checks. Task-wide primary/live signal: not yet established by this builder.
