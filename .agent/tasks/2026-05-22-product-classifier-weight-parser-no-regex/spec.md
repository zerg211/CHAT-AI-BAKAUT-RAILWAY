# Product Classifier Weight Parser No Regex

## Problem

`src/ai/productClassifier.ts` still uses regex for two deterministic catalog parsing tasks:

- `parseLoosePositiveNumber` extracts the first numeric value from a spec field;
- `extractWeightKg` finds a numeric weight followed by `kg` or Russian `кг` in product text.

These are fact parsers, not semantic buyer-intent decisions. They should be explicit typed scanners so future behavior changes are reviewable and the project moves away from regex.

## Current Behavior

- Numeric specs such as `60`, `60,5`, and text like `weight: 60 kg` return positive numbers.
- Weight extraction first trusts specs whose key means mass/weight, then falls back to product name/description/spec text containing a 2-4 digit integer next to `kg`/`кг`.
- Public callers keep using `parseLoosePositiveNumber` and `extractWeightKg`.

## Structural Improvement

Replace regex matching with small scanner helpers:

- scan for the first positive decimal number using digits plus one optional `.` or `,`;
- detect weight spec keys through normalized substring checks;
- scan text for a 2-4 digit integer followed by optional whitespace and `kg`/`кг`.

## Acceptance Criteria

- AC1: `parseLoosePositiveNumber` no longer uses regex.
- AC2: `extractWeightKg` no longer depends on `weightRegex`; the exported regex and unused imports are removed if no callers need them.
- AC3: Focused tests cover loose numeric specs, Cyrillic/English weight units, and ignoring model digits not followed by a weight unit.
- AC4: `npm run lint:no-regex` reports no new regex and a reduced legacy baseline after update.
- AC5: Local non-OpenAI gates pass.
- AC6: Changes are committed and pushed; production Promptfoo is rerun after Railway marker.
