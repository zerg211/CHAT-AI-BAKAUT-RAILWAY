# Task: catalog normalize no-regex parsing pass

## Current behavior

`src/catalog/normalize.ts` uses legacy regex for deterministic text normalization:

- building slugs from URL paths;
- removing whitespace from price text and finding the first numeric price;
- collapsing whitespace in spec keys, clean text, and CSV headers;
- removing a trailing colon from spec keys.

These are deterministic parser tasks, not semantic buyer-intent decisions.

## Structural improvement

Replace the regex use with explicit string scanners/helpers while preserving exported functions and return shapes:

- path segment splitting via URL pathname segments;
- whitespace collapse/removal helpers;
- first-price-number scanner;
- first-comma normalization for prices;
- one trailing colon removal.

## Acceptance Criteria

- AC1: `src/catalog/normalize.ts` contains no regex literals, regex constructor usage, regex arguments, or regex method calls.
- AC2: Existing exports and signatures remain stable.
- AC3: URL slug normalization keeps current behavior for catalog URLs.
- AC4: Russian price text with spaces and comma/dot decimals still parses.
- AC5: spec keys, clean text, and CSV headers still normalize whitespace and casing.
- AC6: Focused normalize tests, crawler tests, typecheck, build, and no-regex guard pass.
- AC7: The no-regex baseline is updated only after reviewing the removed legacy findings.
- AC8: Evidence is recorded in this task folder.

## Validation plan

- `npx vitest run tests/normalize.test.ts tests/catalogCrawlerNoRegex.test.ts`
- `npm run typecheck`
- `npm run build`
- `npm run lint:no-regex`
- `npm run lint:no-regex -- --update-baseline`
- `npm run lint:no-regex`

Production Promptfoo is not required for this deterministic catalog normalization refactor because it does not change the chat answer runtime. The code still must be committed, pushed, and observed through the Railway marker.
