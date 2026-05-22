# Task: conflict source adjudication for decision-blocking product facts

## Problem

When a buyer asks about an exact model and an important technical fact, the research pipeline can treat the BAKAUT catalog extraction as a final answer. If the catalog field is incomplete or wrong, the bot may say that a feature is absent even when manufacturer and other exact-model sources confirm it.

This fails the sales goal: the buyer's decision-blocking need remains unresolved.

## Acceptance Criteria

AC1. Exact-model research must not stop at catalog-only extraction when the question is routed to `web.researchProductFacts`; the catalog is evidence, not a final arbiter for a decision-blocking technical fact.

AC2. If catalog evidence conflicts with exact-target external evidence, the model prompt must require deeper adjudication: search for additional exact-target sources and resolve toward the better-supported value when corroborated.

AC3. The retry/search instructions must not preserve catalog by default when web has not yet refuted it; they must explicitly handle conflict by source corroboration.

AC4. Tests must cover a catalog-vs-external conflict where catalog says manual-only but external exact-target sources corroborate electric/button start, and the final answer uses the corroborated external fact.

AC5. The fix must be structural pipeline logic, not a hard-coded phrase fix for G7000iS.

AC6. Evidence must include focused automated test output and a short current-code verification note.
