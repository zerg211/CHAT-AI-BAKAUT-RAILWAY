# First 100 source cards pilot evidence

Status: PASS for the finite source-field pilot. This is not a product-suitability verdict or a production search change.

The catalog's current `/health` reported 4,324 cards and revision `be94be56c60567e683082be462d3981f19d9eba11e7775021bcdbf212061f070`. The local source database with that revision provided the first 100 products in `source` order. They run from `00-00000273` to `026119`.

`catalog-service/source_fields.py` read each source JSON and compared its file hash, product identity and full object with that database. It inserted one product at a time, read back every field, and committed before moving to the next product. The output is `C:\Users\ozon001\Documents\Codex\2026-10-21\task\kb_index_20261103\first100_source_fields.sqlite`.

An independent readback checked all 100 saved source files, all 4,335 field values and all 4,335 search rows against the JSON. It found zero mismatches. The index is 3,743,744 bytes; SHA-256 `F5DC3236939C37A99A343B4DEA17F4C98713C6A46EE550F7B4C07E5CF7D2BA00`. It retains 37 document links across 20 cards. `python -m py_compile` and `git diff --check` passed.

Only five of the 100 cards have a separately named application or purpose field. All 100 have a description. Indexing only application fields would silently lose possible evidence from 95 cards; this pilot preserves those descriptions in full.

AC1 PASS: exactly the first 100 current-revision source cards, with matching hashes and identities.

AC2 PASS: each card's transaction and readback finished before the next card started.

AC3 PASS: all original scalar fields and the full JSON were preserved. The independent audit found zero mismatches.

AC4 PASS for the pilot boundary: the index copies source statements and assigns no question-specific suitability labels. The production bot still reads full source cards. Future integration must keep a full-card fallback and verify missing decisive facts with manufacturer sources.

AC5 PASS: the pilot is not wired to the production selector or widget. No production behavior changed.

The links to 37 documents were preserved, but the document contents and the truth of every source statement were not checked. Those remain source-verification work when a buyer question needs them. A missing indexed term must not be used to reject a product.
