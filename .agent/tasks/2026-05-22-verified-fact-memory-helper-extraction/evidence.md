# Evidence: verified fact memory helper extraction

Task id: `2026-05-22-verified-fact-memory-helper-extraction`

Timestamp: `2026-05-22T18:52:01.8297206+03:00`

## Change summary

- Extracted model/product text matching helpers from `src/ai/agentManagerOrchestrator.ts` into `src/ai/modelTextMatching.ts`.
- Extracted verified product fact memory matching, full request coverage, research-result conversion, and numeric confidence mapping into `src/ai/verifiedFactMemory.ts`.
- Kept `AgentManagerOrchestrator` responsible for orchestration only: deciding when to read stored verified facts, when full coverage allows skipping web research, when to mark facts used, and when to save newly verified facts.
- Added no new regex constructs.

## Behavior preservation

Current behavior:
- Stored verified product facts are used only as source-backed evidence.
- Web research is skipped only when matching stored facts fully cover the requested comparison attributes.
- The assistant still composes the buyer-facing answer through the LLM answer contract.

Structural improvement:
- Verified fact memory mechanics no longer live inline inside the oversized orchestrator.
- Shared exact-model text matching is isolated in a small deterministic utility module.

Validation check:
- Focused comparison research tests passed.
- Typecheck passed.
- Production build passed.
- No-regex guard passed with unchanged legacy baseline.

## Commands

```text
npx vitest run tests/agentManagerComparisonResearch.test.ts
PASS: 1 test file, 13 tests

npm run lint:no-regex
PASS: No new regex constructs. Legacy baseline: 1687.

npm run typecheck
PASS

npm run build
PASS
```

## Acceptance criteria

- AC1: PASS. Orchestrator no longer defines verified fact matching/result conversion helpers inline.
- AC2: PASS. `src/ai/verifiedFactMemory.ts` owns matching, full-coverage checks, result conversion, and confidence mapping.
- AC3: PASS. Matching/full-coverage semantics are preserved by moving the same logic; no partial coverage shortcut, no start-family dictionary, no new regex.
- AC4: PASS. No public API, DB schema, repository method, or response contract changed.
- AC5: PASS. Focused verified fact memory behavior is covered by the existing comparison research test file and passed.
- AC6: PASS. Typecheck, build, and no-regex gates passed.
- AC7: PASS. Evidence is recorded here.

## Production eval

Production Promptfoo is not a pre-commit local gate for this behavior-preserving extraction. If run, it must use the Railway production base URL after commit, push, and Railway marker, not localhost.
