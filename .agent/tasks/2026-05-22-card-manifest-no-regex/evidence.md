# Evidence: card manifest no regex

## Change

Removed regex usage from `src/ai/cardManifest.ts`.

Card manifest now uses explicit deterministic string helpers for:

- whitespace compaction;
- product-class signal matching;
- fuel signal matching;
- 220/230 V and 380/400 V phase signal matching.

The LLM/code boundary is unchanged: the LLM still supplies structured intent and constraints through the execution contract; `cardManifest` only validates visible cards against those structured constraints.

## Validation

- `npx vitest run tests/cardManifest.test.ts` PASS
  - 1 test file passed
  - 7 tests passed
- `npm run lint:no-regex -- --update-baseline` PASS
  - Updated legacy baseline to 1697 findings.
- `npm run lint:no-regex` PASS
  - No new regex constructs.
  - Previous baseline: 1723.
  - Current baseline: 1697.
  - Removed 26 legacy regex findings from `src/ai/cardManifest.ts`.
- `npm run typecheck` PASS
- `npm test` PASS
  - 82 test files passed
  - 672 tests passed
- `npm run build` PASS
- `git diff --check` PASS
  - Git reported CRLF normalization warnings only, no whitespace errors.

## Acceptance Criteria

- AC1 PASS: `src/ai/cardManifest.ts` contains no remaining regex findings in the updated baseline.
- AC2 PASS: no new regex constructs were added.
- AC3 PASS: existing card manifest behavior remains covered and passing.
- AC4 PASS: focused tests cover product-class mismatch, gasoline/petrol fuel matching, compact 230V/1-ф matching, and three-phase diesel violation detection.
- AC5 PASS: no-regex guard passes with baseline reduced from 1723 to 1697.
- AC6 PASS: focused tests, typecheck, full tests, build, and diff check passed.
- AC7 PASS: production eval was not run because this pass only changes deterministic card-manifest parity checks; prompts, answer policy, product selection, tool policy, and widget-visible behavior are unchanged.

## Notes

This is one small no-regex refactor pass toward the broader modernization goal. It does not complete the overall goal.
