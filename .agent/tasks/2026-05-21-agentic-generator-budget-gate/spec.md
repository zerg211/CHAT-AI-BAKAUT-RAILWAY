# Agentic Generator Budget Gate Spec

## Current Behavior

Production Promptfoo after `86100ed` passes the deterministic average gate but still fails the LLM average gate.

- `generator_load_selection` asks for one more pump fact and shows no cards after the buyer explicitly asks for preliminary generator variants. The planner marks the request as a bounded assumption but leaves estimated pump/fridge load kW values null, so the calculator blocks catalog cards.
- `context_shift_agent_completion` can still include an over-budget plate card because the current budget parser accepts `budget.max:` but the ledger may store the same structured fact as `budget: 70000`.
- The production LLM judge can return transient HTTP 500s, so grader retry coverage should be stronger.

## Structural Improvement

- Keep semantic generator sizing in the LLM planner: teach the planner to provide canonical load kinds and numeric `estimated_average` kW values when the buyer asks for preliminary variants and the context gives a defensible bounded basis.
- Keep deterministic code limited to structured fact execution: extend budget extraction to accept the existing `budget:` ledger shape without regex.
- Increase production LLM grader retry tolerance without changing scoring semantics.

No new regex constructs may be added.

## Acceptance Criteria

AC1. Structured budget extraction accepts both `budget.max:` and `budget:` facts and filters over-budget selected cards when an in-budget selected option exists.

AC2. Generator planner instructions require numeric bounded estimates and canonical load kinds for approximate generator selections while preserving exact unknown nameplate facts as missing facts.

AC3. Production LLM grader retries transient endpoint failures with a higher default attempt count.

AC4. Focused tests, full unit tests, `npm run lint:no-regex`, `npm run typecheck`, and `npm run build` pass locally.

AC5. After commit/push and Railway deploy, production Promptfoo passes with deterministic average and LLM average both above 90%.
