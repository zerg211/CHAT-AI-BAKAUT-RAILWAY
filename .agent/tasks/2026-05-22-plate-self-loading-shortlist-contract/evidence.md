# Evidence: plate self-loading shortlist contract

## Baseline Production Finding

- Commit: `f395d36`.
- Production Promptfoo/widget harness: FAIL, 5/6 passed.
- Deterministic average: 0.9756111111111112.
- LLM average: 0.8733333333333334.
- Failing case: `context_shift_agent_completion`.
- Bottleneck: the assistant switched context correctly and used in-budget plate cards, but the final shortlist treated a heavier in-budget option too much like an equal primary recommendation while lighter one-person transport candidates were available.

## Structural Change

- Added answer-model guidance for plate compactor selection with budget plus one-person/light/self-loading transport constraints.
- Added reviewer guidance to require rewrite when a heavier in-budget product is presented as an equal primary recommendation while lighter in-budget products are available.
- The change is a prompt/contract improvement. It does not add regex and does not add a phrase-specific code path.

## Local Checks

- `npx vitest run tests/agentManagerIntegrationSource.test.ts`: PASS, 10 tests.
- `npm run lint:no-regex`: PASS, legacy baseline 1767.
- `npm run typecheck`: PASS.
- `npm test`: PASS, 78 files, 650 tests.
- `npm run build`: PASS.
- `git diff --check`: PASS, only CRLF conversion warnings from Git.

## Acceptance Criteria

- AC1: PASS. No regex was added.
- AC2: PASS. Answer contract ranks plate shortlist by both budget and light/self-loading transport fit.
- AC3: PASS. Contract says heavier in-budget products must not be equal primary recommendations when two or more lighter in-budget products exist.
- AC4: PASS. Reviewer contract requires rewrite for that mismatch.
- AC5: PASS. Source guard asserts the new contract text.
- AC6: PASS. Local gates passed.
- AC7: PASS. Commit `37c33a0` reached Railway and production Promptfoo/widget harness passed.

## Production Eval After `37c33a0`

- `npm run evals -- --no-cache -j 1 -o .agent/tasks/2026-05-22-plate-self-loading-shortlist-contract/production-evals-after-37c33a0.json`: PASS.
- Pass/fail: 6/6.
- Deterministic average: 0.9918888888888889.
- LLM average: 0.955.
- Assertion pass rate: 33/33.
- `context_shift_agent_completion`: PASS, LLM score 0.96.
