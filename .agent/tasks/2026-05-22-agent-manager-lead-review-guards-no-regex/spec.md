# Task: agent manager lead review guards no regex

## Current behavior

`AgentManagerOrchestrator.review` has deterministic lead/contact safeguards:

- if the current buyer message already contains phone/email, the pre-send review flags answers that ask the buyer to leave phone, number, contact, or name again;
- when mechanical issues require rewrite, the fallback rewrite removes the repeated contact request sentence;
- lead capture missing-contact/missing-name repair text is implemented inside the oversized orchestrator.

This logic is a deterministic business guard, not an LLM semantic decision: the LLM may decide the handoff policy, while code prevents an unsafe or repetitive contact request from being sent.

## Structural improvement

Extract these lead review helpers into `src/ai/leadReviewGuards.ts` and replace regex usage with explicit text scanners. Keep public APIs stable and preserve existing buyer-visible behavior.

## Acceptance Criteria

AC1. No regex constructs are added.

AC2. `AgentManagerOrchestrator` no longer owns lead missing-contact/missing-name repair helpers or contact-request text stripping.

AC3. The new guard module preserves the core behavior: detects repeated contact requests after contact is already present, strips a repeated contact request sentence, and returns the same missing-name/missing-contact repair text.

AC4. Focused tests cover the extracted guard module without regex assertions.

AC5. `npm run lint:no-regex` passes after reviewed baseline reduction.

AC6. Focused tests, typecheck, full tests, build, and diff check pass.

AC7. No production eval is required unless this pass changes product/answer policy beyond deterministic guard parity.
