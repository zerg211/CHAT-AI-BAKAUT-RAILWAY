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

```text
GET https://chat-ai-production-3057.up.railway.app/api/admin/embedding-coverage
Authorization: Bearer <production ADMIN_PASSWORD>
finalReady=true
products total=4325 embedded=4325 usable=3999 coverage=0.9246242774566474 ready=true
catalog_pages total=102 embedded=102 usable=102 coverage=1 ready=true
troubleshooting_cases total=0 embedded=0 usable=0 coverage=0 ready=false
```

```text
git commit -m "Batch embedding backfill requests"
commit 2a5a88a
git push origin codex/llm-commercial-lead-form
git push origin codex/llm-commercial-lead-form:main
Railway deployment succeeded before production backfill/live gate continuation.
```

```text
git commit -m "Treat equivalent runtime tools as policy gate success"
commit a3ac796
git push origin codex/llm-commercial-lead-form
git push origin codex/llm-commercial-lead-form:main
```

```text
git commit -m "Avoid commercial handoff recovery timeouts"
commit df7fa7d
git push origin codex/llm-commercial-lead-form
git push origin codex/llm-commercial-lead-form:main
Railway deployment 9089ccc6-583e-45dc-9ab8-b6a80eb929c2 status=SUCCESS
```

```text
npm test -- tests/assistantFallback.test.ts tests/remediationCommercialFallback.test.ts tests/assistantControlPlaneGenerate.test.ts tests/policyGate.test.ts
Test Files 4 passed (4)
Tests 43 passed (43)
```

```text
npm run typecheck
PASS
```

```text
npm run build
PASS
```

```text
git commit -m "Handle mixed catalog commercial fast path"
commit e7ec987
git push origin codex/llm-commercial-lead-form
git push origin codex/llm-commercial-lead-form:main
Railway deployment f4de5131-9f06-4b90-b6a6-649524868673 status=SUCCESS
```

```text
GET https://chat-ai-production-3057.up.railway.app/api/health
ok=true
contractVersion=2026-05-19-generator-load-scenarios-recovery-v38
```

```text
node tests/liveAgentCycle.diverse.production.mjs
product_selection: buyer ok; cards=0; buyer=llm
clarify_load_and_next_step: buyer ok; cards=7; buyer=llm
clarify_generator_choice: buyer ok; cards=7; buyer=llm
request_plate_catalog: buyer ok; cards=7; buyer=fallback_guarded_llm
leave_contact_for_availability_delivery: buyer ok; cards=0; buyer=llm
DONE diverse production audit. Buyer issues=0; code issues=0; protocol=local-live-tests\2026-05-19-production-diverse-buyer-audit-2026-05-19T21-09-08-673Z.production.md
```
