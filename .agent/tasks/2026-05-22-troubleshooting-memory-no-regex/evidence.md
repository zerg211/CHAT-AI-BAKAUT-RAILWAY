# Evidence: troubleshooting memory no regex

## Change

Removed regex usage from `src/ai/troubleshootingMemory.ts`.

The module now uses explicit scanners for:

- whitespace compaction;
- alphanumeric problem tokenization;
- diagnostic-term bounded fault-code extraction;
- fault-code validation and normalization.

Public exports stayed the same. This is deterministic memory indexing for sourced troubleshooting answers, not buyer-intent planning or answer-policy behavior.

## Validation

- `npx vitest run tests/troubleshootingMemory.test.ts` PASS
  - 1 test file passed
  - 6 tests passed
- `npm run lint:no-regex -- --update-baseline` PASS
  - Updated legacy baseline to 1729 findings.
- `npm run lint:no-regex` PASS
  - No new regex constructs.
  - Legacy baseline: 1729.
  - Previous baseline: 1745.
  - Removed 16 legacy regex findings from `src/ai/troubleshootingMemory.ts`.
- `npm run typecheck` PASS
- `npm test` PASS
  - 81 test files passed
  - 665 tests passed
- `npm run build` PASS
- `git diff --check` PASS
  - Git reported CRLF normalization warnings only, no whitespace errors.

## Acceptance Criteria

- AC1 PASS: `src/ai/troubleshootingMemory.ts` has no remaining regex findings in the updated baseline.
- AC2 PASS: no new regex constructs were added.
- AC3 PASS: existing troubleshooting memory behavior remains covered and passing.
- AC4 PASS: added focused tests for code-before-term, spaced/hyphenated code, and non-diagnostic catalog-like codes.
- AC5 PASS: no-regex guard passes with baseline reduced from 1745 to 1729.
- AC6 PASS: focused tests, typecheck, full tests, build, and diff check passed.
- AC7 PASS: production eval was not run because this pass does not change prompts, answer policy, product selection, or visible widget behavior.

## Notes

This is one small no-regex refactor pass toward the broader modernization goal. It does not complete the overall goal.
