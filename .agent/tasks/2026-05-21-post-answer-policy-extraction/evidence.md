# Post-Answer Verification Policy Extraction Evidence

## Refactor

- Added `src/ai/postAnswerVerificationPolicy.ts`.
- Updated `src/ai/assistant.ts` to import `applyPostAnswerVerificationPolicy`.
- Preserved `assistantTestHooks.applyPostAnswerVerificationPolicy`.

`assistant.ts` line count after extraction: `12649`.

## Validation

- `npm test -- tests/assistantFallback.test.ts tests/postAnswerVerifier.test.ts`
  - PASS: 2 files, 30 tests.
- `npm run typecheck`
  - PASS.
- `npm run lint:no-regex`
  - PASS: `No new regex constructs. Legacy baseline: 1832.`
- `npm run build`
  - PASS.
- `npm test`
  - PASS: 66 files, 562 tests.

## Production gate

Not rerun for this pass. The change is a pure extraction of deterministic helper code with no prompt text, API, model, tool, or business behavior change.
