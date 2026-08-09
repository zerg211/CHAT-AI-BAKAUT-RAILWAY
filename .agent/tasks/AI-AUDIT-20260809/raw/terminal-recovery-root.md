# Terminal recovery and web telemetry — root evidence

Date: 2026-08-09

## Scope

- Preserve mechanically eligible catalog evidence when the absolute turn deadline is reached.
- Do not treat an `ok` web tool envelope as proof that the requested fact was answered.
- Downgrade an interrupted `final_fit` decision to an explicitly preliminary terminal card instead of discarding the product.
- Persist truthful terminal web-attempt and web-completion telemetry.

## RED

Two contract tests in `tests/agentManagerOrchestrator.test.ts` failed before the owning-layer change:

1. A persisted timed-out `web.researchProductFacts` artifact did not expose the attempted/completed distinction consistently at the response boundary.
2. A `final_fit` turn with successful catalog details and an `ok` but unresolved web envelope discarded the named product, price, card, and exact missing fact.

## Implementation

- `terminalUnfinishedWebVerification` reads typed coverage, conflicts, unconfirmed facts, completeness, outcome, and facts. Status `ok` alone is not completion.
- Terminal recovery re-runs only the mechanical product filter as `preliminary_fit` when the persisted policy was `final_fit`; it records the downgrade warning.
- Response metadata distinguishes `webSearchAttempted` from `webSearchCompleted`; the public terminal `usedWebSearch` flag reflects only a completed web search, while an interrupted durable attempt remains visible separately in metadata.

## GREEN

- Focused timeout contract: 1 passed, 149 skipped.
- Focused unresolved-success contract: 1 passed, 149 skipped.
- Full `tests/agentManagerOrchestrator.test.ts`: 150/150 passed.
- `npm.cmd run typecheck`: exit 0.
- `npm.cmd run lint:no-regex`: exit 0; legacy baseline 508.

No commit, push, deploy, local OpenAI call, or live claim was made in this slice.
