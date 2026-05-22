# Task: response utils type signals no regex

## Current behavior

`src/ai/responseUtils.ts` inspects OpenAI response-like objects to:

- detect whether a response used web search;
- extract assistant text from nested response structures;
- extract URL citations from nested response structures.

The current implementation uses regex only to classify provider node `type` strings such as `web_search`, `search_result`, `url_citation`, `output_text`, `message`, and `text`.

## Structural improvement

Replace these regex checks with explicit lowercase substring checks over provider type strings.

This keeps the deterministic provider-response parsing boundary in code while removing regex debt. It does not change prompts, model behavior, tool policy, product selection, or public APIs.

## Acceptance Criteria

AC1. `src/ai/responseUtils.ts` no longer contains regex constructs.

AC2. No new regex constructs are added anywhere else.

AC3. Focused tests cover:

- web-search detection from provider type strings;
- nested response text extraction from `output_text`, `message`, and `text` nodes;
- URL citation extraction and de-duplication.

AC4. Existing public exports remain stable: `safeError`, `logOpenAIUsage`, `responseUsedWebSearch`, `extractResponseText`, and `extractUrlCitations`.

AC5. `npm run lint:no-regex` passes after reviewed baseline reduction.

AC6. Focused tests, typecheck, full tests, build, and diff check pass.

AC7. Production eval is not required unless this pass changes prompt/answer behavior, product selection, tool policy, or widget-visible behavior.
