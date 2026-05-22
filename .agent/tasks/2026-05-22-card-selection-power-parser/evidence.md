# Evidence: card selection power parser without regex

Task ID: `2026-05-22-card-selection-power-parser`
Recorded: `2026-05-22T09:15:23+03:00`
Base HEAD: `dde22b8`

## Summary

Replaced the legacy regex-based generator power range parser in `src/ai/agentManagerCardSelection.ts` with a deterministic scanner. The parser still only affects numeric ranking of already-selected generator catalog cards; it does not decide buyer intent, product suitability, answer text, or public API behavior.

The scanner preserves the previous supported inputs:

- decimal numbers with `.` or `,`;
- range separators `-`, `–`, `—`, and `до`;
- power units `кВт`, `kw`, `kva`, and `ква`.

## Validation

- `npm test -- tests/agentManagerCardSelection.test.ts`: PASS, 1 file, 7 tests.
- `npm run lint:no-regex`: PASS after baseline update, `Legacy baseline: 1824`.
- `npm run typecheck`: PASS.
- `npm test`: PASS, 73 files, 596 tests.
- `npm run build`: PASS.
- `git diff --check`: PASS with CRLF warnings only.

## Behavior Parity

- Added focused tests proving range request `4-6 kw` still ranks a 5 kW generator before 4 kW and 8 kW.
- Added focused test proving exact decimal request `5,5 kw` still ranks 5.5 kW before nearby and oversized products.
- No prompt, model, API route, database schema, widget contract, or production behavior code changed.

## Regex Debt

The pass removed four legacy regex findings from the guard baseline. `scripts/no-regex-baseline.json` was regenerated with reviewed count `1824`.

## Verdict

PASS for this refactor pass. Production Promptfoo/widget rerun is not required because this is a deterministic parser replacement inside visible-card ranking with focused parity tests and no runtime behavior surface changes beyond preserving existing numeric ordering.
