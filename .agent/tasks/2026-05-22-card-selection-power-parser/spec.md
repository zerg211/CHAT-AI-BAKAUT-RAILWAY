# Spec: card selection power parser without regex

Task ID: `2026-05-22-card-selection-power-parser`

## Current behavior

`src/ai/agentManagerCardSelection.ts` uses two legacy regex matches in `requestedPowerRangeKw` to parse explicit generator power requests such as `4-6 kW`, `8-10 кВт`, or `5 кВт`. The parsed range is only used to rank already-selected catalog generator cards by numeric fit.

## Structural improvement

Replace those regex matches with a small deterministic scanner:

- parse decimal numbers with `.` or `,`;
- recognize range separators `-`, `–`, `—`, and `до`;
- recognize power units `кВт`, `kw`, `kva`, and `ква`;
- preserve the same output shape `{ min, max }`.

This is a deterministic numeric parser, not a semantic chatbot rule. It does not decide buyer intent or product suitability; it only preserves existing numeric ranking behavior once the agent has already selected generator cards.

## Non-goals

- Do not change public APIs.
- Do not change catalog search, product cards, answer text, prompts, model selection, or production behavior intentionally.
- Do not add any new regex.
- Do not update unrelated legacy regex sites in this pass.

## Acceptance criteria

- AC1. The focused card-selection tests prove range and exact power requests still rank generator products by numeric fit.
- AC2. `npm run lint:no-regex` reports no new regex constructs and shows the legacy regex count decreased or the baseline is updated after review.
- AC3. `npm run typecheck`, focused tests, and `git diff --check` pass.
- AC4. Full `npm test` passes before commit.

## Validation plan

- `npm test -- tests/agentManagerCardSelection.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run lint:no-regex`
- `git diff --check`
