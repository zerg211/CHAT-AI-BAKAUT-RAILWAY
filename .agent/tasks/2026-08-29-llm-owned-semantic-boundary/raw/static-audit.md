# Static Reachability Audit

## Production Entry

- `src/routes/chat.ts` delegates generation/recovery to `AssistantService`.
- In the staged production snapshot, `AssistantService` delegates directly to its `AgentManagerOrchestrator` instance.
- `AgentManagerOrchestrator` requires `model.decideTurn`, validates one combined `AgentSemanticDecision`, allows up to two bounded correction attempts, and fails before tool execution when validation still fails.
- `src/routes/chat.ts` treats exhausted semantic-decision validation as non-transient, so the generic transport retry cannot create a fresh semantic/model/provider budget.
- Each semantic attempt receives a deadline from the shared turn budget that preserves 45 seconds for downstream tools and answer composition.
- Each correction receives the current rejected decision/current issues plus accumulated prior issue codes as an LLM non-regression constraint. Only current-candidate validation decides success or failure; code does not repair semantic fields.

## Removed Semantic Repair Paths

Current search across `src/**/*.ts` and `tests/**/*.ts` returns no match for:

```text
repairIntentForTypedToolRequirementCoverage
repairIntentForStaleWebResearchTargets
repairIntentForElectricStartRequirementKinds
repairIntentForRequestedTechnicalAttributeWebCoverage
repairIntentForOpenEndedRequirementWebCoverage
repairIntentForNewNeedFinalFit
repairPreliminaryExactComparisonCatalogFirst
enforceSearchBeforeTechnicalSpecialist
repairIntentForGroundingPolicy
repairIntentForCatalogGrounding
repairIntentForRequiredCatalogToolExecution
```

Current search across `src/**/*.ts` also returns no `planner_repaired_*` marker.

## Remaining Deterministic Authority

- `orderToolRequestsForSelectionDependencies` orders planner-owned requests without adding or changing semantic requests.
- `productMatchesIntent` classifies catalog records against a typed product class; it does not infer buyer intent.
- Requirement proof, confirmed-conflict filtering, card readiness, source exhaustion validation, contact authorization, arithmetic, idempotency, and persistence remain deterministic.
- `inferProductIntent` remains exported in `productClassifier.ts` with no production caller; its only remaining use is a legacy test-fixture adapter.
- `inferVisibleCardIntent` derives a product class only from typed tool arguments, `selectionPolicy`, or typed product mentions.

## Specialist Boundary

- Any required `lead.capture` for an intent that still semantically requires technical search is rejected with `search_required_before_specialist`.
- The only exception is an exact, persisted, source-exhausted technical handoff continuation validated against history, offer ID, buyer question, and pending-draft scope.
- A first-turn plan containing both web research and lead capture is rejected before either tool executes; the LLM must return a research-only correction.
