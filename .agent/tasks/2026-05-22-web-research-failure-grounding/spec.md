# Web Research Failure Grounding

## Problem

Production Promptfoo after `0b896df` improved to 5/6, but `web_required_technical_grounding` kept LLM average below 90%. The failed turn planned `web.researchProductFacts`, the tool returned `status="error"`, and the final answer still sounded as if facts had been checked. That is a grounding defect: the assistant must separate a general engineering explanation from verified/current facts whenever the requested web check fails.

## Current Behavior

When `web.researchProductFacts` fails, `requiredResponseClausesForToolResults()` produces no clause for the answer model. The answer LLM sees the failed tool result but is not explicitly required to state that the fact check did not complete, so it may overstate verification.

## Structural Improvement

Add a generic required response clause for non-ok `web.researchProductFacts` results. The clause tells the answer LLM that the requested external check did not complete, so it may answer only at the truthful general level and must not claim checked/verified facts from that failed tool. This keeps the semantic answer in the LLM while deterministic code only transports tool status and grounding constraints.

## Acceptance Criteria

- AC1: Non-ok `web.researchProductFacts` results create a required response clause with a stable code.
- AC2: The answer prompt explicitly treats the clause as required semantic content and forbids claiming checked/verified web facts from failed research.
- AC3: Tests cover the new clause without adding regex.
- AC4: `npm run lint:no-regex`, targeted tests, typecheck, full tests, and build pass locally.
- AC5: Commit, push, Railway marker, and production Promptfoo prove overall score and LLM average are above 90%.
