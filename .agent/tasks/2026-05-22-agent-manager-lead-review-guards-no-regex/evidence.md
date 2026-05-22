# Evidence: agent manager lead review guards no regex

## Structural Change

- Extracted deterministic lead review helpers from `AgentManagerOrchestrator` into `src/ai/leadReviewGuards.ts`.
- Replaced two orchestrator regex operations with explicit text scanners:
  - repeated contact request detection after buyer already provided contact;
  - repeated contact request sentence stripping for mechanical rewrite.
- Kept the LLM/code boundary intact: the LLM decides whether a lead handoff is appropriate; deterministic code enforces business safety and local lead-capture facts.

## Local Checks

- `npx vitest run tests/leadReviewGuards.test.ts`: PASS, 4 tests.
- `npm run typecheck`: PASS.
- `npm run lint:no-regex`: PASS after reviewed baseline update.
- `npm test`: PASS, 80 files, 658 tests.
- `npm run build`: PASS.
- `git diff --check`: PASS, only CRLF conversion warnings from Git.

## No-Regex Baseline

- Previous legacy baseline: 1755.
- New legacy baseline: 1751.
- Removed legacy regex findings: 4.
- No new regex constructs were added.

## Acceptance Criteria

- AC1: PASS. No regex constructs were added.
- AC2: PASS. `AgentManagerOrchestrator` imports lead review guard helpers and no longer owns the removed helper bodies or regex stripping.
- AC3: PASS. Focused tests cover repeated contact request detection, sentence stripping, missing-contact/name classification, and missing-name repair text.
- AC4: PASS. Focused guard tests were added without regex assertions.
- AC5: PASS. `npm run lint:no-regex` passes with baseline reduced to 1751.
- AC6: PASS. Focused tests, typecheck, full tests, build, and diff check passed.
- AC7: PASS. No production eval required: this pass is deterministic private guard extraction with local parity tests and no product/answer-policy behavior change.
