# Assistant Structured JSON Extraction Spec

## Current Behavior

`src/ai/assistant.ts` still owns local AI input compaction and structured JSON response helpers:

- `jsonOutputTokenLimit`
- `truncateForAI`
- `compactHistoryForAI`
- local `parseJsonObject`
- local `responseTextForJson`
- local `createStructuredJsonResponse`

These helpers are used by assistant planning/answering paths, but they are not assistant orchestration logic. The local `parseJsonObject` also uses legacy regex for markdown JSON fence stripping, which conflicts with the project direction to remove regex debt.

Current behavior to preserve:

- `truncateForAI` trims and truncates text with `...`.
- `compactHistoryForAI` returns the latest messages with role/content only.
- `jsonOutputTokenLimit` enforces the same minimum token floor.
- `createStructuredJsonResponse` uses the provided client, retries once through `withRetry`, preserves caller-side usage logging, and retries with the same `12000` minimum output token budget after parse failure.
- JSON object parsing keeps accepting plain JSON and fenced `json` blocks while still returning clear stage-specific errors.

## Structural Improvement

Extract the assistant-specific helper path into:

- `src/ai/assistantStructuredJson.ts`

Replace the local markdown fence regex with string operations, so this pass removes regex debt rather than moving it.

## Validation

AC1. `assistant.ts` no longer defines the assistant structured JSON/input-compaction helpers inline.

AC2. Focused tests prove helper behavior for truncation, compact history, token floor, fenced/plain JSON parsing, parse errors, direct response text, and retry-on-parse-failure.

AC3. Existing assistant behavior tests still pass.

AC4. `npm run lint:no-regex` proves no new regex constructs were added.

AC5. `npm run typecheck`, `npm run build`, and full `npm test` pass.

AC6. No production Promptfoo rerun is required for this pass because it is helper extraction plus regex-free equivalent fence stripping, with no prompt/API/model/tool/business behavior change.
