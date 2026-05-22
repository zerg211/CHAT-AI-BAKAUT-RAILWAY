# Evidence: response utils type signals no regex

## Change

Removed regex usage from `src/ai/responseUtils.ts`.

Provider response `type` classification now uses explicit lowercase substring checks for:

- web search markers: `web_search`, `search_result`, `url_citation`;
- text markers: `output_text`, `message`, `text`;
- citation markers: `url_citation`, `web_search`, `search_result`, `citation`.

Public exports stayed stable: `safeError`, `logOpenAIUsage`, `responseUsedWebSearch`, `extractResponseText`, and `extractUrlCitations`.

## Validation

- `npx vitest run tests/responseUtils.test.ts` PASS
  - 1 test file passed
  - 4 tests passed
- `npm run lint:no-regex -- --update-baseline` PASS
  - Updated legacy baseline to 1723 findings.
- `npm run lint:no-regex` PASS
  - No new regex constructs.
  - Previous baseline: 1729.
  - Current baseline: 1723.
  - Removed 6 legacy regex findings from `src/ai/responseUtils.ts`.
- `npm run typecheck` PASS
- `npm test` PASS
  - 82 test files passed
  - 669 tests passed
- `npm run build` PASS
- `git diff --check` PASS
  - Git reported CRLF normalization warnings only, no whitespace errors.

## Acceptance Criteria

- AC1 PASS: `src/ai/responseUtils.ts` contains no remaining regex findings in the updated baseline.
- AC2 PASS: no new regex constructs were added.
- AC3 PASS: focused tests cover web-search detection, nested text extraction, unknown typed text rejection, citation extraction, and citation de-duplication.
- AC4 PASS: public exports stayed stable.
- AC5 PASS: no-regex guard passes with baseline reduced from 1729 to 1723.
- AC6 PASS: focused tests, typecheck, full tests, build, and diff check passed.
- AC7 PASS: production eval was not run because this pass only changes private provider-response type parsing with local parity tests; prompts, answer policy, product selection, tool policy, and widget-visible behavior are unchanged.

## Notes

This is one small no-regex refactor pass toward the broader modernization goal. It does not complete the overall goal.
