# Missing Catalog External Facts

## Objective

When a buyer asks a factual technical question about a named model that is not present in the BAKAUT catalog, the assistant should still answer the direct question from verified external facts when available, clearly say that the exact model is absent from the BAKAUT catalog, and optionally mention genuinely nearby catalog models without turning the answer into a sales script.

## Acceptance Criteria

- AC1: For a specific model absent from local catalog, the agent-manager tool path performs an exact external fact lookup instead of researching only unrelated catalog matches.
- AC2: The final answer answers the buyer's direct technical question in simple language when an external fact is found.
- AC3: The final answer distinguishes external product facts from BAKAUT catalog presence and says the exact model is not in the catalog.
- AC4: Nearby catalog suggestions are semantic: same brand plus same product class/model family first; if none exist, comparable same-class products may be mentioned. The fix must not be hardcoded for `RD8910E` or implemented as phrase/regex response templates.
- AC5: The answer must not introduce availability, delivery, price, manager handoff, or lead capture unless the buyer asked for commercial terms or the fact cannot be answered.
- AC6: Add regression coverage proving the missing-catalog/external-fact behavior for a FIRMAN-like absent model with nearby same-brand catalog models.

## Non-Goals

- Do not change lead capture policy globally.
- Do not add one-off canned answers for FIRMAN/RD8910E.
- Do not require product cards for this informational turn.

