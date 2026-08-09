# Server turn-race fixer evidence

Date: 2026-08-09

Scope owned by this fixer:

- `src/db/repositories.ts`
- `src/ai/agentManagerOrchestrator.ts` lifecycle/finalization only
- `src/routes/chat.ts`
- directly related server tests

No client files, migrations, real OpenAI calls, live widget checks, commits, pushes, or deployments were performed.

## Reconfirmed defects

1. Final `answer_contracts`, assistant `messages`, and terminal `conversation_turns` state were persisted in separate operations. `addAssistantMessageForTurn` did not require the current execution owner, live lease, active status, or unexpired deadline, so a worker whose owner had been cleared by deadline expiry could complete a failed turn.
2. `getLatestUnansweredTurn` updated expired turns in a data-modifying CTE but selected the turn again from the statement's pre-update base-table snapshot.
3. the history route loaded pending state and messages in two repository statements, allowing a mixed restoration view.
4. after the one-active-turn unique violation, `createTurnWithUserMessage` returned `ActiveConversationTurnError(undefined)` when the conflicting active row completed before readback instead of retrying the atomic create once.
5. route failure updates and intermediate orchestrator updates had no compare-and-set guard against a completed/recovered turn or a replacement execution owner.

## RED signal

Command:

`npm.cmd test -- --run tests/conversationRepository.test.ts tests/chatSessionLifecycle.test.ts`

Result before implementation: exit 1; 6 failed, 35 passed. The failures independently covered the disappearing-active retry, post-expiry `RETURNING` state, fenced atomic terminal commit, terminal-state CAS, one-statement history snapshot, and route use of that snapshot.

## Minimal implementation

- The existing `execution_owner` is passed from `claimTurnExecution` through normal and degraded terminal paths.
- `addAssistantMessageForTurn` is now one PostgreSQL statement that locks only the current active turn with the matching owner, live lease, and live deadline; writes/updates the final answer contract; inserts the assistant message; terminalizes the turn; clears owner/lease; and touches the session. A lost fence returns no message, and the orchestrator emits no delta before a successful commit.
- Owner-scoped intermediate updates require the matching live owner/lease/deadline. Failure updates cannot downgrade `completed`/`recovered`, clear the failed execution lease, and route-level failure marking requires the turn to be unowned.
- Recovery of a failed turn claims it back into an active `answering` state only before the deadline and only when no other active turn exists.
- Deadline expiry reads use `UPDATE ... RETURNING conversation_turns.*`, exclude the base-table pre-update versions, and union the returned post-update rows.
- `getHistorySnapshot` returns messages and pending-turn state from one statement/snapshot; the route uses only that method.
- The one-active-turn collision path rereads the active ID and retries the same atomic create exactly once when the row has disappeared.

## GREEN signal

Command:

`npm.cmd test -- --run tests/conversationRepository.test.ts tests/conversationRepositoryAgentManager.test.ts tests/chatSessionLifecycle.test.ts tests/chatRouteAbort.test.ts tests/chatSse.test.ts tests/agentManagerOrchestrator.test.ts tests/agentManagerComparisonResearch.test.ts tests/agentManagerSearchBeforeSpecialistIntegration.test.ts`

Result: exit 0; 8 files passed, 230 tests passed.

Command:

`npm.cmd run typecheck`

Result: exit 0; client and server TypeScript projects completed with no diagnostics.

Command:

`git diff --check -- src/db/repositories.ts src/ai/agentManagerOrchestrator.ts src/routes/chat.ts tests/conversationRepository.test.ts tests/conversationRepositoryAgentManager.test.ts tests/chatSessionLifecycle.test.ts tests/agentManagerOrchestrator.test.ts`

Result: exit 0. Git reported only the repository's LF-to-CRLF working-copy warnings.

## Remaining integration gap

The repository SQL is covered by explicit query-contract tests, mapping tests, route tests, and orchestration tests, but it was not executed against a local PostgreSQL instance in this fixer pass. `psql` was not available and `docker compose ps --format json` could not connect because the Docker daemon was not running. No remote or production database was used as a substitute.
