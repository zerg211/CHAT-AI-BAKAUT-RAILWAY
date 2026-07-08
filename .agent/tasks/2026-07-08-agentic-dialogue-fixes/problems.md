# Problems Found During Fresh Verification

## P1: Battery station kW range did not find watt-denominated catalog products

Production widget check on `2026-07-08T13:43:07.320Z` failed for:

- Buyer: `Нужен генератор 1-1,8 кВт аккумуляторный, выход 220 В.`
- Result: no visible cards.
- Metadata: `catalog_products_filtered_by_power_source:battery:36`, `catalog_search_no_power_source_fit:battery`, `catalog_search_no_matches`.

Root cause:

- The LLM query used `battery generator 1-1.8 kW 220 V`, while the catalog category is `аккумуляторные электростанции`.
- Battery products such as APS800/APS1800 store/display power in watts, so the range request in kW was not reliably matched to those products.

Fix:

- Added a battery-station fallback catalog pool when a battery power-source requirement is present but the initial query returns no battery products.
- Added local watt-to-kW extraction for product text/specs without changing the global `powerRegex` semantics used by load-estimation code.

Verification after fix:

- PASS `npm test -- tests/recommendationRanking.test.ts tests/agentManagerCardSelection.test.ts`
- PASS `npm run typecheck`
- PASS `npm test` with 94 files and 763 tests.
