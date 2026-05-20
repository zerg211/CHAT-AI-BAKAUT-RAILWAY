# LLM + Embedding Intent Finalization

## Objective

Make the retrieval path behave as an AI manager instead of a stale-state catalog matcher: LLM owns the current buyer intent, product-class focus, and card policy; embeddings provide candidate discovery only after that intent is structured; deterministic code validates facts, filters catalog constraints, and blocks unsafe business claims.

The change must directly address the failure pattern from Dialog #1064: a generator consultation followed by a new plate-compactor question must not keep generator constraints or show generator cards.

## Scope

- Finalize the integration between LLM semantic understanding and embedding retrieval inside the current chat orchestration.
- Remove or bypass deterministic answer paths that write technical orientation text where an LLM answer is available.
- Prevent stale product intent, power constraints, exact model tokens, fuel, phase, and other product-specific filters from leaking into a new product-class focus.
- Preserve deterministic checks for catalog facts, hard business restrictions, safety, ranking, and answer/card consistency.
- Add trace/evidence fields that make the LLM intent, embedding query, merged candidate pool, and final card policy auditable.

## Non-Goals

- Do not add another retrieval mechanism outside the current repository/vector search stack.
- Do not remove embeddings, coverage, backfill, or admin monitoring.
- Do not hardcode a special case only for the exact Dialog #1064 wording.
- Do not manually deploy Railway.

## Acceptance Criteria

### AC1: LLM Owns Retrieval Intent

For catalog/product turns, selection must be driven by the structured LLM turn contract or LLM need extraction: product class, active focus, card policy, and whether the current turn continues or switches the prior task. Keyword/regex helpers may enrich or validate but must not override a confident LLM current focus.

### AC2: Embeddings Are Intent-Scoped

Embedding/vector search must receive an intent-scoped query built from the LLM-understood current focus and explicit requirements. It must not search from stale prior-product constraints when the current turn switches product class.

### AC3: Stale Constraints Are Cleared On Focus Switch

When LLM/current turn selects a new product class, product-specific constraints from the old class are cleared before retrieval and ranking. Generator power/fuel/phase constraints must not affect plate-compactor retrieval; plate weight/soil/application constraints must not affect generator retrieval.

### AC4: Card-Class Guard

If the final LLM/current turn focus and card policy require product cards, product cards must match the selected product class or be withheld with a trace warning. A plate-compactor question must not display generator cards.

### AC5: No Deterministic Technical Writer For Normal LLM Path

The first assistant answer for an ordinary technical orientation must not come from `fast_technical_orientation`/`deterministicTechnicalSummaryRecovery` when the LLM path is available. Hardcoded phrases like "Без звонка, продолжаем по технике." and default uncomputed generator sizing such as "5-6 кВт" must not be emitted as the primary answer path.

### AC6: Calculations Are Tools, Not Final Writers

Generator load calculation may remain deterministic as a calculator/tool result, but final customer wording must remain LLM-owned or verifier-approved. Repair code may correct unsafe numeric contradictions, but it must not replace a valid LLM answer with a canned full answer unless the trace marks an emergency fallback.

### AC7: Tests Cover Dialog #1064 Failure Pattern

Automated tests must prove:
- initial generator question does not use `fast_technical_orientation` canned wording;
- pump power update keeps a calculation trace without stale/default 5-6 kW wording;
- "Еще нужна виброплита..." switches focus to plate and does not produce generator cards;
- explicit plate catalog request returns plate-class constraints/cards.

### AC8: Existing Embedding Infrastructure Remains Green

Existing embedding coverage endpoint/script, backfill, vector safety, and retrieval tests remain green.

### AC9: Evidence And Finality

Create `evidence.md`, `evidence.json`, and raw artifacts under this task directory. Mark final only when local checks pass and production live widget verification through `https://bakautprof.ru/` passes after GitHub push/Railway deploy. If production credentials, deploy marker, OpenAI budget, or live widget access blocks this, record the blocker and do not claim final.

## Expected Result

After this task, embeddings and LLM work as a single retrieval pipeline:

1. LLM reads the latest buyer turn and dialogue state.
2. LLM outputs structured current focus and retrieval/card policy.
3. Code builds an intent-scoped embedding/text query from that structure.
4. Repository returns semantic and text candidates.
5. Code clears stale constraints, filters/ranks candidates by verified facts, and blocks wrong-class cards.
6. LLM writes the answer using the verified candidate pool and calculator/tool observations.
7. Post-answer verification enforces business limits and answer/card consistency.

Current status at spec freeze: not final. Implementation, tests, push, deploy check, and live evidence are still required.
