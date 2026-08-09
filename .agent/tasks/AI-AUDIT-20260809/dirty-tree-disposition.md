# Классификация исходного и финального незакоммиченного дерева

Снимок до аудита: ветка `main`, commit `9bc454c164869c7f1e2c91e2417a50e3ea10b769`. Удалённая точка отката: `origin/codex/backup-pre-audit-20260809`. Рабочая ветка: `codex/full-ai-audit-remediation-20260809`.

Этот документ различает три набора, которые нельзя смешивать:

1. исходные пользовательские dirty changes до аудита;
2. удалённый после проверки unsafe web-enrichment и временный `.scratch`;
3. текущий release-candidate diff, созданный уже в ходе исправления H1–H7/M1–M4.

## 1. Исходный inventory и решение

Ниже перечислен полный зафиксированный в начале задачи набор исходных dirty paths. Unsafe web-enrichment **не был готов к реальному использованию и не сохранён**: feature не достигалась production runtime, могла принять факт соседней модели, ошибочно выставить `complete`, частично записать snapshot и включить непроверенный внешний текст в embedding. Идея долговременной fact memory сохранена, но реализована заново через типизированный и provenance-safe путь.

### Исходные tracked paths

| Путь | Вердикт исходному hunk | Что произошло |
|---|---|---|
| `package.json` | DELETE unsafe enrichment hunk | Недостижимый production CLI и потенциально затратный default удалены. Текущий diff этого файла — отдельное dependency hardening, см. раздел 3. |
| `src/ai/agentManagerToolRegistry.ts` | DELETE unsafe enrichment hunk | Невалидируемый `z.record(unknown)` context удалён. Текущий diff — typed tool/recovery contract. |
| `src/ai/productComparisonResearch.ts` | DELETE unsafe enrichment hunk | Повторная подача непроверенного external prose удалена. Текущий diff — exact identity и deterministic source authority. |
| `src/catalog/normalize.ts` | DELETE unsafe enrichment hunk | Raw enrichment больше не сериализуется в основной embedding; файл вернулся к clean baseline и отсутствует в финальном dirty tree. |
| `src/db/migrate.ts` | DELETE unsafe enrichment hunk | Миграция недостижимой feature удалена. Текущий diff — безопасная declarative schema для проверенной fact-memory lifecycle. |
| `src/db/repositories.ts` | DELETE unsafe enrichment hunks | Неатомарный enrichment/facts путь удалён. Текущий diff — транзакционная catalog snapshot/fact memory и session/turn fencing. |
| `src/shared/types.ts` | DELETE unsafe enrichment hunk | Неполный тип без exact identity/provenance удалён. Текущий diff — проверенные контракты remediation. |
| `tests/pdfTextExtraction.test.ts` | KEEP | Windows child-process timeout 8 секунд сохранён; это независимое стабильностное изменение, проверенное текущим full suite. |

### Исходные untracked paths

| Путь | Вердикт | Доказанное основание |
|---|---|---|
| `docs/catalog-web-enrichment.md` | DELETE | Документ ошибочно обещал atomic write и mutation-free dry-run при отсутствии работающего runtime job. |
| `sql/019_catalog_web_enrichment.sql` | DELETE | Миграция dead/unsafe feature не должна выполняться Railway pre-deploy. |
| `src/catalog/webEnrichment.ts` | DELETE, затем redesign | Были воспроизведены false `complete`, соседняя модель, отсутствие conflict/TTL/run ledger/lock/pagination/exact identity. |
| `src/scripts/enrichCatalogWeb.ts` | DELETE | Не было execute confirmation, настоящего read-only dry-run, cost cap, cursor/resume/status. |
| `tests/catalogWebEnrichment.test.ts` | DELETE вместе с unsafe implementation | Пять happy-path тестов не обнаруживали neighbor model, false complete, rollback, conflicts и embedding poisoning. |
| `.scratch/audit-agent-runtime.mjs` | DELETE | Одноразовый runtime reader. |
| `.scratch/catalog-research-intake/**` | DELETE после переноса вывода | Внешние HTML/XML/script не являются release artifact. Производный вывод сохранён в audit: 4673 catalog URL и 24 category/listing URL среди ошибочных product candidates. |
| `.scratch/check-dossier-urls.mjs` | DELETE | Одноразовый probe. |
| `.scratch/dossier-url-check.json` | DELETE | Superseded результат probe. |
| `.scratch/crawl4ai-p4-*/**` | DELETE | Временные crawler/robots caches. |
| `.scratch/pdf-verifier-deps/**` | DELETE | Временные vendored Python/native зависимости. |
| `.scratch/pdfdeps-position08/**` | DELETE | Временные native/cache зависимости. |
| `.scratch/verify-output.json` | DELETE | Дубликат evidence. |
| `.scratch/verify-position20-pdfs.py` | DELETE | Одноразовый verifier. |

Readback перед финальной классификацией подтвердил отсутствие пяти unsafe feature paths: `docs/catalog-web-enrichment.md`, `sql/019_catalog_web_enrichment.sql`, `src/catalog/webEnrichment.ts`, `src/scripts/enrichCatalogWeb.ts`, `tests/catalogWebEnrichment.test.ts`. Содержимое `.scratch/` удалено; оставшаяся пустая локальная директория игнорируется. `.scratch/` добавлен в `.gitignore`.

## 2. Почему исходный enrichment удалён, несмотря на зелёные happy-path тесты

1. Failed web + один catalog spec + исходное description давали `status=complete`, после чего повторный запуск пропускал товар.
2. Fact принимался без совпадения `fact.productName` с exact target; split-код `TSS SGG 5000 EH` не связывался единым matcher.
3. `productToEmbeddingText` включал полный JSON enrichment с external prose и соседними моделями.
4. `products.enrichment` обновлялся отдельно от verified/product facts, поэтому partial commit был невосстановим.
5. Memory hit не имел TTL/fingerprint, принудительно объявлял `conflicts=[]` и `answered`.
6. Source tier не подтверждался hostname/document type; факт допускался без URL.
7. Pipeline не вызывался server/crawler/admin/job и не работал как npm-script в production image.

Исходные проверки давали 13/13 PASS для enrichment+PDF и 156/156 PASS для связанных catalog/web/proof/card suites, но не покрывали три воспроизведённых дефекта: split exact identity, maximum→nominal false proof и failed web→complete. Поэтому secondary signal не изменил verdict DELETE.

## 3. Финальный текущий dirty tree до commit

Свежий post-close-fix `git status --short --untracked-files=all` содержит ровно **51 видимый path: 44 modified и 7 untracked**. Каждый path ниже имеет осознанный `KEEP/FIX` verdict. Никаких исходных unsafe enrichment-файлов в этом списке нет; новые real-PG verifier scripts находятся только в intentionally ignored task proof package.

### Runtime/config/dependencies — KEEP/FIX

| Путь | Назначение текущего diff |
|---|---|
| `.gitignore` | Не допускать повторного попадания `.scratch/` в dirty/release scope. |
| `package.json` | Production dependency security ranges/overrides; это не удалённый enrichment CLI hunk. |
| `package-lock.json` | Воспроизводимое разрешение обновлённых `undici`, `fast-uri`, `brace-expansion`. |
| `evals/promptfoo/chat-app-provider.cjs` | Согласовать eval producer с capability/session contracts production route. |

### AI/catalog/runtime code — KEEP/FIX

| Путь | Назначение текущего diff |
|---|---|
| `src/ai/agentManagerCardSelection.ts` | Tri-state selection: unknown остаётся preliminary, proven violation исключается. |
| `src/ai/agentManagerOrchestrator.ts` | Planner/ledger coherence, referents, exact fact consumer, terminal recovery, truthful web telemetry и fenced persistence. |
| `src/ai/agentManagerToolRegistry.ts` | Typed tool contracts, source/result completeness и timeout boundary. |
| `src/ai/dialogueLedgerReducer.ts` | Typed merge/replace/clear, epistemic provenance и стабильный факт timestamp. |
| `src/ai/modelTextMatching.ts` | Централизованный exact product matcher, split/join model codes и suffix rejection. |
| `src/ai/productComparisonResearch.ts` | Exact-model binding, factual source descriptors, deterministic hierarchy/exhaustion. |
| `src/ai/requirementProofs.ts` | Tri-state proof и authority только из подтверждённого source descriptor. |
| `src/ai/verifiedFactMemory.ts` | TTL/fingerprint/conflict/exact-attribute safety для повторного использования facts. |
| `src/catalog/crawler.ts` | Fail-closed product-page identity consumer. |
| `src/catalog/sitemapSync.ts` | Тот же identity gate для sitemap import. |
| `src/catalog/productPageIdentity.ts` | Новый единый page-bound identity gate; listing/category/sparse card rejected. |
| `src/db/migrate.ts` | Declarative schema verified-fact fingerprint/supersession и durable contracts. |
| `src/db/repositories.ts` | Atomic catalog snapshot; verified-memory lifecycle; atomic session acceptance/history/close/feedback; owner/lease/deadline fencing. |
| `src/routes/chat.ts` | Capability handoff, atomic history/feedback/session lifecycle и честные unavailable responses. |
| `src/routes/leads.ts` | Capability/lead contract согласован с durable history. |
| `src/shared/types.ts` | Typed contracts producer↔consumer для pending turns, facts, provenance, telemetry и lead consumption. |

### Client — KEEP/FIX

| Путь | Назначение текущего diff |
|---|---|
| `src/client/chatHistory.ts` | Atomic hydrate, pending turn и подавление только уже consumed latest lead offer. |
| `src/client/chatStream.ts` | Typed pre-acceptance errors и ownership-safe pending stream. |
| `src/client/leadSubmit.ts` | Capability/lead request contract. |
| `src/client/main.tsx` | Optimistic rollback, pending recovery, identity-safe session clearing и Stop ownership. |

### Regression tests — KEEP

Каждый из следующих current paths является intentional regression/contract coverage и входит в полный зелёный suite:

- `tests/adminEmbeddingCoverage.test.ts`
- `tests/agentManagerComparisonResearch.test.ts`
- `tests/agentManagerConditionalWebShortCircuit.test.ts`
- `tests/agentManagerExactProductIdentity.test.ts`
- `tests/agentManagerOrchestrator.test.ts`
- `tests/agentManagerRequirementProofs.test.ts`
- `tests/agentManagerToolRegistry.test.ts`
- `tests/catalogCrawlerNoRegex.test.ts`
- `tests/catalogProductPageIdentity.test.ts`
- `tests/catalogRepositoryFreshness.test.ts`
- `tests/chatHistory.test.ts`
- `tests/chatSessionLifecycle.test.ts`
- `tests/chatStream.test.ts`
- `tests/conversationRepository.test.ts`
- `tests/conversationRepositoryAgentManager.test.ts`
- `tests/dialogueLedgerReducer.test.ts`
- `tests/leadRoutes.test.ts`
- `tests/leadSubmit.test.ts`
- `tests/modelTextMatching.test.ts`
- `tests/openAIAgentManagerModel.test.ts`
- `tests/pdfTextExtraction.test.ts`
- `tests/productComparisonResearch.test.ts`
- `tests/productionRuntimeMarker.mjs`
- `tests/productionRuntimeMarker.test.mjs`
- `tests/productionRuntimeMarker.test.ts`
- `tests/promptfooProvider.test.ts`
- `tests/sitemapSyncNoRegex.test.ts`
- `tests/verifiedFactMemory.test.ts`

### Audit/live artifacts — KEEP, stage intentionally

- Весь bounded proof package `.agent/tasks/AI-AUDIT-20260809/**`: frozen spec/plan, audit/disposition, raw RED→GREEN reports, evidence/problems/verdict. Он игнорируется общим правилом и должен добавляться только явным force-stage этой задачи.
- `local-live-tests/2026-08-09-AI-AUDIT-20260809-baseline.production.md`: единственный baseline live protocol этой задачи; также требует явного force-stage.
- Будущий post-fix protocol этой же задачи должен добавляться отдельно только после реального embedded-widget прогона.

## 4. Осознанно исключённые локальные paths

- Все остальные исторические `local-live-tests/**` сохраняются как локальная audit history, но **не входят в release staging set этой задачи**. Они не являются текущим доказательством и не должны быть случайно force-staged.
- Filename-scope scan нашёл ровно один suspicious-by-name historical ignored path: `local-live-tests/2026-04-27-token-budget-optimization.local.md`. Его содержимое не печаталось; файл не входит в release scope. Само слово `token` в имени — сигнал для исключения/ручной осторожности, а не доказательство секрета.
- `node_modules/**`, `dist/**`, пустая `.scratch/` и прочие generated/cache paths исключены из staging и из secret-content scan по назначению; они не являются source changes.

## 5. Итог disposition

- **DELETE завершён:** unsafe web-enrichment feature и содержимое `.scratch/` отсутствуют из release diff.
- **KEEP/FIX подтверждён локально:** все 51 текущих видимых source/test/config path прошли единый local release gate, полный suite и diff/secret hygiene checks, перечисленные в `evidence.md`.
- **Frozen AC9 выполнен:** каждый исходный dirty path перечислен с verdict и объяснением; current absence readback подтверждает удаление unsafe feature paths, а все retained/current paths классифицированы. Отдельный raw `git status` snapshot до builder work не был сохранён — это честное ограничение provenance, но frozen criterion требует полный список и disposition, а не обязательный формат исходного snapshot.
- **COMMIT ещё не выполнен:** этот документ фиксирует состояние до publication. Перед staging требуется повторный bounded readback; stage должен включать только перечисленные 51 path, task proof package и live protocol(ы) этой задачи.
