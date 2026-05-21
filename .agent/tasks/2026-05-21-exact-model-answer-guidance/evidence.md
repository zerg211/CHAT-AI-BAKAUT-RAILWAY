# Exact Model Answer Guidance Evidence

## Summary

Status: PASS locally, production gate pending until commit/push/Railway deploy.

This pass strengthens exact-model web research and answer handoff without adding regex. It keeps the semantic answer in the LLM/web research contract, while deterministic code enforces exact model identity and required semantic clauses.

## Changed Files

- `src/ai/productComparisonResearch.ts`
- `src/ai/agentManagerOrchestrator.ts`
- `tests/agentManagerComparisonResearch.test.ts`
- `tests/agentManagerIntegrationSource.test.ts`

## Local Validation

- `npm test -- tests/agentManagerComparisonResearch.test.ts tests/agentManagerIntegrationSource.test.ts tests/agentManagerOrchestrator.test.ts` PASS: 3 files, 36 tests.
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

## Production Gate

Pending after commit/push and Railway auto-deploy:

- production Promptfoo against `https://chat-ai-production-3057.up.railway.app` and `https://bakautprof.ru/`;
- required production live widget check through `https://bakautprof.ru/`.

## Acceptance Criteria

- AC1 PASS locally: focused test verifies `RD2910E1` does not count as exact `RD2910E`.
- AC2 PASS locally: focused test verifies `answer_checked_research_guidance` reaches required response clauses.
- AC3 PASS locally: research contract includes `answerGuidance` with practical start-control coverage.
- AC4 PASS locally: pre-send review guidance forbids turning not-confirmed coverage into a categorical negative.
- AC5 PASS: no new regex constructs.
- AC6 PASS: focused tests, typecheck, and build pass.
- AC7 PENDING: production Promptfoo/widget validation required after deploy.
