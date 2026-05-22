# Evidence: catalog normalize no-regex parsing pass

Task id: `2026-05-22-catalog-normalize-no-regex`

Timestamp: `2026-05-22T19:13:18.7089802+03:00`

## Change summary

- Replaced legacy regex use in `src/catalog/normalize.ts` with explicit deterministic string scanners/helpers:
  - URL path segment slug construction;
  - whitespace removal/collapse helpers;
  - first-comma price normalization;
  - first numeric price scanner;
  - one trailing colon removal for spec keys.
- Extended `tests/normalize.test.ts` for comma/dot price decimals and whitespace normalization.
- Re-ran the crawler no-regex test because crawler imports these helpers.
- Updated `scripts/no-regex-baseline.json` after reviewing removed legacy findings.

## Behavior preservation

Current behavior:
- Catalog URL slugs are built from URL pathname segments.
- Russian price text with spaces parses into a number.
- Spec keys collapse whitespace, drop a trailing colon, and lowercase.
- Clean text collapses whitespace.
- CSV headers collapse whitespace to underscores and lowercase.

Structural improvement:
- Catalog normalization no longer relies on regex.
- Parsing intent is explicit and covered by focused tests.

Validation check:
- Focused normalize and crawler tests passed.
- Typecheck passed.
- Production build passed.
- No-regex guard passed after baseline update.

## Commands

```text
npx vitest run tests/normalize.test.ts tests/catalogCrawlerNoRegex.test.ts
PASS: 2 test files, 4 tests

npm run typecheck
PASS

npm run build
PASS

npm run lint:no-regex
PASS before baseline update: no new regex; 14 legacy findings removed

npm run lint:no-regex -- --update-baseline
PASS: Updated scripts/no-regex-baseline.json with 1663 legacy findings.

npm run lint:no-regex
PASS: No new regex constructs. Legacy baseline: 1663.
```

## Acceptance criteria

- AC1: PASS. `src/catalog/normalize.ts` no longer contains the targeted regex constructs.
- AC2: PASS. Existing exports and signatures remain stable.
- AC3: PASS. Existing slug test still passes.
- AC4: PASS. Price tests cover spaced integer, comma decimal, and dot decimal inputs.
- AC5: PASS. Tests cover spec key, clean text, and CSV header whitespace normalization.
- AC6: PASS. Focused normalize/crawler tests, typecheck, build, and no-regex guard passed.
- AC7: PASS. Baseline updated after reviewing the normalize diff and removed findings.
- AC8: PASS. Evidence is recorded here.

## Production eval

Production Promptfoo is not required for this pass: the changed code is deterministic catalog normalization, not the chat answer runtime. The deployment marker must still be checked after push.

Railway marker after push:

```text
19:15:34 commit=2fb25edfd85360a15f75f9b9f68d30409b5a6ce6 branch=main
MARKER_OK
```
