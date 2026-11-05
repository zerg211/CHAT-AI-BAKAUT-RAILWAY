# Hybrid semantic selection

## Goal
Reduce buyer-visible latency for general product-use questions while preserving every catalog item in the selection audit. Use the existing 4324-card embedding index as a retrieval signal, not as proof of suitability or a fixed top-K cutoff.

## Observed baseline
The paving-plate query in the live widget took 136.001 seconds. The first semantic_select_products call timed out after 61 seconds, the repeat took about 52 seconds, and the classifier considered all 284 plates. Direct ranking audit: among 170 plates whose raw cards mention tiles or paving blocks, a 0.50 score cutoff would lose 97; therefore a score-only shortlist is unacceptable.

## Acceptance criteria
- AC1: A meaning-based selection combines category, lexical evidence and the existing embedding ranking. Exact model and numeric-only paths stay separate.
- AC2: The semantic result accounts for every product in the applicable category. Unreviewed products are never silently marked unsuitable or suitable; they remain separate from confirmed matches.
- AC3: No fixed top-N truncation of suitable goods. The saved selection and widget can reveal all confirmed products by ten without new search.
- AC4: A production paving-plate question through the site widget completes without a tool timeout and faster than the 136-second baseline. The answer and first ten cards must be audited for suitability.
- AC5: Record the observed result and limitations in evidence.md/evidence.json. If AC4 fails, record the failure and do not claim completion.

## Design boundary
A whole-card embedding score cannot prove a product is suitable. It may only prioritize or broaden evidence retrieval. Direct card facts remain decisive; no arbitrary similarity cutoff may turn a possible product into a rejection.
