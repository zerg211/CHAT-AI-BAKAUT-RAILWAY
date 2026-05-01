# Explicit 1+1 card cap persistence

## Root cause
- The explicit request "one main + one backup" was applied only to the current user message.
- Follow-up turns like "why this one?" or "budget matters" no longer contained the explicit cap phrase, so selection fell back to the default broad visible slice (4/7 cards) even though the buyer's original display contract was still active.
- Hidden alternatives existed under "Показать еще", but the visible card count was not kept at 2 across the same buying thread.

## Plan
1. Reuse the existing explicit-card-limit parser across recent conversation history, not only the current message.
2. Apply the effective limit to both structured catalog slices and final product cards.
3. Add/adjust tests so initial 1+1 keeps 2 visible cards while hidden matches remain available under show-more.
4. Re-run targeted tests, typecheck, build, diff-check, then repeat the 6-7 turn buyer dialogue.
