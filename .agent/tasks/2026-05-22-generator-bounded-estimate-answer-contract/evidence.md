# Evidence: generator bounded-estimate answer contract

## Change

Adjusted the Agent Manager contract for generator load estimates:
- `requiredResponseClausesForToolResults` now distinguishes rough/partial orientation from exact product selection when a generator load basis is incomplete.
- `estimateBasis=bounded_assumption` now adds a required clause forcing the answer to label kW values as preliminary and preserve missing exact facts.
- Answer and review prompts now tell the LLM/reviewer to avoid final, purchase-safe phrasing while still using a useful tool-calculated orientation.

No regex was added.

## Local Validation

- `npm test -- tests/agentManagerOrchestrator.test.ts`: PASS, 27 tests.
- `npm run lint:no-regex`: PASS, baseline remains 1767.
- `npm run typecheck`: PASS.
- `npm test`: PASS, 78 files and 647 tests.
- `npm run build`: PASS.
- `git diff --check`: PASS.

## Acceptance Criteria Status

- AC1: PASS. No new regex constructs.
- AC2: PASS. Orchestrator tests cover required response clauses for unconfirmed and bounded-assumption generator load profiles.
- AC3: PASS. Existing tests still assert unconfirmed generator load basis suppresses product cards.
- AC4: PASS. Local non-OpenAI gates passed.
- AC5: PASS. Production Promptfoo/widget harness passed after push and Railway deployment marker.

## Production Eval After `8890cdf`

- `npm run evals -- --no-cache -j 1 -o .agent/tasks/2026-05-22-generator-bounded-estimate-answer-contract/production-evals-after-8890cdf.json`: PASS.
- Pass/fail: 6/6.
- Deterministic average: 0.9914999999999999.
- LLM average: 0.9516666666666667.
- Assertion pass rate: 33/33.
- Gates: deterministic > 90% PASS, LLM average > 90% PASS.

Generator bottleneck result:
- `vague_generator_no_cards_before_load_profile`: PASS, LLM score 0.98, no cards.
- `generator_load_selection`: PASS, LLM score 0.93, 2 cards.

## Bottleneck Addressed

The failing production artifacts showed the LLM either over-blocked a useful estimate or stated `4 kW` too firmly. This pass keeps product card safety deterministic while making the LLM answer contract more precise: preliminary orientation is allowed and sometimes required, final selection remains blocked until exact pump/tool facts are known.
