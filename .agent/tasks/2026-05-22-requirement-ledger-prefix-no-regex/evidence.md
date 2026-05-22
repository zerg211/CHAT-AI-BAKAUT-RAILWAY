# Evidence: requirement ledger prefix no regex

## Change

Removed regex usage from `src/ai/requirementLedger.ts`.

`hardConstraintKeys` now strips the fixed internal `selection:` prefix with an explicit `startsWith`/`slice` helper instead of regex.

The LLM/code boundary is unchanged: the LLM supplies structured semantic memory and selection constraints, while code produces deterministic ledger metadata and warnings.

## Validation

- `npx vitest run tests/requirementLedger.test.ts` PASS
  - 1 test file passed
  - 3 tests passed
- `npm run lint:no-regex -- --update-baseline` PASS
  - Updated legacy baseline to 1689 findings.
- `npm run lint:no-regex` PASS
  - No new regex constructs.
  - Previous baseline: 1691.
  - Current baseline: 1689.
  - Removed 2 legacy regex findings from `src/ai/requirementLedger.ts`.
- `npm run typecheck` PASS
- `npm test` PASS
  - 83 test files passed
  - 678 tests passed
- `npm run build` PASS
- `git diff --check` PASS
  - Git reported CRLF normalization warnings only, no whitespace errors.

## Acceptance Criteria

- AC1 PASS: `src/ai/requirementLedger.ts` contains no remaining regex findings in the updated baseline.
- AC2 PASS: no new regex constructs were added.
- AC3 PASS: focused tests verify `hardConstraintKeys` emits unprefixed keys including `exactModelTokens`.
- AC4 PASS: existing hard-constraint semantic mirror warnings remain covered and passing.
- AC5 PASS: no-regex guard passes with baseline reduced from 1691 to 1689.
- AC6 PASS: focused tests, typecheck, full tests, build, and diff check passed.
- AC7 PASS: production eval was not run because this pass only changes deterministic metadata prefix handling; prompts, answer policy, product selection, tool policy, and widget-visible behavior are unchanged.

## Notes

This is one small no-regex refactor pass toward the broader modernization goal. It does not complete the overall goal.
