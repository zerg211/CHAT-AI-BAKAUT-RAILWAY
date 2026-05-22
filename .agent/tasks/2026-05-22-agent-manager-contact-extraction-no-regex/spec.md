# Task: agent manager contact extraction no regex

## Current behavior

`AgentManagerOrchestrator` contains local deterministic contact parsing for `lead.capture`: it normalizes whitespace, extracts email, phone, and a simple buyer name from the current user turn. The parsing is private to the oversized orchestrator and currently uses regex.

## Structural improvement

Extract this deterministic parsing into `src/ai/contactExtraction.ts` and replace regex usage with explicit character scanners. This reduces `AgentManagerOrchestrator` size and moves a reusable deterministic boundary out of the agent loop while preserving public APIs and buyer-visible behavior.

This is not an LLM semantic decision. Contact extraction is a deterministic safety/business operation: the LLM may decide when lead capture is appropriate, while code validates whether a usable contact was actually present.

## Acceptance Criteria

AC1. No regex constructs are added.

AC2. `AgentManagerOrchestrator` imports contact extraction from the new module and no longer owns the contact parser implementation.

AC3. The new parser preserves expected extraction for email, phone, explicit name phrases, and prefix-name-before-contact cases.

AC4. Focused tests cover the extracted parser without adding regex to tests.

AC5. `npm run lint:no-regex` passes after updating the reviewed legacy baseline downward.

AC6. Focused tests, typecheck, full tests, build, and diff check pass.

AC7. No production behavior eval is required for this pass unless local tests or code review show a behavior-impacting change beyond deterministic parser parity.
