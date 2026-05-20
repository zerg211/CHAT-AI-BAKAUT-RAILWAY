# LLM Router Fast-Path Finalization Spec

## Task

Replace the deterministic production timeout fast paths introduced for commercial handoff and mixed catalog/commercial turns with an LLM-owned route and answer contract.

The final behavior must follow the project principle for this area: LLM understands and LLM executes the buyer-facing response. Code may still fetch catalog facts, apply hard product/business constraints, persist leads, attach cards, and block unsafe output.

## Scope

In scope:
- Commercial handoff turns previously gated by `shouldTryFastCommercialHandoff`.
- Mixed catalog + commercial turns previously gated by `shouldUseFastCatalogSelection`.
- Buyer-facing text previously produced by `deterministicCommercialHandoffFallback`, `deterministicAnswerGenerationFallback` in the fast path, or `fastCatalogCommercialVerificationText`.
- Buyer-facing text previously overwritten by local lead-created confirmation templates after runtime lead persistence.
- Tests and evidence proving the new route is LLM-driven.

Out of scope:
- Embedding coverage/backfill infrastructure.
- Railway manual deploy.
- Broad redesign of the already existing agent-manager harness outside these legacy fast paths.

## Acceptance Criteria

### AC1 - LLM Owns Semantic Fast-Route Decisions

Commercial handoff and mixed catalog/commercial routing decisions are made by a structured LLM fast-turn contract, not by regex/keyword helper gates.

Evidence:
- Code has a typed fast-turn LLM contract.
- The normal `generateAnswer` path calls that contract before legacy deterministic fast-route execution.
- `shouldTryFastCommercialHandoff` and `shouldUseFastCatalogSelection` are not used to decide normal production routes.

### AC2 - LLM Owns Buyer-Facing Fast-Route Answers

For accepted fast-turn routes, buyer-facing response text is produced by an LLM answer contract using the selected cards, history, need state, policy, and action result.

Evidence:
- `fastCatalogCommercialVerificationText` is not used in the normal path.
- `deterministicCommercialHandoffFallback` is not used as a normal commercial handoff answer.
- Any deterministic text left in code is explicitly emergency-only and marked in metadata.

### AC3 - Code Still Enforces Hard Constraints

Code continues to enforce facts and safety:
- catalog retrieval and card selection use repository data;
- displayed cards are the same product set used in the LLM answer contract;
- lead creation is persisted by code before a contact confirmation is allowed;
- saved lead/contact state is passed back into the LLM answer context instead of replacing the LLM answer with a template;
- post-answer verification blocks a repeated contact request after a lead/contact was already created;
- commercial constraints still block promises of exact availability, delivery cost, discounts, or terms;
- post-answer verification/policy gate remains active.

### AC4 - Tests Cover LLM Route and LLM Answer Use

Focused tests prove:
- a mixed catalog/commercial turn can be routed and answered through LLM contracts;
- a commercial handoff turn can be routed and answered through LLM contracts;
- the old deterministic helper exports are not the tested primary behavior;
- existing embedding hardening and coverage tests remain unaffected.

### AC5 - Evidence Is Current

Create evidence artifacts in this task directory:
- `evidence.md`;
- `evidence.json`;
- raw command outputs under `artifacts/`.

The evidence must mark whether the result is final. It is only final if tests pass, code is pushed, Railway deploy is observed, and a production widget live protocol is saved. If production credentials/deploy/live budget are unavailable, record the blocker and do not claim final.
