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

```text
git commit -m "Finalize embedding retrieval monitoring"
commit eae0157
```

```text
git push origin codex/llm-commercial-lead-form
PASS
```

```text
GET https://chat-ai-production-3057.up.railway.app/api/admin/embedding-coverage
Initial post-push polling: 404 Route not found.
Later recheck: 401 Unauthorized with available local ADMIN_PASSWORD/ADMIN_API_KEY.
Conclusion: route is deployed/reachable, but current local admin secret does not match production.
```
