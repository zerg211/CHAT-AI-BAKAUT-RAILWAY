# Generator Selection Blocked Eval Contract

## Problem

Production Promptfoo on `c6a4472` returned `5/6` while both averages remained above 90%:

- deterministic average: `0.9074444444444444`;
- LLM average: `0.9483333333333333`.

The failing case was `generator_load_selection`. The assistant correctly refused to show generator cards because the pump power/model was still unknown, but deterministic assertions required catalog/selectProducts and visible cards.

## Current Behavior

The eval already has `allowNoSuitableProductOutcome`, but it only accepts blocked no-card outcomes after a catalog/search attempt. It does not accept a structured `needs_more_info` outcome where the LLM planner safely avoids catalog search because the critical load basis is missing.

## Structural Improvement

Extend the eval-only contract so `allowNoSuitableProductOutcome` also accepts structured generator selection blocks when:

- latest product class is `generator`;
- no product cards are visible;
- selection readiness blocks cards or marks `needs_more_info`;
- missing facts/answer/risk flags identify pump power/model as the blocker.

This changes eval interpretation, not production assistant behavior.

## Acceptance Criteria

- AC1: `assertRetrievalGrounding` accepts this structured blocked generator-selection outcome when opt-in is set.
- AC2: `assertToolCallCorrectness` accepts missing catalog/search only for this opt-in blocked outcome.
- AC3: `assertAgentTaskCompletion` accepts missing `product_selection` task type only for this opt-in blocked outcome.
- AC4: Existing no-suitable-product negative test still fails without opt-in.
- AC5: No new regex constructs are added.
- AC6: Local non-OpenAI gates pass.
- AC7: After commit/push/Railway, production Promptfoo returns `6/6` and both averages stay above 90%.
