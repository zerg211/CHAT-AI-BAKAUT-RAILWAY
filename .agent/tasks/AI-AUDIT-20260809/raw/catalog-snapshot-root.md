# Catalog page identity and source snapshot — root tranche

## RED

- `npm.cmd test -- --run tests/catalogProductPageIdentity.test.ts` failed because no page-identity gate existed.
- `npm.cmd test -- --run tests/catalogRepositoryFreshness.test.ts` failed because the upsert merged `products.specs || EXCLUDED.specs`, merged `raw`, and retained stale optional values.

## Implementation

- Added a shared page-specific product evidence gate used by both crawler paths.
- A listing/category page containing child Product/Offer/card markup is rejected unless the current document itself declares product identity through exact URL-bound JSON-LD, `og:type=product`, or a single Bakaut detail-layout identity.
- Same-source product refresh now replaces source-owned brand/category/price/image/description/specs/raw fields. Removed or corrected fields therefore do not survive as stale data.
- When source content changes without a fresh embedding, the stale vector and its metadata are cleared for later backfill instead of remaining buyer-searchable.
- Stable source identity fields (`external_id`, `slug`) retain their prior value only when the new source snapshot omits them.

## GREEN

- `npm.cmd test -- --run tests/catalogProductPageIdentity.test.ts tests/catalogCrawlerNoRegex.test.ts tests/sitemapSyncNoRegex.test.ts tests/catalogRepositoryFreshness.test.ts` → 19/19 PASS.
- Follow-up RED proved that a listing with shared detail/price CSS classes plus two distinct product IDs still passed the layout gate. The owning gate now rejects any layout carrying more than one product identity; the focused identity/crawler/sitemap rerun is 14/14 PASS. The combined count will be refreshed in the final verification pass.

## Remaining boundary

`upsertProduct` and its subsequent fact delete/insert/refresh sequence still span multiple repository queries without one transaction. The snapshot is now semantically correct, but crash-atomic product+fact replacement remains a follow-up rather than a claimed fix.

No commit, push, live crawl or production catalog mutation was performed.
