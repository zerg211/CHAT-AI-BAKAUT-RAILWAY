# Task: catalog presence relevance

## Problem

After exact-model research, the post-answer rewrite can append "У нас эта модель есть в каталоге" whenever `catalogPresence.status="present"`. This is wrong for a pure technical question such as start method: the buyer did not ask whether the model is in the catalog, so the sentence is noise.

## Acceptance Criteria

AC1. A present catalog line must not be appended automatically to pure exact-model technical answers.

AC2. Catalog presence may still be mentioned when the planner marks catalog presence as relevant to the buyer's current request, such as "есть у вас", catalog/order/price intent, or catalog alternatives.

AC3. The approved style example must not teach the model to always append catalog presence in technical answers.

AC4. Tests must cover both cases: pure technical answer omits present catalog line; explicit presence question keeps it.

AC5. No regex patch is added for this behavior.
