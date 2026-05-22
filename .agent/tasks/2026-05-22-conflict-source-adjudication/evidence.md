# Evidence: conflict source adjudication

## Changes verified

- Exact catalog extraction no longer returns early from `researchProductComparisonFacts`.
- Exact-model research now sends catalog extraction into external research as evidence to verify/adjudicate.
- Source conflicts trigger deeper missing-fact retry unless the result is marked `source_conflict_adjudicated`.
- Web coverage with an external `sourceUrl` is validated against that external URL, not against the local catalog product just because the title/model matches.
- Tests cover catalog manual-only vs corroborated external electric/button start.

## Commands

```powershell
npx vitest run tests/productComparisonResearch.test.ts
```

Result: PASS, 8 tests.

```powershell
npx vitest run tests/productComparisonResearch.test.ts tests/agentManagerIntegrationSource.test.ts tests/agentManagerComparisonResearch.test.ts
```

Result: PASS, 3 files, 27 tests.

```powershell
npm run typecheck
```

Result: PASS.

```powershell
npm run lint:no-regex
```

Result: PASS, no new regex constructs.

## Production

```powershell
git push origin main
```

Result: PASS, commit `9d04038912ff356a714de0ab66cc6bc796541385` reached `origin/main`.

```powershell
Invoke-RestMethod https://chat-ai-production-3057.up.railway.app/api/health
```

Result: PASS, Railway marker showed runtime commit `9d04038912ff356a714de0ab66cc6bc796541385` on branch `main`.

## Live Widget

Protocol: `local-live-tests/2026-05-22-g7000is-source-adjudication-9d04038.production.md`

Buyer asked whether `SUNREKA G7000iS` needs the pull cord every time or starts by button.

Visible production widget answer:

> Кнопочный запуск подтвержден. Ручной запуск тоже есть. У нас SUNREKA G7000iS есть в каталоге.

Result: PASS for the repaired conflict path. Admin metadata was not available because no admin token was present in this shell.
