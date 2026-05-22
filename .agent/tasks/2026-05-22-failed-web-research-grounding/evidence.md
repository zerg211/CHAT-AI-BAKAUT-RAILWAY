# Evidence: failed web research grounding

## Local checks

- `npx vitest run tests/agentManagerComparisonResearch.test.ts tests/agentManagerIntegrationSource.test.ts tests/productComparisonResearch.test.ts` - PASS, 29 tests.
- `npm run typecheck` - PASS.
- `npm run lint:no-regex` - PASS, no new regex constructs.
- `npm test` - PASS, 78 files, 649 tests.
- `npm run build` - PASS.

## Pre-fix production finding

- Production marker before the fix: `a81477de79833586faa54e9e1c47850be00f2314`.
- Live widget conversation: `#1560`, session `6ff743d9-1d1f-4258-abf4-59b956d2c5e3`.
- Buyer asked only a technical question about SUNREKA G7000iS start method.
- Catalog-presence noise was absent, but `web.researchProductFacts` failed with `status="error"` and the answer still cited request `web1` as evidence for exact start-method facts.

## Code evidence

- `answerEvidenceSourceHints` now exposes only `ok` tool results as fact source ids.
- `normalizeAnswerEvidenceSources` now trusts only ledger facts and `ok` tool results for `factsUsed`.
- Pre-send review now detects `failed_tool_result_used_as_fact_source`.
- If the failed source is exact web research, the final answer is rewritten to avoid a categorical exact technical claim from failed evidence.
- The rewrite is driven by structured tool status and cited source ids, not by regex or buyer-message keyword matching.
- Final answer metadata removes facts that cited failed tool results.
- Exact-target product comparison research now receives a scoped higher output budget to reduce JSON truncation/parse failures.

## Post-commit production finding before follow-up fix

- Production marker `5a8c28ce091e747c91688946931e3356ee901f0d` reached Railway.
- Live widget conversation `#1567`, session `5a95c3cf-6927-4090-9a8b-35bd34408f6c`.
- The web tool succeeded and confirmed button start, but final text combined confirmed guidance with stale catalog uncertainty: "Кнопочный запуск подтвержден... Кнопочный запуск в данных не вижу."
- Follow-up code fix added label-level coverage collapse: a confirmed start-control label suppresses older `not_found/not_confirmed/ambiguous` coverage for the same label.

## Final production verification

- Pushed commit: `8fbabd850e2ad3cf9500a937d6ccbf4bb63e4a29`.
- Railway marker reached `8fbabd850e2ad3cf9500a937d6ccbf4bb63e4a29`.
- Live widget conversation `#1574`, session `9e9d90ee-9695-4cf2-852d-ede0c02d6b37`.
- Protocol: `local-live-tests/2026-05-22-catalog-presence-relevance-2026-05-22T12-41-59-154Z.production.md`.
- Buyer-visible answer: "Да, кнопкой запускается: у SUNREKA G7000iS есть электростартер и запуск с кнопки START. При этом ручной запуск шнурком тоже предусмотрен, так что это не только шнурок."
- PASS: no unsolicited catalog-presence line.
- PASS: no failed web evidence was used as a fact source.
- PASS: no stale "кнопочный запуск в данных не вижу" uncertainty after confirmed button-start coverage.
