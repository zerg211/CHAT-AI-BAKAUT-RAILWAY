# Hybrid semantic selection evidence

Status: embedding connection verified in production. The wider goal of a fast, fully confirmed buyer list remains open.

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

## Live widget after deployment
- PR 89 was merged as `03ad966903dd4a12132b347043e8976789f3b35c`; both Railway chat and catalog services reported that commit as the active deployment. Catalog `/health` reported 4324 cards and `embedding_status=ready` with 4324 embedded cards.
- Asked the exact baseline question in a new chat on `https://bakautprof.ru/`. The widget showed the answer and `10 из 276` with `Показать ещё 10`.
- Buyer-visible render time was 51,868 ms, down from 136,001 ms (2.62 times faster). There was one successful semantic tool call and no MCP timeout.
- Tool output: 284 category candidates, 144 confirmed, 132 uncertain, 8 rejected; full-card second review for 82; query embedding input 18 tokens. The selector took 25,437.78 ms and used 168,969 input tokens, compared with 45,916.95 ms and 257,522 input tokens in the old successful selector call.
- Audited the first ten widget cards against their source JSON. All ten contain direct references to tile/paver work or a related protective mat. Several need an optional mat, which was not explained in the short buyer-facing answer.
- The old and new selectors agreed on 139 confirmed products; 26 old confirmed moved to uncertain, 5 old uncertain moved to confirmed, and one old uncertain became rejected. Because the old classification itself was not a verified gold standard, these transitions do not prove a regression or improvement in correctness. Their source text needs further audit.

## Acceptance verdict
- AC1 PASS: the live tool reported query embedding use and retained category/source-word review.
- AC2 PASS: 144 + 132 + 8 = 284, with no similarity-based rejection.
- AC3 PASS: the widget had the saved 276-card result and revealed ten with the existing button; no new search is performed by that button.
- AC4 PASS for the specified baseline: 51.868 s < 136.001 s, no tool timeout, first ten source cards audited.
- AC5 PASS: this record and evidence.json contain the observed result and limitations.

## Practical limit
The result is still too broad to call a precise complete recommendation: 132 of 276 visible cards are uncertain and the full customer-visible answer took nearly 52 seconds. Embedding ranking helped avoid one costly repeat and reduced the deep review, but it did not turn whole-card vectors into verified product-use facts. See problems.md.
