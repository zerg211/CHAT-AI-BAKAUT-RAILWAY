# Evidence: sitemap product extraction no-regex parsing pass

Task id: `2026-05-22-sitemap-product-extraction-no-regex`

Timestamp: `2026-05-22T19:29:27.7155520+03:00`

## Change summary

- Replaced remaining targeted regex use in `src/catalog/sitemapSync.ts` product/page extraction helpers with explicit deterministic scanners:
  - document suffix detection after query/hash trimming;
  - CSS `url(...)` extraction;
  - article caption parsing;
  - brand spec-key detection;
  - brand-like token validation;
  - token-based `404` heading detection;
  - readable page text now relies on `cleanText` normalization.
- Extended `tests/sitemapSyncNoRegex.test.ts` to verify product metadata extraction through public `syncCatalogFromSitemap`.
- Updated `scripts/no-regex-baseline.json` after reviewing the removed legacy findings.

## Behavior preservation

Current behavior:
- Product sync collects documents, images, article, brand, price, and content pages from sitemap-discovered pages.
- Product pages with `404` headings are skipped.
- Content pages are still imported through the same repository contract.

Structural improvement:
- Product metadata extraction no longer relies on regex for the targeted deterministic parsing tasks.
- The behavior is covered via public sync flow with mocked network and repository calls.

Validation check:
- Focused sitemap sync tests passed.
- Typecheck passed.
- Production build passed.
- No-regex guard passed after baseline update.

## Commands

```text
npx vitest run tests/sitemapSyncNoRegex.test.ts
PASS: 1 test file, 3 tests

npm run typecheck
PASS

npm run build
PASS

npm run lint:no-regex
PASS before baseline update: no new regex; 18 legacy findings removed

npm run lint:no-regex -- --update-baseline
PASS: Updated scripts/no-regex-baseline.json with 1623 legacy findings.

npm run lint:no-regex
PASS: No new regex constructs. Legacy baseline: 1623.
```

## Acceptance criteria

- AC1: PASS. Targeted product/page extraction helpers no longer use the removed regex constructs.
- AC2: PASS. Focused test proves document links with query strings are collected.
- AC3: PASS. Focused test proves CSS `url(...)` image references are collected.
- AC4: PASS. Focused test proves article captions populate `raw.article`.
- AC5: PASS. Focused test proves brand spec keys are preferred; implementation keeps fallback brand-token validation.
- AC6: PASS. Focused test proves `404` heading pages are skipped.
- AC7: PASS. Public `syncCatalogFromSitemap` signature and repository call shape stayed unchanged.
- AC8: PASS. Focused sitemap test, typecheck, build, and no-regex guard passed.
- AC9: PASS. Baseline updated after reviewing the sitemap product extraction diff and removed findings.
- AC10: PASS. Evidence is recorded here.

## Production eval

Production Promptfoo is not required for this pass: the changed code is deterministic catalog sitemap ingest, not the chat answer runtime. The deployment marker must still be checked after push.

Railway marker after push:

```text
19:31:23 commit=f527e4d7e0316a87d70c34736bf1c299dd65ca9b branch=main
MARKER_OK
```
