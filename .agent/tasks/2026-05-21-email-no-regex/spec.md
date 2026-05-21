# Email No Regex Cleanup Spec

## Current Behavior

`src/email/httpEmail.ts` prepares lead email payloads, compacts whitespace, detects the Resend endpoint even with trailing slashes, removes transcript boilerplate from the lead question, and skips role-prefixed transcript lines.

The current implementation uses regex for those deterministic string operations.

## Structural Improvement

Replace the regex usage in `src/email/httpEmail.ts` with explicit string helpers:

- collapse whitespace by scanning characters;
- trim trailing URL slashes with a loop;
- detect label + optional whitespace + colon with string operations;
- detect role prefixes and the boilerplate contact line through normalized string comparison.

No prompt, LLM planning, public API, payload shape, or business behavior should change.

## Acceptance Criteria

AC1. `src/email/httpEmail.ts` contains no regex constructs according to `npm run lint:no-regex` after the legacy baseline is reduced.

AC2. Existing email behavior remains covered by `tests/httpEmail.test.ts`, including Resend payload format and transcript stripping.

AC3. The cleanup does not introduce new regex constructs anywhere else in the repository.

AC4. TypeScript typecheck passes.

AC5. Evidence records the baseline reduction and the validation commands.
