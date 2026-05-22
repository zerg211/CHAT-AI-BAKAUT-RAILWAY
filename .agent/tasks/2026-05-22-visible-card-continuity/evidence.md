# Visible Card Continuity Evidence

## Pre-fix production signal

Production Promptfoo after `e2b9731` reached the requested score gates but still returned `5/6`.

- Deterministic average: `0.9362222222222222`.
- LLM average: `0.9549999999999997`.
- Remaining failure: `plate_retrieval_grounding`.
- LLM judge for that case: `0.97`.

Observed bottleneck: the final plate follow-up answer referenced already suitable models, but the current turn did not expose visible product cards because no new catalog tool ran. The previous turn had matching plate cards.

## Change

When the current turn is `ready_for_cards`, no current products were selected, and recent assistant history contains visible cards matching the structured product class, the orchestrator reuses those previous visible cards.

This is deterministic continuity over prior metadata. It does not add regex, keyword matching, canned phrases, new tools, or public API changes. Generator cards are excluded from this fallback so load-profile safety is not bypassed.

## Local checks

- `npm test -- tests/agentManagerOrchestrator.test.ts tests/agentManagerCardSelection.test.ts`: PASS, 41 tests.
- `npm run lint:no-regex`: PASS, legacy baseline `1794`, no new regex constructs.
- `git diff --check`: PASS.
- `npm run typecheck`: PASS.
- `npm test`: PASS, 76 files, 623 tests.
- `npm run build`: PASS.

## Acceptance criteria

- AC1: PASS. Unit test proves a ready follow-up can reuse previous matching cards without a new catalog search.
- AC2: PASS. Reused cards are converted from stable `ProductCard` metadata and filtered by product intent.
- AC3: PASS. Generator continuity is explicitly disabled to preserve generator load-card safety.
- AC4: PASS. `npm run lint:no-regex` reports no new regex constructs.
- AC5: PASS. Local non-OpenAI gates passed.
- AC6: PENDING. Requires commit, push, Railway marker, then production Promptfoo.
