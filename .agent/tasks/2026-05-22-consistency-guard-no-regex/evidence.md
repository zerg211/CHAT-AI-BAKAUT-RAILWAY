# Evidence: consistency guard no regex

## Change

Removed regex usage from `src/ai/consistencyGuard.ts`.

The price consistency guard now uses explicit scanners for:

- standalone price string detection;
- RUB price mention extraction with spaces inside the number;
- currency suffix recognition for `₽`, `руб`, and `р.`.

Public exports stayed stable: `ConsistencyGuard`, `getSessionGuard`, and `cleanupSessionGuard`.

## Validation

- `npx vitest run tests/consistencyGuard.test.ts` PASS
  - 1 test file passed
  - 5 tests passed
- `npm run lint:no-regex -- --update-baseline` PASS
  - Updated legacy baseline to 1691 findings.
- `npm run lint:no-regex` PASS
  - No new regex constructs.
  - Previous baseline: 1697.
  - Current baseline: 1691.
  - Removed 6 legacy regex findings from `src/ai/consistencyGuard.ts`.
- `npm run typecheck` PASS
- `npm test` PASS
  - 83 test files passed
  - 677 tests passed
- `npm run build` PASS
- `git diff --check` PASS
  - Git reported CRLF normalization warnings only, no whitespace errors.

## Acceptance Criteria

- AC1 PASS: `src/ai/consistencyGuard.ts` contains no remaining regex findings in the updated baseline.
- AC2 PASS: no new regex constructs were added.
- AC3 PASS: focused tests cover fact recording, no warning for the same price, warning for a different RUB price, unrelated products, and restore from history.
- AC4 PASS: public exports stayed stable.
- AC5 PASS: no-regex guard passes with baseline reduced from 1697 to 1691.
- AC6 PASS: focused tests, typecheck, full tests, build, and diff check passed.
- AC7 PASS: production eval was not run because this pass only changes deterministic consistency scanning; prompts, answer policy, product selection, tool policy, and widget-visible behavior are unchanged.

## Notes

This is one small no-regex refactor pass toward the broader modernization goal. It does not complete the overall goal.
