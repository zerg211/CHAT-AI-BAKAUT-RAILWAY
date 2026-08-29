# Static Reachability Audit

## Production Entry

- `src/routes/chat.ts` delegates generation/recovery to `AssistantService`.
- In the staged production snapshot, `AssistantService` delegates directly to its `AgentManagerOrchestrator` instance.
- `AgentManagerOrchestrator` requires `model.decideTurn`, validates one combined `AgentSemanticDecision`, allows one bounded correction attempt, and fails before tool execution when validation still fails.

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
- `inferProductIntent` remains exported in `productClassifier.ts` but has no production or test caller.
- `inferVisibleCardIntent` derives a product class only from typed tool arguments, `selectionPolicy`, or typed product mentions.

## Specialist Boundary

- Any required `lead.capture` for an intent that still semantically requires technical search is rejected with `search_required_before_specialist`.
- The only exception is an exact, persisted, source-exhausted technical handoff continuation validated against history, offer ID, buyer question, and pending-draft scope.
- A first-turn plan containing both web research and lead capture is rejected before either tool executes; the LLM must return a research-only correction.
