# Web budget builder evidence

Task: `AI-AUDIT-LIVE-20260809`  
Scope: AC5 and AC4 conditional comparison/web foundation  
Date: 2026-08-09 (Europe/Moscow)

## RED

Command:

```text
npm.cmd test -- --run tests/productComparisonResearch.test.ts tests/agentManagerToolRegistry.test.ts tests/agentManagerTurnBudget.test.ts tests/chatRouteAbort.test.ts tests/conversationRepository.test.ts
```

Result: exit `1`; 5 test files failed; 7 failed and 87 passed (94 total).

Observed primary failures:

- configured web timeout was `30000`, expected `45000`;
- work wall budget was `80000`, expected `100000`;
- route deadline remained `85_000` and the route did not pass an explicit persisted deadline;
- repository fallback remained `interval '85 seconds'`;
- deadline-bound exact-product research started with `product_comparison_research` instead of `catalog_product_fact_extraction_compact`;
- provider `TimeoutError` and `AbortError` escaped instead of returning a typed partial result.

## Implementation

- web tool timeout: 45 seconds;
- work wall budget: 100 seconds;
- persisted and route terminal deadline: 105 seconds;
- unchanged downstream reserves: 30 seconds for compose/review and 5 seconds for terminalization;
- exact catalog products under an external deadline now receive compact semantic catalog extraction before web;
- an aborted/timed-out primary external pass returns catalog facts plus explicit target/attribute gaps with `searchDisposition=timed_out` and `sourcesExhausted=false`;
- without catalog evidence, the same typed partial retains exact requested target/attribute gaps;
- no retry, source-authority, identity, or evidence-validation gate was weakened.

## GREEN

Focused command (after implementation and fake-clock relationship coverage):

```text
npm.cmd test -- --run tests/productComparisonResearch.test.ts tests/agentManagerToolRegistry.test.ts tests/agentManagerTurnBudget.test.ts tests/chatRouteAbort.test.ts tests/conversationRepository.test.ts
```

Result: exit `0`; 5 test files passed; 95/95 tests passed; duration 2.69s.

The fake-clock test proves the intended work-window arithmetic: after 25 seconds of pre-web work, the complete 45-second web window remains available and leaves exactly 30 seconds for compose/review inside the 100-second work budget. The persisted 105-second deadline leaves the existing 5-second terminal reserve outside that work budget.

Additional checks:

```text
npm.cmd run lint:no-regex
```

Result: exit `0`; `No new regex constructs. Legacy baseline: 508.`

```text
npm.cmd run typecheck
```

The first shared-tree run temporarily exited `1` while a sibling-owned edit was in progress:

```text
src/ai/agentManagerOrchestrator.ts(7390,31): error TS2304: Cannot find name 'reviewerRewriteNumericClaimBindings'.
```

No type error was reported in the files owned by this builder. After the sibling edit settled, the same command was rerun and exited `0` with both TypeScript projects clean.

Connected producer/consumer command:

```text
npm.cmd test -- --run tests/agentManagerComparisonResearch.test.ts tests/agentManagerConditionalWebShortCircuit.test.ts tests/agentManagerContracts.test.ts tests/agentManagerOrchestrator.test.ts tests/agentManagerRequirementProofs.test.ts tests/agentManagerSearchBeforeSpecialistIntegration.test.ts tests/riskReviewGuards.test.ts
```

Shared-tree result at the time of this builder pass: 6 test files passed; the sibling-owned `agentManagerOrchestrator.test.ts` had 2 failures; 275/277 tests passed overall. The failures were the in-progress AC1 expectation for preserving over-budget Masalta as comparison evidence and an updated generator-card expectation. Neither failure touched the files owned by this builder; they were reported to the integration owner for the active orchestrator worker.

## AC4 orchestrator and partial-gap continuation

Additional RED contracts:

- timeout partial exact-pair gap: exit `1`, 1 failed / 40 skipped; compact schema had no exact `productName.enum`, and confirmed catalog target×attribute coverage could be reopened as `not_confirmed`;
- orchestrator conditional-repair/lease slice: exit `1`, 4 failed / 152 skipped; the repair helper and exported lease relationship did not exist;
- same-target superset merge: exit `1`, 1 failed / 156 skipped; an existing request with one extra attribute produced a duplicate web request.

Implemented behavior:

- compact catalog extraction constrains product identity and requested attributes to the supplied enums;
- timeout coverage subtracts only exact, source-backed, medium/high-confidence catalog target×attribute facts, while conflicts and every unresolved target remain explicit gaps;
- preliminary `comparison` / `product_selection` intents with catalog retrieval and structured technical attributes receive one bounded conditional `web.researchProductFacts` request;
- exact names come only from structured product-detail requests; catalog selection keeps `productNames=[]`; compatible same-target/general requests merge attributes without duplicate calls;
- conditional detail requests are ordered catalog-first; full catalog extraction returns `searchDisposition=not_needed` and `usedWebSearch=false`; timeout/partial research keeps missing facts unknown;
- recovery lease wait is tied to `DEFAULT_AGENT_MANAGER_TURN_LIMITS.maxWallTimeMs` (`100_000`).

Final focused command:

```text
npm.cmd test -- --run tests/productComparisonResearch.test.ts tests/agentManagerOrchestrator.test.ts tests/agentManagerComparisonResearch.test.ts tests/agentManagerToolRegistry.test.ts tests/agentManagerTurnBudget.test.ts tests/chatRouteAbort.test.ts tests/conversationRepository.test.ts
```

Result: exit `0`; 7/7 files passed; 277/277 tests passed.

Final connected command:

```text
npm.cmd test -- --run tests/agentManagerComparisonResearch.test.ts tests/agentManagerConditionalWebShortCircuit.test.ts tests/agentManagerContracts.test.ts tests/agentManagerOrchestrator.test.ts tests/agentManagerRequirementProofs.test.ts tests/agentManagerSearchBeforeSpecialistIntegration.test.ts tests/riskReviewGuards.test.ts
```

Result: exit `0`; 7/7 files passed; 283/283 tests passed.

Final no-regex result: exit `0`; `No new regex constructs. Legacy baseline: 508.`

The latest shared-tree typecheck exited `1` only on the concurrently changing numeric-claim producer/consumer boundary: four `claimText` errors at `src/ai/agentManagerOrchestrator.ts:2931-2943` because the sibling-owned `ReviewerRewriteNumericClaimBinding` type had not yet acquired that field. No AC4/AC5 file section produced a type error. Per integration-owner instruction, this is recorded as a concurrent numeric-fixer blocker and will be rerun after that owner releases the shared file.
