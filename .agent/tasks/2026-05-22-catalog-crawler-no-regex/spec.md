# Task: catalog crawler no-regex parsing pass

## Current behavior

`src/catalog/crawler.ts` uses legacy regex for a few deterministic parsing tasks:

- blocking binary/document catalog URLs by extension;
- splitting specification label/value text on common separators;
- detecting product-page signals in HTML;
- removing one trailing slash from normalized inventory URLs.

These are not semantic buyer-intent decisions. They are deterministic catalog crawler mechanics.

## Structural improvement

Replace these regex call sites with explicit parser/string helpers:

- suffix-list URL extension check;
- character scanner for spec separators;
- lowercase substring checks for product-page signals;
- one-trailing-slash helper for URL normalization.

Do not change crawler public entry points, repository contracts, or product import shape.

## Acceptance Criteria

- AC1: `src/catalog/crawler.ts` contains no regex literals, regex constructor usage, or regex arguments.
- AC2: Binary/document catalog links remain skipped by suffix.
- AC3: Spec extraction still handles `:`, `-`, and em dash separators.
- AC4: Product-page signal detection still accepts buy/article/specification wording without regex.
- AC5: Inventory URL normalization still removes only one trailing slash after stripping hash/search.
- AC6: Focused crawler tests, typecheck, build, and no-regex guard pass.
- AC7: The no-regex baseline is updated only after reviewing the removed legacy findings.
- AC8: Evidence is recorded in this task folder.

## Validation plan

- `npx vitest run tests/catalogCrawlerNoRegex.test.ts`
- `npm run typecheck`
- `npm run build`
- `npm run lint:no-regex`
- `npm run lint:no-regex -- --update-baseline`
- `npm run lint:no-regex`

Production Promptfoo is not required for this crawler-only deterministic parsing refactor because it does not change the chat runtime path. The code still must be committed, pushed, and observed through the Railway marker.
