# Generator Estimate-Only Card Gate

## Context

Production live verification after commit `62acc2c` showed a real defect: the bot displayed generator product cards after a vague first turn where all generator loads came from `estimated_average` values. The buyer did not provide explicit pump/tool/loadplate data, so catalog cards and model recommendations were premature.

Local OpenAI-dependent checks are invalid in this environment because they return `403 Country, region, or territory not supported`. Behavior verification must happen only after commit/push, Railway auto-deploy from GitHub, and production API/widget checks.

## Scope

- Keep production prompts/model settings functionally aligned with the current agent architecture.
- Do not add semantic regex/keyword patches for pump/tool detection.
- Use structured tool payloads and tool-result policy as the deterministic safety boundary.
- Do not run local Promptfoo or local live LLM tests.

## Acceptance Criteria

AC1. If `calculator.generatorLoad` succeeds using only `estimated_average` load sources, the tool result records `generator_load_estimate_only`. If the planner sends a product class such as `generator` as a load kind, the tool records `generator_load_invalid_load_kind` instead of treating it as a real appliance/load.

AC2. If a generator or welding-generator catalog tool is requested after an unconfirmed generator load basis, runtime denies that catalog request and does not put products into visible-card selection.

AC3. Visible product cards are suppressed when current tool results contain an unconfirmed generator load basis, even if the answer contract incorrectly says cards are ready.

AC4. The planner/answer/reviewer prompts state the same policy: estimate-only generator load is not enough to name catalog models/prices or show cards.

AC5. Local verification uses only non-OpenAI checks: targeted unit tests and typecheck.

AC6. Final behavior verification is run only after GitHub push and Railway deployment of the pushed commit.
