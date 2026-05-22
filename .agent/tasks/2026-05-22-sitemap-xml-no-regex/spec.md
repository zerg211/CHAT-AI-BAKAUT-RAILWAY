# Task: sitemap XML no-regex parsing pass

## Current behavior

`src/catalog/sitemapSync.ts` uses legacy regex for deterministic sitemap XML parsing:

- decoding XML entities;
- finding `<sitemap>...</sitemap>` blocks;
- finding `<url>...</url>` blocks;
- extracting `<loc>` and `<lastmod>` text.

These are catalog ingest mechanics. They are not buyer-intent or assistant-response semantics.

## Structural improvement

Replace the regex-based sitemap XML parsing with explicit string-scanning helpers:

- XML entity decoder via known entity replacement;
- case-insensitive XML block scanner for a named tag;
- tag text extractor for `loc` and `lastmod`;
- preserve duplicate URL de-duplication and sitemap index behavior.

## Acceptance Criteria

- AC1: The targeted sitemap XML parser functions use no regex literals, regex constructors, regex arguments, or regex method calls.
- AC2: Sitemap index parsing still follows child sitemap `<loc>` values.
- AC3: URL set parsing still extracts `loc` and `lastmod`.
- AC4: Plain XML with only `<loc>` tags still falls back to loc extraction.
- AC5: XML entities in loc values still decode.
- AC6: Public `syncCatalogFromSitemap` API and repository contracts stay unchanged.
- AC7: Focused sitemap tests, typecheck, build, and no-regex guard pass.
- AC8: The no-regex baseline is updated only after reviewing removed legacy findings.
- AC9: Evidence is recorded in this task folder.

## Validation plan

- `npx vitest run tests/sitemapSyncNoRegex.test.ts`
- `npm run typecheck`
- `npm run build`
- `npm run lint:no-regex`
- `npm run lint:no-regex -- --update-baseline`
- `npm run lint:no-regex`

Production Promptfoo is not required for this catalog ingest parser refactor because it does not change the chat answer runtime. The code still must be committed, pushed, and observed through the Railway marker.
