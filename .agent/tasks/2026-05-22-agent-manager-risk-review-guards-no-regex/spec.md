# Task: agent manager risk review guards no regex

## Current behavior

`AgentManagerOrchestrator.review` has deterministic pre-send review checks for risk flags and tool warnings:

- source disagreement/adjudication flags block buyer-visible factual answers;
- unsupported/unverified/no-evidence/hallucination risk flags block buyer-visible factual answers.

The checks are private to the oversized orchestrator and currently use regex.

## Structural improvement

Extract this deterministic risk/warning classification into `src/ai/riskReviewGuards.ts` and replace regex use with explicit normalization and substring scanners. This keeps the LLM/code boundary clear: the model may set structured flags, while code enforces blocking policy from those flags.

## Acceptance Criteria

AC1. No regex constructs are added.

AC2. `AgentManagerOrchestrator` imports the risk review helpers and no longer owns regex-based risk/adjudication checks.

AC3. The helper preserves expected recognition for `high_risk_disagreement`, `needs_adjudication`, `requires-adjudication`, `source_conflict_unresolved`, `unresolved_conflict`, `unsupported`, `unverified`, `no_evidence`, and `hallucination`.

AC4. Focused tests cover the extracted helper without regex assertions.

AC5. `npm run lint:no-regex` passes after reviewed baseline reduction.

AC6. Focused tests, typecheck, full tests, build, and diff check pass.

AC7. No production eval is required unless this pass changes product/answer policy beyond deterministic guard parity.
