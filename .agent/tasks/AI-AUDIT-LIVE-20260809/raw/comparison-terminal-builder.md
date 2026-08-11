# AC1-AC3 comparison, numeric guard, and terminal recovery builder evidence

Date: 2026-08-09 (Europe/Moscow)  
Mode: BUILD  
Frozen spec: `.agent/tasks/AI-AUDIT-LIVE-20260809/spec.md`

## Scope

Changed only the assigned AC1-AC3 surfaces:

- `src/ai/agentManagerOrchestrator.ts`
- `src/ai/agentManagerRevisedAnswerGuard.ts`
- `tests/agentManagerOrchestrator.test.ts`
- `tests/agentManagerRevisedAnswerGuard.test.ts`

No web-timeout, tool-registry, turn-budget, chat-route, repository, or product-research code was edited by this builder. Other dirty files in those areas belong to concurrent builders and were left untouched.

## RED proof

The initial focused run selected the three new regressions in the two owning test files. Result: exit 1, 2 test files failed, 3 tests failed, 163 skipped, 166 total.

Primary failures:

1. `accepts a buyer budget threshold only through an exact typed requirement binding`: the grounded `90 000 RUB` buyer threshold was rejected as an unsupported numeric product claim.
2. `keeps an over-budget explicit comparison subject as reference evidence but never as a card`: the writer received only CHAMPION; Masalta was removed before comparison evidence reached the model.
3. `commits one fenced degraded answer when the recovered draft is blocked again`: the recovered execution threw `Agent manager answer blocked: semantic_answer_rejected` instead of committing a terminal degraded response.

An isolated comparison RED after the first implementation attempt remained 1 failed / 151 skipped because Masalta still did not reach the writer. A direct owning-helper trace showed the pre-existing fuzzy matcher returned `false` for the identical string `Виброплита Masalta MS125-4`. This caused a design reframe to current typed `productMentions[].role=comparison_subject` plus exact contiguous model-token identity.

The first connected turn-3 generator run then failed 1 / 151 skipped: stale comparison subjects with no grounded rejection reason were resurrected after a changed load. The evidence role was narrowed so only a deterministically rejected comparison subject can re-enter as reference-only evidence; eligible products continue through the separate recommendation set.

## Implemented owning design

- Preserve exact current `comparison_subject` evidence by exact name/model-token identity and exact prior-card IDs.
- Keep `recommendation_candidate` and `comparison_reference_only` roles separate. A filtered subject is reference-only only when it has a non-empty deterministic structured rejection reason. The production budget/price violation carries requirement ID, required value, actual product price, unit, and source evidence.
- Mechanical selected-product validation and visible-card selection accept only recommendation-eligible IDs. Reference-only products remain factual writer/reviewer evidence and receive a required rejection clause.
- The first numeric-guard implementation used an exact full-sentence `claimText` binding. The fresh verifier proved that this was still writer-controlled and could authorize a forged product price. The superseding fixer design and evidence are recorded below.
- Represent semantic review rejection with a typed error. The initial block still escapes to the single recovery path. A second typed block during recovered execution enters the existing fenced `completeTerminalTurn` path with `answer_blocked_after_semantic_recovery`; it does not execute tools or lead side effects again.

## Focused GREEN proof

Command:

```powershell
npm.cmd test -- tests/agentManagerOrchestrator.test.ts -t "keeps an over-budget explicit comparison subject|keeps the validated load calculation"
```

Result: exit 0, 1 file passed, 2 tests passed, 150 skipped. This jointly proves the changed-budget comparison and the connected changed-load turn-3 non-resurrection regression.

The three new focused regressions were also rerun together after the final implementation:

```powershell
npm.cmd test -- tests/agentManagerOrchestrator.test.ts tests/agentManagerRevisedAnswerGuard.test.ts -t "keeps an over-budget explicit comparison subject|accepts a buyer budget threshold only through an exact typed requirement binding|commits one fenced degraded answer when the recovered draft is blocked again"
```

Result: exit 0, 2 files passed, 3 tests passed, 163 skipped, 166 total.

## Full owning and connected GREEN proof

```powershell
npm.cmd test -- tests/agentManagerRevisedAnswerGuard.test.ts
```

Result: exit 0, 1 file passed, 14 tests passed.

```powershell
npm.cmd run test:eval:agentic
```

Result: exit 0, 4 files passed, 251 tests passed. This includes the full 152-test orchestrator suite plus contracts, card selection, and sales-manager selection scenarios.

```powershell
npm.cmd run typecheck
```

Result: exit 0 for both `tsconfig.json` and `tsconfig.server.json`.

```powershell
npm.cmd run lint:no-regex
```

Result: exit 0, `No new regex constructs. Legacy baseline: 508.`

```powershell
git diff --check -- src/ai/agentManagerOrchestrator.ts src/ai/agentManagerRevisedAnswerGuard.ts tests/agentManagerOrchestrator.test.ts tests/agentManagerRevisedAnswerGuard.test.ts
```

Result: exit 0. Git emitted only the repository's CRLF conversion warnings; no whitespace error was reported.

## Fresh-verifier fixer pass

The verifier supplied an adversarial case where the forged sentence `CHAMPION PC1150FT стоит 90 000 ₽.` carried an exact matching `buyer_requirement_threshold` binding. Because the first contract trusted free answer `claimText`, the guard returned no issues.

Focused exploit RED:

```powershell
npm.cmd test -- tests/agentManagerRevisedAnswerGuard.test.ts -t "accepts a buyer budget threshold only through an exact typed requirement binding"
```

Result: exit 1, 1 failed, 13 skipped. The forged full-sentence binding returned `[]` instead of `review_rewrite_unsupported_numeric_product_claim`.

The guard-owned contract now removes `claimText` authority and requires `verifiedSourceQuote`. The guard does not trust a caller-provided boolean: it independently verifies that the exact quote is contiguous in both the current user message and the reviewer rewrite, that the quote contains a lexical token rather than only a number/unit, and that the exact numeric occurrence being authorized lies inside that quote. Only a buyer-requirement threshold uses this mixed product/requirement authorization; calculator numbers remain fail-closed in mixed-product sentences and continue to work in a separate non-product sentence.

Focused guard GREEN after the fix:

```powershell
npm.cmd test -- tests/agentManagerRevisedAnswerGuard.test.ts -t "accepts a buyer budget threshold only through an exact typed requirement binding"
```

Result: exit 0, 1 passed, 13 skipped.

Full guard GREEN after the fix:

```powershell
npm.cmd test -- tests/agentManagerRevisedAnswerGuard.test.ts
```

Result: exit 0, 1 file passed, 14 tests passed. The benign product-before-threshold sentence passes only when it preserves the exact meaningful buyer quote. The forged product-price sentence, a numeric-only `90 000 ₽` quote, and a sentence containing both a forged product-price occurrence and a separate valid buyer quote all remain blocked.

The second verifier blocker is prepared as a generic AC1 RED: two exact previously visible comparison subjects, a strict `weight_max_kg=100` requirement, and a current catalog detail proof showing 126 kg for the violating product and 97 kg for the eligible product. The test will require the heavy product to remain `comparison_reference_only` with the existing violated requirement proof/reason, while the light product alone is eligible/selected/card-visible and a non-mentioned neighboring product stays absent. Per the integration owner's overlap fence, this orchestrator test and its production fix are not written until the concurrent web worker explicitly releases the shared orchestrator files.

Shared typecheck and agentic suites have intentionally not been rerun after this fixer-only guard contract change because the orchestrator producer is intentionally stale and currently owned by the concurrent web worker. They must be rerun after the trusted quote is enriched by the producer.

## Boundary

No OpenAI/local live call, production widget test, commit, push, deployment, full `verify`, build, dependency audit, or secret scan was performed by this bounded builder. Those remain integration/evidence responsibilities for the parent task.
