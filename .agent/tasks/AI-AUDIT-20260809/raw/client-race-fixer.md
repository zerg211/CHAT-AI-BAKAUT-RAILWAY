# Client race fixer evidence

Task: `AI-AUDIT-20260809`
Ownership: client only (`src/client/chatStream.ts`, `src/client/main.tsx`, `tests/chatStream.test.ts`).
Mode: fresh-review fixer tranche; no server, catalog, ledger, orchestrator, commit, push, or live mutations.

## Findings and owning fixes

1. A 409 response without a valid `activeTurnId` fell through to a generic error. The optimistic buyer message stayed visible even though the server had rejected it, and the cleared composer text was not restored.
   - `ChatMessageNotAcceptedError` now represents every HTTP 409.
   - `ActiveConversationTurnError` remains its ID-bearing subtype.
   - `main.tsx` handles the base type by removing both optimistic rows, restoring the exact buyer text, and showing an honest non-acceptance error.
   - Recovery is gated only by a non-empty `activeTurnId`; a missing ID never causes a guessed recovery call.
2. Pending-turn hydration used a local `AbortController`, while the Stop button aborted only the shared `abortRef`.
   - `registerChatAbortController` is the single ownership helper for normal submit and hydrate recovery controllers.
   - The helper clears the slot on abort or completion only when it still owns the slot. An older abort/finally cannot clear a newer controller.
   - Stop now reaches hydrate recovery through the shared slot. An intentional stop renders `Ответ остановлен.` instead of a recovery-failure claim.

## Test-first record

### RED 1 — rejected 409 and missing hydrate ownership

Command:

`npm.cmd test -- --run tests/chatStream.test.ts`

Result: exit 1; 3 failed, 12 passed.

- main did not register the pending controller in the shared slot or handle the base non-accepted error;
- `registerChatAbortController` did not exist;
- a 409 without `activeTurnId` did not produce the typed non-accepted contract.

### RED 2 — abort must clear only the owned slot

Command:

`npm.cmd test -- --run tests/chatStream.test.ts`

Result: exit 1; 1 failed, 14 passed. Aborting the currently registered controller left the slot populated.

### GREEN

Focused command:

`npm.cmd test -- --run tests/chatStream.test.ts`

Result: exit 0; 1 file passed, 15 tests passed.

Connected client command:

`npm.cmd test -- --run tests/chatStream.test.ts tests/chatHistory.test.ts tests/leadSubmit.test.ts tests/promptfooProvider.test.ts tests/app.test.ts`

Result: exit 0; 5 files passed, 50 tests passed.

Additional checks:

- `npm.cmd run lint:no-regex` — exit 0, no new regex constructs, legacy baseline 508.
- `git diff --check -- src/client/chatStream.ts src/client/main.tsx tests/chatStream.test.ts` — exit 0; only LF-to-CRLF notices.
- `npm.cmd run typecheck` — exit 1 because the concurrent server fixer intentionally still held RED repository contracts in `tests/conversationRepository.test.ts`: unsupported `executionOwner` (line 532), unsupported `requireUnowned` (line 562), and missing `getHistorySnapshot` (line 597). No client TypeScript error was reported. The root owner will rerun the shared gate after the server tranche reaches GREEN.

## UI-test boundary

The repository does not include a React DOM behavior-test stack such as Testing Library plus jsdom/happy-dom. No dependency was added. The race itself is exercised through the pure controller ownership helper, including stale release, old abort, current abort, and slot clearing. A source-level integration assertion verifies that hydration, Stop, the 409 rollback branch, input restoration, and ID-gated recovery are wired to that tested contract. Rendered click behavior remains for the later production-widget/live gate.

Scoped local signal: implementation and focused/connected client tests are green. Shared-worktree typecheck remains externally blocked by the explicitly identified concurrent server RED and is not claimed green by this fixer.
