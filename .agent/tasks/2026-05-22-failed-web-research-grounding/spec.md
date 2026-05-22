# Task: failed web research grounding

## Problem

In production conversation #1560 the exact-model web fact tool failed with `status="error"`, but the answer still used that failed tool request as the source for exact technical facts and stated that SUNREKA G7000iS has no button start. The pre-send review passed.

This is a grounding bug: a failed tool result is an executed artifact, but it is not evidence for a product fact.

## Acceptance Criteria

AC1. `factsUsed[].sourceEventIds` must not treat a non-`ok` tool result as a valid fact source.

AC2. If exact-model `web.researchProductFacts` fails, the final answer must not make a categorical exact technical claim from that failed research.

AC3. The repair text must stay buyer-facing and simple, and must not add catalog-presence noise when the buyer asked only a technical question.

AC4. Exact-target web research should be less likely to fail JSON parsing because of too-small output limits; use a scoped output budget increase, not a phrase-specific fix.

AC5. Add focused tests for failed web research being incorrectly used as fact evidence.

AC6. Run focused tests, typecheck, and no-regex guard.

AC7. After commit/push/Railway marker, run one production widget check through `https://bakautprof.ru/`.
