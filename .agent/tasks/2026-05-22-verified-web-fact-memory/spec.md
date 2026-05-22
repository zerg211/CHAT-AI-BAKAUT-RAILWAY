# Task: verified web fact memory

## Problem

When `web.researchProductFacts` finds and uses an external fact, the fact is stored only in the current turn artifacts and answer contract. The next dialogue has to rediscover the same fact through web search, which wastes API/web-search budget and can regress into a weaker answer.

## Acceptance Criteria

- AC1: Successful exact-product web research persists high/medium confidence web facts as structured reusable product facts with source URL/title/evidence and verification timestamp.
- AC2: Persisted facts are keyed by normalized product/model identity and can also link to a catalog `product_id` when the product exists in the BAKAUT catalog.
- AC3: Before running external web research for an exact product, the agent checks the verified local facts and uses them as evidence when they cover the requested attributes.
- AC4: The fix is semantic/structural, not a phrase regex or one-model special case. It must work for any model/fact returned by the research tool.
- AC5: Catalog facts are not overwritten by web facts; conflicts remain auditable through existing data quality/conflict paths.
- AC6: Tests cover both persistence after web research and reuse before a repeat web research call.
- AC7: Focused tests, typecheck, and no-regex checks pass.
- AC8: Changes are committed/pushed; after Railway deploy marker updates, run a live widget check on `bakautprof.ru` and save the protocol.
