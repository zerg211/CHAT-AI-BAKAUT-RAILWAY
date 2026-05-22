# Task: card manifest no regex

## Current behavior

`src/ai/cardManifest.ts` builds deterministic metadata for visible and hidden product cards. It checks visible cards against execution-contract hard constraints:

- product class;
- brand and exact model tokens;
- fuel;
- single-phase 220 V versus 380/400 V.

The checks currently use regex for whitespace normalization, product-class classification, fuel classification, and voltage/phase signals.

## Structural improvement

Replace the regex checks with explicit lowercase string scanning helpers:

- compact whitespace without regex;
- classify known card classes with substring signals;
- detect fuel with explicit signal lists;
- detect 220/230 V and 380/400 V phase signals with explicit compact/space/hyphen variants.

This stays deterministic guard logic. The LLM still decides user intent and selection policy; code only validates that visible cards match already-structured constraints.

## Acceptance Criteria

AC1. `src/ai/cardManifest.ts` contains no regex constructs after the pass.

AC2. No new regex constructs are added anywhere else.

AC3. Existing card manifest behavior remains stable for satisfied constraints, visible-card violations, hidden cards, and enforcement.

AC4. Focused tests cover product-class, fuel, and voltage/phase signal forms that were previously recognized through regex.

AC5. `npm run lint:no-regex` passes after reviewed baseline reduction.

AC6. Focused tests, typecheck, full tests, build, and diff check pass.

AC7. Production eval is not required unless this pass changes prompts, answer policy, product selection, tool policy, or widget-visible behavior beyond deterministic parity.
