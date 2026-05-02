# CDP shortlist/card drift fix — local-only

Status: code fix applied and local automated verification passed.

Scope:
- No Railway deploy.
- No GitHub push.
- No production writes.
- Local dev server/browser live check was attempted, but blocked because local PostgreSQL/Docker is not running in this environment.

Root cause:
1. The buyer asked for a human shortlist: one first option plus one normal alternative.
2. The text answer could narrow to two models, but the product/card contract still allowed the broader structured selection slice.
3. On the follow-up (“Почему именно первый?”), ranking could re-sort candidates and move a hidden/cheaper product or a different model ahead of the previously visible pair.
4. For cheapest ranking, selected/current visible products had a score boost, but the cheapest-first sorter could still put cheaper hidden matches before the selected pair.

Fix:
- `requestedVisibleCardLimitFromText()` now recognizes natural “какой вариант первым + альтернатива” wording as a 2-card shortlist request.
- `selectProductsForTurn()` now pins the current visible selected products to the front when:
  - a visible-card limit is active,
  - the previous selected pair is available,
  - the user is not explicitly broadening alternatives,
  - there are no exact model/comparison tokens that should override the current pair.
- This is a state/contract-level fix, not a product-specific or trigger-word patch for SUMEC.

Regression tests added:
- `tests/turnContract.test.ts`
  - natural “какой вариант первым + альтернатива” returns visible card limit `2`.
- `tests/recommendationRanking.test.ts`
  - natural first-plus-alternative shortlist stays at the selected pair;
  - follow-up “Почему именно первый? Хватит ли запаса...” keeps the same first/backup pair and does not drift to hidden matches.

Verification passed:

```bash
CI=1 npx vitest run tests/turnContract.test.ts tests/recommendationRanking.test.ts -t "natural first-plus-alternative|caps visible product|keeps LLM previous-selection|broaden alternatives" --reporter=dot
# 2 passed, 4 tests passed

CI=1 npm test -- --run tests/turnContract.test.ts tests/recommendationRanking.test.ts --reporter=dot
# 2 passed, 109 tests passed

npm run typecheck
# exit 0

npm run build
# exit 0

git diff --check
# exit 0

CI=1 npm test -- --reporter=dot
# 13 passed, 140 tests passed
```

Live/browser verification attempt:
- Tried to start local backend/frontend after tests.
- Frontend started, but backend failed during migration because PostgreSQL was unavailable:
  - `connect ECONNREFUSED 127.0.0.1:5432`
- Tried to start local `docker compose up -d postgres`, but Docker daemon was unavailable:
  - `Cannot connect to the Docker daemon at unix:///var/run/docker.sock`
- Cleanup completed: killed local 3010/5173 ports; tracked background processes empty.

Conclusion:
- Code-level and regression verification for the CDP defect passed.
- Browser/live re-run still needs local PostgreSQL or Docker daemon available.
