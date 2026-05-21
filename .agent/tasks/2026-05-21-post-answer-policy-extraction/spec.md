# Post-Answer Verification Policy Extraction Spec

## Current Behavior

`src/ai/assistant.ts` still owns a deterministic post-answer verification policy helper that:

- trims the answer;
- audits fact claims;
- runs post-answer verification;
- attempts deterministic text repair when verification reports repairable issues;
- records before/after recovery metadata.

This behavior is pure policy/verification logic, but it is embedded in the oversized assistant runtime. The helper is also exposed through `assistantTestHooks.applyPostAnswerVerificationPolicy`, so tests depend on its behavior.

## Structural Improvement

Extract the helper into a focused module:

- `src/ai/postAnswerVerificationPolicy.ts`

`assistant.ts` should import and re-export the same helper through `assistantTestHooks` without changing the public test hook shape or runtime behavior.

## Validation

AC1. `assistant.ts` no longer defines the post-answer verification policy inline.

AC2. The extracted helper preserves the same input/output behavior and remains available through `assistantTestHooks.applyPostAnswerVerificationPolicy`.

AC3. Existing post-answer/assistant fallback tests pass.

AC4. `npm run lint:no-regex` proves no new regex constructs were added.

AC5. `npm run typecheck`, `npm run build`, and full `npm test` pass.

AC6. No production Promptfoo rerun is required for this pass because it is a pure extraction of deterministic helper code with no prompt/API/model/tool behavior change.
