# Evidence: Widget Embed No-Regex Pass

## Change

- Replaced regex in the generated `/widget.js` launcher script with deterministic string helpers:
  - `trimTrailingSlashes`;
  - `pixelNumber`;
  - loop-based `esc`.
- Updated `tests/app.test.ts` to keep old embed compatibility markers and verify the new helper-based implementation.

## Behavior Preserved

- `data.chatSrc` still supports old embed snippets and strips trailing slashes.
- Width and height still clamp below `640px` and `820px`.
- Launcher fields are still HTML-escaped before insertion.

## Checks

- `npm test -- tests/app.test.ts`: PASS, 2 tests.
- `npm run lint:no-regex`: PASS, baseline remains 1782.
- `git diff --check`: PASS, only line-ending warnings.
- `npm run typecheck`: PASS.
- `npm test`: PASS, 77 files, 635 tests.
- `npm run build`: PASS.

## Acceptance Criteria

- AC1: PASS. `src/routes/widget.ts` no longer contains the legacy embed regex operations.
- AC2: PASS. `/widget.js` compatibility markers and minimum size behavior remain covered by `tests/app.test.ts`.
- AC3: PASS. No new regex constructs; baseline remains 1782. This pass removed regex embedded inside a generated script string, which the AST guard does not count.
- AC4: PASS. Targeted app/widget tests pass.
- AC5: PASS. Local non-OpenAI gates pass.
