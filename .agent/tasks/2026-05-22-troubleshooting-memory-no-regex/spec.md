# Task: troubleshooting memory no regex

## Current behavior

`src/ai/troubleshootingMemory.ts` stores deterministic troubleshooting memory for sourced diagnostic answers. It currently uses regex for:

- normalizing model tokens and problem summaries;
- extracting fault codes such as `A25` only when a diagnostic term appears nearby;
- tokenizing problem text for retrieval keys.

This is not buyer-intent planning. It is deterministic text normalization and evidence-memory indexing.

## Structural improvement

Replace the regex operations in `troubleshootingMemory.ts` with small explicit scanners:

- whitespace compaction;
- alphanumeric tokenization;
- nearby diagnostic-term fault-code extraction;
- fault-code shape validation.

Keep public exports stable and keep the existing troubleshooting memory behavior covered by focused tests.

## Acceptance Criteria

AC1. `src/ai/troubleshootingMemory.ts` contains no regex constructs after the pass.

AC2. No new regex constructs are added anywhere else.

AC3. Existing behavior is preserved for current troubleshooting memory tests: diagnostic-context code extraction, no extraction from plain model names, case draft creation, and query coverage.

AC4. Add focused tests for previously regex-covered edge forms: code before diagnostic term, spaced/hyphenated fault code, and unrelated model/article text that must not become a fault code.

AC5. `npm run lint:no-regex` passes after reviewed baseline reduction.

AC6. Focused tests, typecheck, full tests, build, and diff check pass.

AC7. Production eval is not required unless this pass changes answer policy, product selection, prompts, or visible widget behavior.
