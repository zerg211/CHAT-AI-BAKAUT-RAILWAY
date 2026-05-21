# Exact Model Answer Guidance Evidence

## Summary

Status: PASS locally after verifier-reported production defect, production gate pending until commit/push/Railway deploy.

This pass strengthens exact-model web research and answer handoff without adding regex. It keeps the semantic answer in the LLM/web research contract, while deterministic code enforces exact model identity, required semantic clauses, and a safe rewrite when structured research coverage is uncertain.

The first production widget check after the previous commit exposed a remaining defect in conversation #1298: the metadata correctly marked `ignition control` for `FIRMAN RD3910E` as `ambiguous`, but the buyer-visible answer still said the model starts by key/ignition lock. This follow-up fix makes `answerGuidance` authoritative for exact-model uncertain coverage before the final answer is saved.

The next production widget check, conversation #1318, verified that the key/ignition-lock overclaim was removed, but showed one refinement: a present exact model should not get "nearby alternatives" appended. The safe rewrite now appends nearby catalog models only when at least one exact target is absent from the catalog.

Conversation #1323 exposed the deeper follow-up bug: the planner reused a fact from `RD2910E` for the newly named `RD3910E` and skipped current-turn tools. Runtime now repairs such plans by injecting `web.researchProductFacts` whenever the current buyer message names an exact model identifier that is not covered by a same-turn catalog/research tool request.

Conversation #1324 passed the hard overclaim checks, but the answer only surfaced "button not confirmed" while metadata also had ambiguous key/switch coverage. The safe rewrite now renders start-control uncertainty from structured coverage, so buyer-visible text includes both key/switch ambiguity and button non-confirmation when those fields are present.

## Changed Files

- `src/ai/productComparisonResearch.ts`
- `src/ai/agentManagerOrchestrator.ts`
- `tests/agentManagerComparisonResearch.test.ts`

## Local Validation

- `npm test -- tests/agentManagerComparisonResearch.test.ts tests/agentManagerIntegrationSource.test.ts tests/agentManagerOrchestrator.test.ts` PASS: 3 files, 39 tests.
- `npm run lint:no-regex` PASS: no new regex constructs, legacy baseline remains 1832.
- `npm run typecheck` PASS.
- `npm run build` PASS.
- `git diff --check` PASS with line-ending warnings only.

## Behavior Parity And Change Boundary

Public APIs and database schema stay stable. Buyer-visible behavior can improve for exact-model technical fact questions:

- suffix model `RD2910E1` no longer proves exact catalog presence for `RD2910E`;
- checked web research can provide practical `answerGuidance.directAnswer`;
- the answer contract must include that checked guidance by meaning;
- not-confirmed/ambiguous coverage must not become a categorical negative claim.
- if the generated answer still broadens an uncertain exact-model fact, pre-send review rewrites to the checked `answerGuidance.directAnswer` plus structured catalog context.
- nearby catalog alternatives are appended only for absent exact targets, not for present exact catalog models.
- follow-up questions that name a new exact model cannot reuse facts from a different model without current-turn evidence.
- start-control coverage uncertainty is made visible in the answer, not left only in metadata.

## Production Gate

Pending after follow-up commit/push and Railway auto-deploy:

- production Promptfoo against `https://chat-ai-production-3057.up.railway.app` and `https://bakautprof.ru/`;
- required production live widget check through `https://bakautprof.ru/`.

## Acceptance Criteria

- AC1 PASS locally: focused test verifies `RD2910E1` does not count as exact `RD2910E`.
- AC2 PASS locally: focused test verifies `answer_checked_research_guidance` reaches required response clauses.
- AC3 PASS locally: research contract includes `answerGuidance` with practical start-control coverage.
- AC4 PASS locally: pre-send review guidance and deterministic safe rewrite prevent turning not-confirmed/ambiguous coverage into a categorical buyer-visible claim.
- AC4b PASS locally: present exact catalog targets do not receive nearby-model alternatives in the safe rewrite.
- AC4c PASS locally: planner miss on a newly named exact model is repaired by injecting same-turn research before answer composition.
- AC4d PASS locally: safe rewrite surfaces key/switch and button uncertainty from structured coverage.
- AC5 PASS: no new regex constructs.
- AC6 PASS: focused tests, typecheck, and build pass.
- AC7 PENDING: production Promptfoo/widget validation required after deploy.
