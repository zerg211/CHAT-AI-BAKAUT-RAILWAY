# Evidence: sales-manager progressive selection

Status: IN PROGRESS

## Implemented architectural changes

- The LLM planner contract now distinguishes `browse_catalog`, `preliminary_fit`, and `final_fit`.
- Each requirement carries an explicit semantic relation: `must_have`, `must_not_have`, `preferred`, `not_required`, or `context`.
- `autostart_required=false` is not an exclusion unless the LLM explicitly returns `relation=must_not_have`.
- Generator load uncertainty is stage-aware: it can block a fit claim without blocking explicit catalog/price browsing.
- Structured catalog constraints are applied to a larger candidate pool before the visible top-N cut.
- An empty exact pool triggers one bounded structured recovery over at most 1,000 same-class catalog rows.
- Recovery produces typed exact/preliminary/compromise/rejected evidence. Compromises are sorted by numeric distance and must be labelled with tradeoffs.
- Previously validated visible products from the active need are merged with new catalog results and revalidated even when the new raw search is non-empty but unusable.
- An empty LLM `selectedProductIds` delta no longer erases system-validated selection; explicit buyer rejection may remove the rejected ID.
- `catalog.getProductDetails.productIds` is now executed as an exact database lookup instead of being ignored.
- A failed fresh catalog lookup no longer overwrites a grounded answer that uses still-valid historical product evidence; failed tool citations are removed from the final contract.

## Current verification

- Focused regression suite: PASS.
- Typecheck: PASS.
- `lint:no-regex`: PASS.
- Agentic eval suite: PASS (251 tests).
- Full release gate on final current code: PASS — 105 files / 965 tests, 251 agentic eval tests, typecheck, dependency audit, regex guard, and production build.
- GitHub/Railway deployment: pending.
- Embedded production replay and admin audit: pending.

The frozen public failure remains session `1cac3ca2-472f-4488-b96d-ac920d1ed310`. The public sitemap audit found 103 unique generator product URLs with 5.5-6.0 kW in their catalog names, so the former “few confirmed variants” response was a retrieval failure rather than catalog absence.
