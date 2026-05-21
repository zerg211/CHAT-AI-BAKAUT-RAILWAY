# Evidence: assistant structured JSON extraction

Task ID: `2026-05-21-assistant-structured-json-extraction`
Date: 2026-05-21

## Change summary

- Added `src/ai/assistantStructuredJson.ts` for assistant-owned structured JSON helpers.
- Updated `src/ai/assistant.ts` to import the extracted helpers instead of carrying the local helper block.
- Preserved the existing JSON generation flow: direct Responses client call, parse failure warning, retry with a larger token budget, caller-side usage logging, and stage-specific parse errors.
- Replaced the old markdown JSON fence cleanup regex with string operations.
- Updated `scripts/no-regex-baseline.json` after removing 4 legacy regex findings: baseline moved from 1832 to 1828.
- `src/ai/assistant.ts` line count after this pass: 12551.

## Validation

- `npm test -- tests/assistantStructuredJson.test.ts tests/assistantFallback.test.ts tests/assistantControlPlaneGenerate.test.ts`
  - PASS: 3 files, 33 tests.
- `npm run typecheck`
  - PASS.
- `npm run lint:no-regex`
  - PASS: `No new regex constructs. Legacy baseline: 1828.`
- `npm run build`
  - PASS.
- `npm test`
  - PASS: 68 files, 576 tests.

## Production gate

Production Promptfoo/widget rerun was intentionally not used for this pass. This is a helper extraction plus regex-free equivalent fence handling; it does not change prompts, model selection, API shape, tools, product selection, business policy, or user-facing answer logic.
