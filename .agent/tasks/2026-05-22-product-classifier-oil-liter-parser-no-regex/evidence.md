# Evidence: product classifier oil/liter parser no-regex pass

## Change

Replaced two focused regex parsers in `src/ai/productClassifier.ts`:
- `oilViscosities(text)` now scans explicit SAE viscosity tokens such as `10W-40` and returns normalized values such as `10w40`.
- `requestedLiters(text)` now scans explicit positive numeric package volume values followed by `л` or `l`.

The public exports stay unchanged. The pass does not move semantic buyer intent into deterministic code; it only parses explicit facts that are already present in text.

## Local Validation

- `npm test -- tests/productClassifier.test.ts`: PASS, 10 tests.
- `npm run lint:no-regex`: PASS, no new regex constructs.
- `npm run lint:no-regex -- --update-baseline`: PASS, baseline reduced from 1771 to 1767.
- `npm run typecheck`: PASS.
- `npm test`: PASS, 78 files and 647 tests.
- `npm run build`: PASS.
- `git diff --check`: PASS.

## Acceptance Criteria Status

- AC1: PASS. Unit tests cover normalized viscosity extraction and embedded-token rejection.
- AC2: PASS. Unit tests cover Russian and English liter units with decimal comma support.
- AC3: PASS. Public exports and call sites are unchanged.
- AC4: PASS. Focused tests added in `tests/productClassifier.test.ts`.
- AC5: PASS. Local non-OpenAI gates passed.
- AC6: PENDING. Production Promptfoo/widget harness must run after push and Railway deployment marker.

## Notes

The no-regex legacy baseline now reports 1767 findings. Remaining old regex usage is intentionally left for separate small passes.
