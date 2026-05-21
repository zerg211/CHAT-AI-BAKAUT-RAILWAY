# Problems After First Production Run

## Production run after `e07a67d`

Promptfoo exited non-zero, but the score gates were already green:

- deterministic average: `0.9063333333333333`
- LLM average: `0.9466666666666667`
- LLM status: `ready`

The failing rows were LLM grader transport failures, not deterministic behavior failures:

- `generator_load_selection`: production LLM grader HTTP 500
- `plate_retrieval_grounding`: production LLM grader HTTP 500
- `context_shift_agent_completion`: production LLM grader HTTP 500

Inspection showed the failing rows had very large Promptfoo output payloads because full turn metadata included complete product descriptions and tool artifacts. The production judge endpoint accepts bounded prompt sizes, so large `<Output>` payloads can fail before judging.

## Smallest safe fix

Compact the Promptfoo `<Output>` inside `production-llm-grader-provider.cjs` before sending it to the production admin judge:

- preserve user turns, assistant answers, visible product cards, key tool requests/results, warnings, and readiness contracts;
- remove oversized product descriptions and bulky metadata;
- keep deterministic assertions on the full raw output unchanged;
- keep LLM scoring semantics unchanged.
