# Hybrid semantic selection evidence

Status: production widget check pending; completion is not claimed.

## Baseline from the actual site widget
- Question: «Подберите, пожалуйста, недорогую виброплиту для укладки тротуарной плитки.»
- Buyer-visible answer: 136.001 seconds after send.
- First semantic selection: HTTP 504 after about 61 seconds. Second selection: about 52 seconds.
- Category candidates: 284; confirmed by the old classifier: 165; uncertain: 112; rejected: 7.

## Index audit before implementation
- Full 4324-card ranking verified via the production MCP tool.
- The relevant category had 284 cards; 170 raw cards contained «плитк» or «брусчат».
- A score cutoff of 0.50 would retain 128 plates but omit 97 of those 170 directly mentioning tiles or pavers. Therefore similarity is used for review priority, never for rejection.

## Offline checks on current patch
- `python -m py_compile catalog-service/server.py catalog-service/semantic_selector.py`: PASS.
- `git diff --check`: PASS.
- Inline complete-selection check: four category products accounted for; low-scoring direct evidence was still fully reviewed; PASS.
- GitHub offline code and oracle checks for PR 89: PASS.

## Pending
- Verify the deployed catalog SHA and embedding readiness.
- Ask the same question through the site widget, measure buyer-visible time and inspect the first ten cards.
- Mark AC1–AC5 only after the live result is known.
