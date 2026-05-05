# LLM-first plan execution report

Date: 2026-05-05
Scope: `C:\Projects\chatAI`
Source plan: `docs/plans/2026-05-02-post-llm-first-audit-and-fix-plan.md`

## Status

Implemented the useful parts of the plan that directly reduced deterministic keyword/script interference with the LLM planner.

## Fixed

1. Product role classifier no longer demotes core machines only because title/category contains broad accessory-like words such as `комплект`.
   - Core evidence now uses title/category structure.
   - Accessory evidence now uses accessory category signals and accessory title forms.
   - Regression covers core vibroplate/generator kits and filter/belt/service-kit accessories.

2. Preliminary planner context retrieval is split from strict post-plan selection retrieval.
   - `findPlannerContextProducts(...)` gathers broad text/exact/vector/supplemental context without `inferProductIntent`/`productFitPenalty` hard filtering.
   - `generateAnswer(...)` now sends that broader context to `planAssistantTurn(...)`.
   - Strict `findProducts(...)` remains for post-plan selection where LLM traits and safety constraints are allowed to filter.

3. Planner product context is labeled for the LLM.
   - `buildAssistantContext(...)` now includes `roleHint`: `coreProduct`, `accessory`, `consumable`, or `unknown`.
   - This gives the LLM visible evidence instead of hiding routing decisions inside code.

4. Rejected candidate diagnostics are separated from durable selection memory.
   - Durable `selectionState.rejectedProducts` now stores only comparison/current-selection rejects.
   - Broad source-product rejects are kept in `selectionTrace.diagnosticRejectedProducts`.
   - Regression proves vibroplate filter/belt exclusions remain visible diagnostically without polluting durable state.

5. Selection engine can no longer force product cards when the LLM planner made the turn text-only.
   - `shouldForceStructuredSelectionCards(...)` now requires `planAllowsCatalogSelectionOverride(plan)`.
   - This removes a deterministic route where code could override a correct LLM decision.

## Tests added/updated

- Classifier matrix for core vs accessory evidence.
- Planner-context retrieval with whole product plus spare words.
- Diagnostic rejects vs durable rejected memory.
- Text-only planner protection against forced structured cards.
- Prompt context assertion for `roleHint`.

## Verification

Passed:

- `npm test -- --run tests/recommendationRanking.test.ts`
- `npm test -- --run tests/recommendationRanking.test.ts tests/prompts.test.ts`
- `npm test -- --run tests/recommendationRanking.test.ts tests/needState.test.ts tests/turnContract.test.ts tests/prompts.test.ts`
- `npm test -- --run`
- `npm run typecheck`
- `npm run build`
- `git diff --check`

Live UI verification:

- Attempted `npm run dev`.
- Vite started on `http://localhost:5173`.
- API failed during migration because PostgreSQL was not reachable on `localhost:5432`.
- Protocol saved in `local-live-tests/2026-05-05-llm-first-plan-execution.local.md`.

## Additional audit: remaining places where deterministic code can still interfere

Fixed in this pass:

- `shouldForceStructuredSelectionCards` was a clear non-safety override of LLM text-only intent.

Kept as acceptable safety/business guards:

- Invalid planner fallback is text-only, so it no longer routes by keywords.
- `turnContract` generator phase confirmation blocks generator cards when 220/380 V was only inferred from load. This is a safety guard, not product-intent routing.
- Web-search forcing for technical comparisons/current-lineup/service-cost questions is a fact-safety guard.
- Lead handoff override is limited to purchase/contact/delivery/availability style signals.

Still worth a separate P0 pass:

- `enforceAnswerCardContract(...)` can still mutate/reorder cards after answer generation in non-authoritative flows. This is outside the 2026-05-02 plan but matches the older P0 concern: final cards should be fixed before answer generation, and post-answer code should repair text or fail closed, not change cards.
- Some explicit criteria extraction still fills missing constraints from regex when planner omitted them, for example electric start, enclosure, inverter/conventional, 220 V. This is currently bounded to explicit text and safety, but it should remain covered by evals so it does not become another hidden intent router.
