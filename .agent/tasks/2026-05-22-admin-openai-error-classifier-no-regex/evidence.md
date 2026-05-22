# Evidence: Admin OpenAI Error Classifier No-Regex Pass

## Change

- Replaced regex-based OpenAI runtime error classification in `src/routes/admin.ts` with deterministic status and phrase checks.
- Exported `classifyOpenAIRuntimeError` for direct unit coverage.
- Added `tests/adminOpenaiErrorClassifier.test.ts`.
- Updated `scripts/no-regex-baseline.json` after reviewing the removal.

## Behavior Preserved

The classifier still returns the existing public class names:

- `quota_or_billing`
- `authentication`
- `provider_access_region`
- `rate_limit`
- `model_project_or_org_access`
- `network_or_timeout`
- `unknown`

`provider_access_region` remains higher priority than generic `403` access classification.

## Checks

- `npm test -- tests/adminOpenaiErrorClassifier.test.ts`: PASS, 7 tests.
- `npm run lint:no-regex`: PASS, baseline now 1782.
- `git diff --check`: PASS, only line-ending warnings.
- `npm run typecheck`: PASS.
- `npm test`: PASS, 77 files, 635 tests.
- `npm run build`: PASS.
- Production Promptfoo after Railway marker `37f1e57`: PASS, `6/6`, deterministic average `0.9918333333333335`, LLM average `0.9550000000000001`.

## Acceptance Criteria

- AC1: PASS. `src/routes/admin.ts` no longer has regex literals or regex constructor calls.
- AC2: PASS. Unit tests cover all existing classifier class names.
- AC3: PASS. No new regex constructs; legacy baseline reduced from 1794 to 1782.
- AC4: PASS. Targeted admin tests pass.
- AC5: PASS. Local non-OpenAI gates pass.

## Notes

- The production eval was rerun because commit `57866f8` entered main before this pass and changed visual evidence transport. Latest main still passed the widget-path scorecard.
