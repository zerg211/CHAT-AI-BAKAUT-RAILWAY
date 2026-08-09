# Product referents / terminal catalog recovery builder evidence

Mode: BUILD. Scope: `src/ai/agentManagerOrchestrator.ts` and targeted `tests/agentManagerOrchestrator.test.ts` only. No commit/push/deploy.

## Root cause and implementation

- A structured `reusePreviousCards` turn filtered prior visible cards through the current need's `selectedProductIds`. When that array was empty, the exact cards from the immediately preceding assistant message were lost even though their metadata still contained canonical IDs, names and prices.
- The planner repair did not copy those grounded IDs into `catalog.getProductDetails.args.productIds`; exact repository lookup therefore depended on the model already emitting IDs.
- `completeTerminalTurn()` recovered products only from successful `catalog.search` artifacts. A successful `catalog.getProductDetails` followed by web timeout therefore produced the generic empty terminal answer.

Implemented:

- `visibleCardProducts`, `previousProductReferents` and `repairIntentForPreviousProductReferents` recover only a typed `reusePreviousCards` comparison/product-selection referent set, preferring selected IDs that are also present in visible cards, then exact planner mentions, then the latest visible card set.
- Exact referent IDs are added to a matching `catalog.getProductDetails` request (or a new bounded details request before web). Exact IDs take precedence over fuzzy text lookup in the details executor.
- Current answer selection preserves those exact historical products and records `previousProductReferents` metadata.
- Terminal recovery consumes both successful `catalog.search` and `catalog.getProductDetails` artifacts, with current exact details overriding lossy historical cards for the same ID. When only prior visible cards survive a failed current lookup, they remain eligible evidence rather than disappearing.
- The deterministic terminal answer names each preserved product, includes its known price, lists the concrete unfinished web attributes, and is persisted through the existing final answer/assistant-message transaction.

Primary code locations after implementation:

- `src/ai/agentManagerOrchestrator.ts:2579` terminal catalog recovery from search/details/prior referents.
- `src/ai/agentManagerOrchestrator.ts:2643` named/price-bearing terminal orientation.
- `src/ai/agentManagerOrchestrator.ts:3444` visible-card decoding.
- `src/ai/agentManagerOrchestrator.ts:3485` grounded prior-product referent resolution.
- `src/ai/agentManagerOrchestrator.ts:3523` exact-ID details-request repair.
- `src/ai/agentManagerOrchestrator.ts:6445` planner repair integration.
- `src/ai/agentManagerOrchestrator.ts:6641` current answer/card continuity integration.
- `src/ai/agentManagerOrchestrator.ts:7737` exact-ID precedence over fuzzy text lookup.
- `src/ai/agentManagerOrchestrator.ts:9365` terminal history/referent integration.

## RED evidence

### Live defect #1844 fixture

Command:

`npm.cmd test -- tests/agentManagerOrchestrator.test.ts -t "rehydrates exact prior-card ids"`

Before implementation: exit 1. The current `catalog.getProductDetails` request had `args.productIds === undefined`; expected `['prior-generator-a', 'prior-generator-b']`. This fixture contains an immediately preceding assistant message with exactly two product cards/prices, an empty current `selectedProductIds`, current details returning no exact rows, and persisted web timeout.

### Live defect #1842 fixture

Command:

`npm.cmd test -- tests/agentManagerOrchestrator.test.ts -t "terminalizes successful exact catalog details"`

Before implementation: exit 1. Expected the exact model `TSS SGG 6000E 5.5 kW generator` in the terminal answer, but received the generic `Не успел надёжно завершить проверку...` answer with no cards. The persisted artifacts were `catalog.getProductDetails=ok` plus `web.researchProductFacts=timeout`.

## GREEN evidence

### Exact target tests

Command:

`npm.cmd test -- tests/agentManagerOrchestrator.test.ts -t "rehydrates exact prior-card ids|terminalizes successful exact catalog details"`

Result: exit 0; 2 passed, 142 skipped.

Assertions prove:

- the details request receives the exact two prior card IDs;
- repository `getProductsByIds` is invoked with those IDs;
- answer composition receives both prior products with exact prices despite current details `not_found` and web timeout;
- response cards keep the same IDs/prices and the answer does not claim cards/prices/catalog evidence are absent;
- successful exact detail evidence plus web timeout yields a terminal answer containing the exact model, `74 990`, and the concrete missing fact `пусковой ток подключаемого насоса`;
- the terminal response has the exact card, answer-contract selected ID, detail artifact ID, and a persisted assistant message.

### Connected continuity/terminal regressions

Command:

`npm.cmd test -- tests/agentManagerOrchestrator.test.ts -t "honors catalog.getProductDetails productIds|keeps current catalog details when a same-id historical visible card is lossy|reuses previous visible cards|keeps the validated load calculation|preserves eligible catalog cards|rehydrates exact prior-card ids|terminalizes successful exact catalog details"`

Result: exit 0; 7 passed, 137 skipped.

### Full orchestrator suite

Command:

`npm.cmd test -- tests/agentManagerOrchestrator.test.ts`

Result: exit 0; 144 passed.

### Static gates

- `npm.cmd run typecheck` — exit 0 (`tsc --noEmit -p tsconfig.json` and `tsc --noEmit -p tsconfig.server.json`).
- `npm.cmd run lint:no-regex` — exit 0; no new regex constructs, legacy baseline 508.
- `git diff --check` — exit 0. Output contained only existing Windows LF/CRLF conversion warnings.

## Validation boundary

Local deterministic validation is complete for this builder scope. No production widget validation, commit, push, Railway deployment, or final PASS claim was performed by this builder.
