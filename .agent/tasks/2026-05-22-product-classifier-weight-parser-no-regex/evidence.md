# Product Classifier Weight Parser No Regex Evidence

## Scope

This pass replaces regex-based deterministic number/weight parsing in `productClassifier` with explicit scanners.

Current behavior preserved:
- `parseLoosePositiveNumber` extracts the first positive number from spec text, including decimal comma/dot.
- `extractWeightKg` prioritizes structured mass/weight spec keys, then scans product text for a 2-4 digit integer followed by `kg` or Russian `кг`.

Structural improvement:
- removed exported `weightRegex`;
- removed regex from `parseLoosePositiveNumber`;
- removed regex from `extractWeightKg` spec-key and text-weight checks;
- removed unused `weightRegex` import from `assistant.ts`.

## Local Checks

- `npm test -- tests/productClassifier.test.ts tests/agentManagerCardSelection.test.ts`: PASS, 2 files / 22 tests.
- `npm run typecheck`: PASS.
- `npm run lint:no-regex -- --update-baseline`: PASS, updated baseline to `1771`.
- `npm run lint:no-regex`: PASS, no new regex constructs, legacy baseline `1771`.
- `npm run build`: PASS.
- `git diff --check`: PASS, no whitespace errors; LF-to-CRLF warnings only.
- `npm test`: first run hit a transient timeout in `tests/productComparisonResearch.test.ts`; the file passed in isolation immediately after.
- `npm test -- tests/productComparisonResearch.test.ts`: PASS, 1 file / 7 tests.
- Fresh `npm test`: PASS, 78 files / 643 tests.

## Acceptance Criteria

- AC1: PASS. `parseLoosePositiveNumber` uses a scanner, not regex.
- AC2: PASS. `extractWeightKg` no longer depends on `weightRegex`; `weightRegex` export and assistant import were removed.
- AC3: PASS. Focused tests cover loose numeric specs, English/Russian weight units, and model digits without weight units.
- AC4: PASS. `npm run lint:no-regex` reports no new regex and baseline dropped from `1778` to `1771`.
- AC5: PASS locally. Non-OpenAI gates passed.
- AC6: PENDING. Requires commit, push, Railway marker, then production Promptfoo.
