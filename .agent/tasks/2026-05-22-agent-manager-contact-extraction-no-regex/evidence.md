# Evidence: agent manager contact extraction no regex

## Structural Change

- Extracted deterministic lead contact parsing from `AgentManagerOrchestrator` into `src/ai/contactExtraction.ts`.
- Replaced the orchestrator-local regex parser with explicit character scanners for whitespace normalization, email, phone, explicit-name phrases, and prefix-name-before-contact extraction.
- Kept the LLM/code boundary intact: the LLM decides whether lead capture is appropriate; deterministic code only validates whether contact data exists.

## Local Checks

- `npx vitest run tests/contactExtraction.test.ts`: PASS, 4 tests.
- `npm run typecheck`: PASS.
- `npm run lint:no-regex`: PASS after reviewed baseline update.
- `npm test`: PASS, 79 files, 654 tests.
- `npm run build`: PASS.
- `git diff --check`: PASS, only CRLF conversion warnings from Git.

## No-Regex Baseline

- Previous legacy baseline: 1767.
- New legacy baseline: 1755.
- Removed legacy regex findings: 12.
- No new regex constructs were added.

## Acceptance Criteria

- AC1: PASS. No regex constructs were added.
- AC2: PASS. `AgentManagerOrchestrator` imports `extractContact` and `hasLeadContact` from `src/ai/contactExtraction.ts`.
- AC3: PASS. Focused tests cover email, phone, explicit name, prefix name, absent contact, and email punctuation cases.
- AC4: PASS. Focused parser tests were added without regex assertions.
- AC5: PASS. `npm run lint:no-regex` passes with baseline reduced to 1755.
- AC6: PASS. Focused tests, typecheck, full tests, build, and diff check passed.
- AC7: PASS. No production eval required: this pass is deterministic parser extraction with local parity tests and no product/answer policy change.
