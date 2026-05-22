# Task: verified fact memory helper extraction

## Current behavior

`AgentManagerOrchestrator` owns both orchestration and verified web fact memory helper logic:

- attribute token normalization for verified fact matching;
- matching stored verified facts against target product names and requested comparison attributes;
- checking whether stored facts fully cover the structured request;
- converting stored facts into a `ProductComparisonResearchResult`;
- mapping research fact confidence into numeric catalog mirror confidence.

The behavior is covered by `tests/agentManagerComparisonResearch.test.ts` and production Promptfoo evidence from the previous pass.

## Structural improvement

Extract the verified fact memory helper logic into a dedicated AI module without changing public APIs, database contracts, or user-visible behavior. The orchestrator should still decide when to query/save verified facts, but helper details should move out of the oversized orchestrator file.

## Acceptance Criteria

- AC1: `AgentManagerOrchestrator` no longer defines the verified fact matching/result conversion helpers inline.
- AC2: A dedicated module owns verified fact matching, full-coverage checks, research-result conversion, and confidence mapping.
- AC3: Behavior is preserved: exact matching and full-coverage semantics stay the same; no partial-coverage shortcut, no start-family dictionary, no regex.
- AC4: Public APIs, DB schema, repository methods, and production response contract stay unchanged.
- AC5: Focused verified fact memory tests pass.
- AC6: Typecheck, build, and no-regex checks pass.
- AC7: Evidence is recorded in this task folder.

## Validation plan

- `npx vitest run tests/agentManagerComparisonResearch.test.ts`
- `npm run typecheck`
- `npm run lint:no-regex`
- `npm run build`

Production Promptfoo is not required for this behavior-preserving extraction unless tests or code review reveal behavior drift; if run, it must use production base URL and production LLM grader, not localhost OpenAI.
