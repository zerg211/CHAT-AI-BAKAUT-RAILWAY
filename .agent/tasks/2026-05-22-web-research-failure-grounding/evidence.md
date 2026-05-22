# Evidence

## Implementation

- Added `web_research_unavailable_grounding` required response clause for non-ok `web.researchProductFacts` results.
- Updated the Agent Manager answer prompt so failed web research cannot be described as checked, verified, or confirmed evidence.
- Added a regression test that forces `web.researchProductFacts` to throw and verifies the answer model receives the required grounding clause before composition.

## Local Verification

- `npm test -- tests/agentManagerComparisonResearch.test.ts tests/agentManagerIntegrationSource.test.ts` - PASS, 17 tests.
- `npm run lint:no-regex` - PASS, no new regex constructs; legacy baseline remains 1824.
- `npm run typecheck` - PASS.
- `npm test` - PASS, 75 files / 602 tests.
- `git diff --check` - PASS, CRLF warnings only.
- `npm run build` - PASS.

## Production Verification

- Pending commit, push, Railway marker, and production Promptfoo.

## Acceptance Criteria Status

- AC1: PASS.
- AC2: PASS.
- AC3: PASS.
- AC4: PASS.
- AC5: PENDING.
