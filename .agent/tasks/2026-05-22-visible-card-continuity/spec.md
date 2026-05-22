# Visible Card Continuity

## Problem

Production Promptfoo after `e2b9731` reached the score gates but still returned `5/6`. The remaining failure is `plate_retrieval_grounding`: the assistant answered the second plate turn well and referenced prior suitable models, but the second turn did not expose visible product cards even though the previous turn already had fitting plate cards and the answer contract said cards were ready.

## Current Behavior

`AgentManagerOrchestrator` builds visible cards only from products fetched by tools in the current turn. If the LLM answers a follow-up from conversation context without planning another catalog search, `products` is empty and no cards are shown, even when prior assistant metadata contains valid visible cards for the same product class.

## Structural Improvement

When current card readiness is `ready_for_cards`, the current selection has no products, and recent assistant history contains product cards matching the current product class, reuse those previous visible cards for continuity.

This is deterministic state reuse over existing metadata. It is not regex, keyword matching, or a canned answer rule. It does not create new products or change public APIs.

## Acceptance Criteria

- AC1: A follow-up turn that is ready for visible cards can reuse prior visible cards of the same product class when no current tools returned products.
- AC2: Reused cards are limited to matching product intent and keep card metadata stable.
- AC3: Generator safety remains unchanged; generator cards are not resurrected by this continuity pass.
- AC4: No regex is added.
- AC5: Local non-OpenAI gates pass.
- AC6: After push/Railway, production Promptfoo deterministic and LLM averages remain above 90%; target 6/6.
