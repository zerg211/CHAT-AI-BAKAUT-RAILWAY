# Evidence

## Implementation

- Replaced the `agentHarness=1` regex fallback in `agentManagerRuntime.ts` with structured `URL` parsing using a local base URL.
- Preserved the runtime decision public API and metadata shape.
- Added tests for absolute production URLs, relative URLs, bare query strings, and similar non-matching values.
- Updated the no-regex baseline after reviewing removal of two legacy regex findings.

## Local Verification

- `npm test -- tests/agentManagerRuntime.test.ts` - PASS, 6 tests.
- `npm run lint:no-regex` - PASS, legacy baseline is now 1804.
- `npm run typecheck` - PASS.
- `git diff --check` - PASS, CRLF warnings only.
- `npm test` - PASS, 76 files / 614 tests.
- `npm run build` - PASS.

## Acceptance Criteria Status

- AC1: PASS.
- AC2: PASS.
- AC3: PASS.
- AC4: PASS.
- AC5: PASS.
- AC6: PASS.
