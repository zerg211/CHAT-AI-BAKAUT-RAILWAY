# Task: sitemap product extraction no-regex parsing pass

## Current behavior

`src/catalog/sitemapSync.ts` still uses legacy regex for deterministic product/page extraction tasks:

- recognizing document links by file suffix;
- extracting CSS `url(...)` image references from inline style text;
- finding article text in product captions;
- detecting brand-like spec keys and fallback brand tokens in product names;
- recognizing `404` headings;
- collapsing duplicate whitespace after readable page extraction.

These are catalog ingest mechanics. They are not buyer-intent or assistant-response semantics.

## Structural improvement

Replace the remaining targeted regex call sites in sitemap product extraction with explicit string helpers:

- suffix-based document link detection after trimming query/hash;
- CSS URL scanner;
- article caption parser;
- brand-key and token validators;
- token-based `404` heading check;
- rely on existing `cleanText` whitespace normalization for readable page text.

## Acceptance Criteria

- AC1: `src/catalog/sitemapSync.ts` contains no regex literals, regex constructors, regex arguments, or regex method calls in the targeted product/page extraction helpers.
- AC2: Document links with query/hash suffixes are still collected.
- AC3: CSS `url(...)` image references are still collected.
- AC4: Article captions still populate `raw.article`.
- AC5: Brand extraction still prefers brand/manufacturer spec keys and falls back to the first brand-like name token.
- AC6: `404` headings still make product/content extraction skip the page.
- AC7: Public `syncCatalogFromSitemap` API and repository contracts stay unchanged.
- AC8: Focused sitemap tests, typecheck, build, and no-regex guard pass.
- AC9: The no-regex baseline is updated only after reviewing removed legacy findings.
- AC10: Evidence is recorded in this task folder.

## Validation plan

- `npx vitest run tests/sitemapSyncNoRegex.test.ts`
- `npm run typecheck`
- `npm run build`
- `npm run lint:no-regex`
- `npm run lint:no-regex -- --update-baseline`
- `npm run lint:no-regex`

Production Promptfoo is not required for this catalog ingest parser refactor because it does not change the chat answer runtime. The code still must be committed, pushed, and observed through the Railway marker.
