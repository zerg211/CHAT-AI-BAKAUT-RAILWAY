# Visible Card Constraint Consistency Evidence

## Scope

This pass fixes production card/text consistency failures without adding regex or prompt-only patches.

Current behavior before the pass:
- Generator selection could answer that no option fits the structured budget while still showing an over-budget visible card.
- Plate selection could mention a heavy model only as a caveat and still render that out-of-range model as the visible card.

Structural improvement:
- Visible generator cards are suppressed when every same-intent candidate is over the structured budget.
- Visible plate cards fall back to same-intent products inside the semantic weight range inferred from LLM/tool context.

## Baseline Production Failure

Source run: production Promptfoo after `39e07e8`.

- Result: `4/6`
- Deterministic average: `0.9708888888888888`
- LLM average: `0.8300000000000001`

Failures:
- `generator_load_selection`: LLM score `0.58`; answer said no suitable option under 90k but visible card was over budget.
- `plate_retrieval_grounding`: LLM score `0.68`; answer preferred 56-70 kg range but visible card was 88 kg.

## Local Checks

- `npm test -- tests/agentManagerCardSelection.test.ts`: PASS, `16 passed`.
- `npm run lint:no-regex`: PASS, no new regex constructs, legacy baseline `1782`.
- `git diff --check`: PASS, warnings only for LF-to-CRLF normalization.
- `npm run typecheck`: PASS.
- `npm test`: PASS, `77 passed`, `637 passed`.
- `npm run build`: PASS.

## Production Promptfoo After Push

Commit: `64f0ac0fd8ecc9f33d162c63b4ef798e343829f2`

Railway marker:
- `13:23:13 commit=64f0ac0fd8ecc9f33d162c63b4ef798e343829f2`

Production eval command:
- `PROMPTFOO_CHAT_BASE_URL=https://chat-ai-production-3057.up.railway.app`
- `PROMPTFOO_CHAT_PAGE_URL=https://bakautprof.ru/?agentHarness=1`
- `npm run evals -- --no-cache -j 1 -o .agent/tasks/2026-05-22-visible-card-constraint-consistency/production-evals-after-64f0ac0.json`

Result:
- Passed: `6/6`
- Deterministic average: `0.9925555555555556`
- LLM average: `0.96`
- Assertion pass rate: `33/33`

Raw artifacts:
- `production-evals-after-64f0ac0.json`
- `production-evals-after-64f0ac0.summary.json`

## Acceptance Criteria

- AC1: PASS locally. Added unit coverage for suppressing generator cards when all same-intent candidates exceed structured budget.
- AC2: PASS locally. Added unit coverage for preferring in-range plate cards over an out-of-range answer-mentioned caveat.
- AC3: PASS locally. Existing card selection, generator load safety, full unit suite, typecheck and build pass.
- AC4: PASS locally. `npm run lint:no-regex` reports no new regex constructs.
- AC5: PASS locally. Non-OpenAI gates pass.
- AC6: PASS. Production Promptfoo returned `6/6`, deterministic average `0.9925555555555556`, LLM average `0.96`.
