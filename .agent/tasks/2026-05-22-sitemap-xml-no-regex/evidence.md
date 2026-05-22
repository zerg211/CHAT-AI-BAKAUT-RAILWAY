# Evidence: sitemap XML no-regex parsing pass

Task id: `2026-05-22-sitemap-xml-no-regex`

Timestamp: `2026-05-22T19:21:24.3765373+03:00`

## Change summary

- Replaced regex-based sitemap XML parsing in `src/catalog/sitemapSync.ts` with deterministic string scanners:
  - XML entity decoder via known entity replacement;
  - XML block scanner for named tags;
  - single/all tag text extraction for `loc` and `lastmod`.
- Added `tests/sitemapSyncNoRegex.test.ts` to verify behavior through the public `syncCatalogFromSitemap` API with mocked `undici.fetch`.
- Updated `scripts/no-regex-baseline.json` after reviewing the removed legacy findings.

## Behavior preservation

Current behavior:
- Sitemap index files point the sync to child sitemap URLs.
- URL sets provide product/content candidates from `<loc>` entries.
- `<lastmod>` is preserved on URL entries.
- XML loc entities are decoded.
- Plain XML with only `<loc>` tags falls back to loc extraction.

Structural improvement:
- Sitemap XML parsing no longer relies on regex for these deterministic ingest tasks.
- The parsing helpers are local, explicit, and covered by focused tests.

Validation check:
- Focused sitemap sync tests passed.
- Typecheck passed.
- Production build passed.
- No-regex guard passed after baseline update.

## Commands

```text
npx vitest run tests/sitemapSyncNoRegex.test.ts
PASS: 1 test file, 2 tests

npm run typecheck
PASS

npm run build
PASS

npm run lint:no-regex
PASS before baseline update: no new regex; 22 legacy findings removed

npm run lint:no-regex -- --update-baseline
PASS: Updated scripts/no-regex-baseline.json with 1641 legacy findings.

npm run lint:no-regex
PASS: No new regex constructs. Legacy baseline: 1641.
```

## Acceptance criteria

- AC1: PASS. Targeted sitemap XML parser functions no longer use the removed regex constructs.
- AC2: PASS. Focused test proves sitemap index parsing follows child sitemap `<loc>` values.
- AC3: PASS. Focused test proves URL set parsing extracts product/content candidates and keeps `<lastmod>` path behavior via the public sync flow.
- AC4: PASS. Focused test proves plain XML with only `<loc>` tags still works.
- AC5: PASS. Focused test proves `&amp;` in loc values decodes before URL classification.
- AC6: PASS. Public `syncCatalogFromSitemap` signature and repository call shape stayed unchanged.
- AC7: PASS. Focused sitemap test, typecheck, build, and no-regex guard passed.
- AC8: PASS. Baseline updated after reviewing the sitemap diff and removed findings.
- AC9: PASS. Evidence is recorded here.

## Production eval

Production Promptfoo is not required for this pass: the changed code is deterministic catalog sitemap ingest, not the chat answer runtime. The deployment marker must still be checked after push.

Railway marker after push:

```text
19:23:39 commit=04b205b9615727bcfb10d608c566a653bce6006f branch=main
MARKER_OK
```
