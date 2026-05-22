# Evidence: agent manager risk review guards no regex

## Change

Extracted deterministic review guards for adjudication and unsupported-claim risk flags from `src/ai/agentManagerOrchestrator.ts` into `src/ai/riskReviewGuards.ts`.

The orchestrator now consumes explicit helper functions:

- `hasAdjudicationRisk`
- `hasUnsupportedClaimRisk`

This keeps public behavior stable while removing legacy regex checks from the oversized orchestrator. The LLM/code boundary remains unchanged: the LLM can produce structured risk flags and warnings, while deterministic code blocks unsafe factual answers from those flags.

## Validation

- `npx vitest run tests/riskReviewGuards.test.ts` PASS
  - 1 test file passed
  - 4 tests passed
- `npm run lint:no-regex` PASS
  - Legacy baseline: 1745
  - Previous baseline: 1751
  - Removed 6 legacy regex findings from `src/ai/agentManagerOrchestrator.ts`
- `npm run typecheck` PASS
- `npm test` PASS
  - 81 test files passed
  - 662 tests passed
- `npm run build` PASS
- `git diff --check` PASS
  - Only CRLF normalization warnings from Git, no whitespace errors.

## Acceptance Criteria

- AC1 PASS: no regex constructs were added.
- AC2 PASS: `AgentManagerOrchestrator` imports the extracted risk review helpers.
- AC3 PASS: helper tests cover the expected legacy signal forms.
- AC4 PASS: focused tests cover adjudication, unsupported claim, and unrelated labels.
- AC5 PASS: no-regex guard passes with reduced baseline.
- AC6 PASS: focused tests, typecheck, full tests, build, and diff check passed.
- AC7 PASS: production eval was not rerun because this pass only extracts private deterministic guard logic with parity coverage and does not change product selection, generated answer policy, or widget UX.

## Notes

This is one small reviewable regex-removal pass in the broader refactor. It does not complete the overall refactor goal.
