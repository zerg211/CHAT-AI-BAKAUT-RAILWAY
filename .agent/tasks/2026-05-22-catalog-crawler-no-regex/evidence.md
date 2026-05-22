# Evidence: catalog crawler no-regex parsing pass

Task id: `2026-05-22-catalog-crawler-no-regex`

Timestamp: `2026-05-22T19:06:50.5950631+03:00`

## Change summary

- Replaced legacy regex use in `src/catalog/crawler.ts` with explicit deterministic helpers:
  - suffix-list catalog asset/document filter;
  - character scanner for spec label/value separators;
  - lowercase substring product signal checks;
  - one-trailing-slash URL normalizer.
- Added `tests/catalogCrawlerNoRegex.test.ts` to verify link filtering, spec-separator extraction, and product signal detection through the public `inventoryCatalogFromSite` flow with mocked `undici.fetch`.
- Updated `scripts/no-regex-baseline.json` after reviewing removed legacy findings.

## Behavior preservation

Current behavior:
- Catalog crawler visits only same-host `/catalog/` pages.
- Known binary/document links are skipped.
- Specs are extracted from table/list-like page blocks.
- Product-like pages are accepted when they have enough specs, a price, or product signal wording.
- Inventory URL normalization strips hash/search and removes one trailing slash.

Structural improvement:
- Crawler parsing no longer relies on regex for these deterministic tasks.
- The behavior is explicit and easier to review as product/catalog parsing logic.

Validation check:
- Focused crawler test passed.
- Typecheck passed.
- Production build passed.
- No-regex guard passed after baseline update.

## Commands

```text
npx vitest run tests/catalogCrawlerNoRegex.test.ts
PASS: 1 test file, 1 test

npm run typecheck
PASS

npm run lint:no-regex
PASS before baseline update: no new regex; 10 legacy findings removed

npm run lint:no-regex -- --update-baseline
PASS: Updated scripts/no-regex-baseline.json with 1677 legacy findings.

npm run lint:no-regex
PASS: No new regex constructs. Legacy baseline: 1677.

npm run build
PASS
```

## Acceptance criteria

- AC1: PASS. `src/catalog/crawler.ts` no longer contains the targeted regex constructs.
- AC2: PASS. Focused test proves binary/document links are not fetched.
- AC3: PASS. Focused test proves `:`, `-`, and em dash spec separators still produce a product via spec-count signals.
- AC4: PASS. Focused test proves uppercase `КУПИТЬ` product signal still works.
- AC5: PASS by implementation review: `stripOneTrailingSlash` removes only one trailing slash after hash/search stripping.
- AC6: PASS. Focused test, typecheck, build, and no-regex guard passed.
- AC7: PASS. Baseline updated after reviewing the crawler diff and removed findings.
- AC8: PASS. Evidence is recorded here.

## Production eval

Production Promptfoo is not required for this pass: the changed code is the admin/catalog crawler path, not the chat answer runtime. The deployment marker must still be checked after push.

Railway marker after push:

```text
19:09:04 commit=aaee506cb24ceb394017cc4970cf4f39fdc767ae branch=main
MARKER_OK
```
