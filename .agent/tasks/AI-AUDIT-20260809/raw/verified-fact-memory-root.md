# Verified fact memory safety — root tranche

## RED

`npm.cmd test -- --run tests/verifiedFactMemory.test.ts`

- 3/4 failing before implementation: stale fact reused, conflicting values declared covered, legacy web fact without URL reused.
- Added a fourth qualifier regression before implementation: maximum power must not cover nominal power.

## Implementation

- Memory reuse is limited to active high/medium-confidence facts verified within 90 days.
- Web facts require an HTTP(S) provenance URL.
- Qualified power attributes remain distinct (`nominal`, `maximum`, `engine`, `apparent`).
- Multiple different values for the same requested attribute and exact product make memory coverage false, forcing fresh research instead of returning `answered` with `conflicts=[]`.
- Generic attribute nouns such as `power` and `start` no longer make unrelated qualified facts collide or cross-cover.
- Follow-up RED proved that an any-token overlap reused `fuel tank capacity` as `fuel type`. Reuse now requires every meaningful requested attribute token to be covered, preferring a fresh search over a semantically adjacent memory hit.

## GREEN

- `npm.cmd test -- --run tests/verifiedFactMemory.test.ts` → 5/5 PASS.
- `npm.cmd test -- --run tests/agentManagerComparisonResearch.test.ts tests/verifiedFactMemory.test.ts` → 28/28 PASS.
- Follow-up connected memory/research run → 64/64 PASS across `verifiedFactMemory`, `productComparisonResearch` and `agentManagerComparisonResearch`.
- `npm.cmd run typecheck` → PASS after the tranche.

Production widget verification remains part of the post-deploy live matrix; no commit or push was performed in this tranche.
