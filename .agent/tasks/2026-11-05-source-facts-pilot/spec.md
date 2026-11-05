# First 100 source cards pilot

## Goal

Try a finite, question-independent index on the first 100 products in the catalog's existing `source` order. A card is complete for this pilot when every value from its source JSON is preserved with its field path, the source file and identity match the current 4,324-product catalog, and the index can be read back. This does not claim that the card answers every future question or that every source statement is true.

## Data shape

One product row stores the exact original JSON, source path, source hash and order. Each scalar JSON value has one field row with its JSON pointer and original JSON value. Search text is derived from these field rows. The original card remains the source of truth. An index miss never proves that a product cannot perform a task.

## Acceptance criteria

- AC1: The pilot selects exactly the first 100 products by `ORDER BY source` from the 4,324-product catalog. Each source file exists and matches the catalog hash and identity.
- AC2: Products are processed one at a time. The next product starts only after the previous product's complete field coverage and readback pass.
- AC3: Every scalar value and the full source JSON are preserved. The report lists product count, field count, order boundaries and coverage failures.
- AC4: No product-use labels are invented from category, weight or accessories. Question-specific suitability remains a later decision based on source facts; missing index evidence falls back to the original card and, when needed, manufacturer material.
- AC5: The pilot does not change the production bot or widget. It is not described as a verified suitability search until a query-time selector is built and checked on the live site.
