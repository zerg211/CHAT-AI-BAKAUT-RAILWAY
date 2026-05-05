# Verification: LLM-first product selection hardening

Scope: `/mnt/c/Projects/chatAI` only.

## Changed files

- `src/ai/assistant.ts`
- `src/ai/productClassifier.ts`
- `src/ai/needState.ts`
- `tests/recommendationRanking.test.ts`
- Plan: `docs/plans/2026-05-02-llm-brain-vibroplate-remediation.md`

## What was fixed

1. Invalid planner fallback no longer does keyword product routing.
   - Before: fallback could infer product intent from words and switch to `recommend_products`.
   - Now: fallback is `answer_question` + `textOnly`; it explicitly forbids keyword card подбор when planner JSON is invalid.

2. LLM-planned product class/role now becomes an actual hard selection constraint even if there are no numeric constraints.
   - Before: `productIntent='plate'` and `productRole='coreProduct'` alone could be dropped because `hasHardUpdate` only considered budget/power/weight/model/etc.
   - Now: known `targetProductClass`, `productIntent`, `productRole` keep hard constraints active.

3. Vibroplate accessories/spares are blocked from core vibroplate cards.
   - Added product-card role guard terms for catalogue items: spares, consumables, filters, belts, oil, covers, tanks, carburetor, kits, AVR, etc.
   - These terms are used as catalogue safety validation, not buyer intent routing.
   - `isPlate` now requires not accessory/spare/consumable.

4. Lexical need extraction was downgraded.
   - `heuristicNeedUpdate` explicit product signals reduced from `0.72` to `0.31` and documented as low-authority memory hints.
   - LLM planner remains owner of turn action and product selection semantics.

5. Rejected product trace now records source candidates rejected by hard selection constraints.
   - This makes failures visible: e.g. `plate-filter`, `plate-belt` are traced as rejected instead of silently disappearing.

## Regression tests added

- Whole-equipment vibroplate request with LLM plan:
  - visible cards must be only `vibro-core`;
  - `Фильтр воздушный для виброплиты` and `Ремень привода виброплиты` must be rejected.
- Invalid planner fallback:
  - no `recommend_products`;
  - no cards;
  - no keyword-based product routing.

## Verification commands

Passed:

```bash
npm test -- --run tests/recommendationRanking.test.ts tests/needState.test.ts tests/turnContract.test.ts
# 3 passed, 114 tests passed

npm run build
# vite build + tsc -p tsconfig.server.json passed

npm test -- --run
# 13 passed, 143 tests passed
```

## Deployment status

Not deployed from this run. Work was performed in the requested local project path only.
