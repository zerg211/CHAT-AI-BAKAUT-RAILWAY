# Evidence: latest main production eval

## Production Eval On `9d04038`

- Railway marker: `9d04038912ff356a714de0ab66cc6bc796541385`.
- `npm run evals -- --no-cache -j 1 -o .agent/tasks/2026-05-22-latest-main-production-eval/production-evals-after-9d04038.json`: FAIL.
- Pass/fail: 5/6.
- Deterministic average: 0.9092777777777776.
- LLM average: 0.96.
- Deterministic and LLM averages were both above 90%, but one scenario failed hard assertions.

## Failed Scenario

- `web_required_technical_grounding`: failed because no `web.researchProductFacts` / web evidence was present.
- The answer quality was high by LLM score, but the planner answered from general knowledge after the buyer explicitly asked to check facts when catalog data is missing.

## Follow-Up

Follow-up fix task: `.agent/tasks/2026-05-22-web-required-general-technical-research/`.
