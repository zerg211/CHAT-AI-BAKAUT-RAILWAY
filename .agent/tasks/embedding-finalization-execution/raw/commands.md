# Raw Command Log

```text
npm test -- tests/adminEmbeddingCoverage.test.ts tests/embeddingCoverageReport.test.ts tests/embeddingRetrieval.test.ts tests/conversationRepository.test.ts tests/migrate.test.ts tests/app.test.ts
Test Files  6 passed (6)
Tests  23 passed (23)
```

```text
npm run typecheck
PASS
```

```text
npm test
Test Files  47 passed (47)
Tests  455 passed (455)
```

```text
npm run migrate
Migrations completed
```

```text
npm run embeddings:coverage
finalReady=false
products coverage=0
catalog_pages coverage=0
troubleshooting_cases coverage=0
```

```text
npm run embeddings:backfill -- --dry-run --limit=50
products planned=50
catalogPages planned=50
```

```text
npm run build
PASS
```

```text
git diff --check
PASS with Git line-ending warnings only.
```
