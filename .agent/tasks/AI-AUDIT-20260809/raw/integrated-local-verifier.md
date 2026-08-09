# Предварительная независимая local-верификация интегрированного дерева

Дата среза: 2026-08-09 15:00 MSK
Ветка: `codex/full-ai-audit-remediation-20260809`
HEAD: `9bc454c` + незакоммиченное интегрированное дерево
Роль: свежий verifier; builder-отчёты использованы только как навигация, выводы ниже получены из текущего кода и свежих команд.

## Итог

**Предварительный local verdict: FAIL.**

Подтверждённых Critical-дефектов нет. Остались семь High owning-layer/cross-layer blockers. Зелёный общий suite сам по себе их не опровергает: соответствующих отрицательных race/crash/authority fixtures сейчас нет.

Эта оценка не является финальным release verdict: commit/push/deploy/live по заданию не выполнялись, post-fix production evidence отсутствует, а обязательные `evidence.json` и `verdict.json` на момент среза ещё не созданы.

## Critical

Подтверждённых Critical findings нет.

## High findings

### H1. Lease fencing защищает final commit, но не durable промежуточное состояние

- AC: AC5, AC8.
- Статус: FAIL.
- Owning layer: `ConversationRepository` + orchestration persistence contract.
- Код:
  - `src/db/repositories.ts:744-752` — `updateNeedState` обновляет session только по `sessionId`;
  - `src/db/repositories.ts:1208-1237` — ledger event не проверяет owner/lease/deadline;
  - `src/db/repositories.ts:1277-1309` — ledger snapshot не связан с live turn owner;
  - `src/db/repositories.ts:1326-1358` — checkpoint можно перезаписать без owner fence;
  - `src/db/repositories.ts:1372-1403` — tool artifact можно перезаписать без owner fence;
  - для сравнения final boundary действительно fenced: `src/db/repositories.ts:1474-1549`;
  - незащищённые вызовы идут после claim в `src/ai/agentManagerOrchestrator.ts:5738-5769`, `6350`, `6362`, `6480`, `6506`, `6660`, `6694`, `7316`, `7520`, `8321`, `8447`, `8588`.
- Почему не доказано: старый worker после истечения lease/deadline или takeover новым owner может завершить уже начатый await и записать новый event seq, need state, snapshot, checkpoint или artifact. Его final answer будет отвергнут, но загрязнение контекста уже сохранится и может попасть в следующий turn.
- Минимальное воспроизведение:
  1. Worker A claim-ит turn и блокируется на tool/DB await.
  2. Lease истекает; history/reaper или worker B terminalize/reclaim-ит turn.
  3. Worker B пишет актуальное состояние.
  4. Worker A продолжает `upsertDialogueLedgerEvent`/`saveToolArtifact`/`persistDialogueLedgerState`.
  5. Прочитать ledger tail, snapshot, need state и artifact.
- Expected: ни одна turn-owned запись A после потери ownership не принята.
- Actual: SQL этих методов не знает `executionOwner`; запись принимается.
- Самый маленький безопасный fix: протянуть `executionOwner` во все turn-owned mutations и выполнять INSERT/UPDATE только через `EXISTS`/CTE на том же live turn (`owner`, незавершённый lease, deadline, active status). Ledger event + derived need state + snapshot должны фиксироваться как одна fenced transaction либо иметь CAS cursor, который не позволяет stale writer переписать более новый state.
- Corrective hint: не добавлять только ещё одну проверку в orchestrator перед await — это TOCTOU. Fence должен находиться в SQL owning layer и возвращать typed `not_owner/not_live` result.

### H2. Замена product snapshot и source facts/conflicts не crash-atomic

- AC: AC3, AC4, AC8.
- Статус: FAIL.
- Owning layer: `ProductRepository`.
- Код:
  - `src/db/repositories.ts:2433-2508` — product upsert завершается отдельным query, затем вызывается `upsertFactsFromProduct`;
  - `src/db/repositories.ts:2511-2562` — старые facts удаляются, новые вставляются по одному, затем отдельно пересчитываются conflicts.
- Почему не доказано: падение после product upsert оставляет новый product со старыми facts; падение после DELETE — новый product без facts; падение до/во время `refreshConflicts` — stale conflicts. Frozen remediation требует атомарной замены текущего source snapshot.
- Минимальное воспроизведение: внедрить fault после product upsert и отдельно после DELETE facts; после rollback/readback сравнить `products`, `product_facts`, `data_conflicts`.
- Expected: виден либо целиком старый, либо целиком новый snapshot.
- Actual: операции находятся в разных autocommit query и допускают смешанное состояние.
- Самый маленький безопасный fix: одна DB transaction на product upsert, source-scoped fact replacement и conflict refresh; один client от pool на весь блок, rollback при любой ошибке.
- Corrective hint: SQL-shape unit test недостаточен; нужен fault-injection/integration test с реальным transaction rollback.

### H3. Verified fact memory не имеет catalog/source fingerprint и полного conflict lifecycle

- AC: AC4, AC8.
- Статус: FAIL.
- Owning layer: durable verified-fact schema/repository + memory consumer.
- Код:
  - `src/shared/types.ts:97-127` — нет catalog/source fingerprint/revision;
  - `src/db/migrate.ts:240-269` — таблица не хранит fingerprint/source version;
  - `src/ai/verifiedFactMemory.ts:20,73-80` — reusable state определяется только 90-дневным TTL, status, confidence и URL;
  - `src/db/repositories.ts:2752-2810` — upsert refresh-ит только тот же value/source, но не supersede-ит конфликтующий active value;
  - `src/db/repositories.ts:2813-2841` — search возвращает все active значения.
- Почему не доказано: изменение catalog page/spec в пределах 90 дней не инвалидирует web memory. После нового исследования старое конфликтующее значение остаётся active; memory hit может быть постоянно заблокирован либо старый факт может использоваться без проверки актуального catalog fingerprint/source reread.
- Минимальное воспроизведение:
  1. Сохранить verified fact при catalog hash A.
  2. Обновить exact product/source до hash B с иным значением.
  3. Выполнить memory lookup до истечения TTL.
  4. Затем сохранить новое web value и перечитать active facts.
- Expected: hash mismatch требует reread; adjudication оставляет один действующий winner, сохраняя старое значение как audit history.
- Actual: hash не существует; отличающиеся значения остаются active.
- Самый маленький безопасный fix: добавить source/catalog fingerprint и verified source state; фильтровать reuse по совпадающему fingerprint, а конфликтующие значения adjudicate/supersede транзакционно.
- Corrective hint: текущая проверка «разные active values => не covered» безопаснее старого поведения, но это только вечный fail-closed, не жизненный цикл знания из remediation-plan:28,57-63.

### H4. Category/listing всё ещё может пройти product-page identity gate

- AC: AC3, AC8.
- Статус: FAIL.
- Owning layer: `src/catalog/productPageIdentity.ts` + crawler/sitemap consumers.
- Код:
  - `src/catalog/productPageIdentity.ts:58-61` принимает любой `og:type=product` без URL/identity binding;
  - `src/catalog/productPageIdentity.ts:64-75` принимает detail marker + price/spec при `productIds.size === 0`;
  - `src/catalog/productPageIdentity.ts:78-84` делает эти ветки достаточными;
  - `src/catalog/crawler.ts:133-143` после этого извлекает `h1` как product name.
- Свежий прямой repro:
  - synthetic listing с двумя child links, category `<h1>Vibroplates</h1>`, общими `card__main-slider`, `card__current-price`, `props-list`, но без page-level product id;
  - результат: `{"pageEvidence":true,"extractedName":"Vibroplates"}`.
- Expected: listing/category отвергается независимо от общих CSS классов и child offer markup.
- Actual: gate возвращает true и crawler создаёт ложный товар из category H1.
- Самый маленький безопасный fix: требовать exact page-bound identity: canonical/current URL-bound Product JSON-LD, либо ровно один page-level ID/SKU, согласованный с detail container; `og:type` и shared layout не должны быть самостоятельным доказательством.
- Corrective hint: добавить два RED fixtures: listing без `.js_*[data-id]`, но с shared detail classes; listing с ошибочным `og:type=product`. Проверить оба consumer-а: crawler и sitemap.

### H5. Terminal recovery теряет полезный вывод для `final_fit` и считает любой `web status=ok` завершённой проверкой

- AC: AC4, AC5, AC8.
- Статус: FAIL.
- Owning layer: terminal/recovery contract.
- Код:
  - `src/ai/agentManagerOrchestrator.ts:2699-2706` полностью отключает catalog recovery, если `selectionGoal !== preliminary_fit`;
  - `src/ai/agentManagerOrchestrator.ts:2737-2746` считает web verification законченной при любом `result.status === 'ok'`, не читая `answerGuidance.coverage`, `unconfirmedFacts`, `sourcesExhausted` и unresolved conflicts;
  - `src/ai/agentManagerOrchestrator.ts:9464-9472` (terminal text block; строка может сдвигаться при дальнейшей интеграции) полезный named preliminary вывод строится только при непустом recovery;
  - тест `tests/agentManagerOrchestrator.test.ts:10268+` покрывает только `preliminary_fit + web timeout`.
- Почему не доказано: exact-model comparison/purchase-safe confirmation законно может быть `final_fit`. При deadline после успешных catalog details и незавершённого web такой turn получает generic отказ без названной модели. Даже для `preliminary_fit` partial `status=ok` с `not_confirmed/ambiguous` coverage даёт пустой `unfinishedVerification`, поэтому не перечисляет ровно недостающие decisive facts.
- Минимальное воспроизведение:
  1. Persist intent exact comparison с `selectionGoal=final_fit`, successful `catalog.getProductDetails`, required web timeout; вызвать terminal completion.
  2. Повторить с `preliminary_fit`, web `status=ok`, но coverage=`not_confirmed`/`ambiguous`.
- Expected: сохранить catalog evidence, назвать предварительно подходящую exact model и точные unresolved facts; не утверждать final compatibility.
- Actual: case 1 возвращает generic no-product terminal; case 2 считает web finished и теряет список gaps.
- Самый маленький безопасный fix: terminal recovery должен вычислять safe preliminary candidates независимо от исходного goal, понижая readiness до preliminary; unresolved slots определять из typed research payload, а не только transport status.
- Corrective hint: terminal path не должен заново интерпретировать текст. Использовать persisted requirement IDs + coverage/conflicts/unconfirmed facts и проверенный catalog selection.

### H6. Session authorization и turn acceptance разделены TOCTOU; закрытая/expired session может получить новый turn

- AC: AC5, AC8.
- Статус: FAIL.
- Owning layer: route/repository acceptance boundary.
- Код:
  - `src/routes/chat.ts:182-199` сначала вызывает `restoreAuthorizedSession`, затем отдельным вызовом `createTurnWithUserMessage`;
  - `src/db/repositories.ts:771-897` атомарно создаёт turn + user message, но `inserted_turn` читает только `expiry_barrier`; нет locked `conversation_sessions` с `visitor_id/status/last_heartbeat` gate;
  - `src/db/repositories.ts:856-864` лишь touches session после вставки и тоже не требует active status;
  - final commit `src/db/repositories.ts:1474-1549` fence-ит turn owner, но не active session; `closeSession` `658-675` не отзывает active turn/owner.
- Почему не доказано: между route guard и repository mutation другая транзакция может close/expire session. FK допускает существующую closed row, поэтому новый turn/user message будет принят. Аналогично уже запущенный worker может сохранить assistant result после explicit close.
- Минимальное воспроизведение: barrier после успешного `restoreSession`; параллельно `closeSession`; затем разрешить `createTurnWithUserMessage`/final commit и прочитать rows.
- Expected: inactive/closed session не принимает новый message/turn и закрытие fence-ит дальнейшие turn-owned writes.
- Actual: acceptance SQL не проверяет session lifecycle.
- Самый маленький безопасный fix: включить locked active-session/capability check в одну repository transaction/statement с turn+message; close должен terminalize/revoke active execution или final commit обязан проверять active session, согласно выбранной lifecycle policy.
- Corrective hint: mock route test последовательного 404 не воспроизводит race. Нужен DB concurrency test с двумя connections/barrier.

### H7. Source hierarchy и `authoritative_web` основаны на self-reported tier/confidence, а не на фактическом источнике

- AC: AC4, AC8.
- Статус: FAIL.
- Owning layer: web research provenance + requirement proof authority.
- Код:
  - `src/ai/productComparisonResearch.ts:498-528` проверяет только совпадение self-reported query с фактически вызванным web query; tier/outcome не связывается с hostname/content type источников;
  - `src/ai/productComparisonResearch.ts:542-555` на этих label-ах объявляет hierarchy exhausted;
  - `src/ai/requirementProofs.ts:520-550`, особенно `540`, превращает любой LLM fact `sourceType=web + confidence=high` в `authoritative_web`;
  - `src/ai/requirementProofs.ts:658-693` такой authority может перебить конфликтующее catalog evidence.
- Почему не доказано: exact quote и exact-model binding проверяются, но источник marketplace/forum может быть ошибочно помечен моделью как high/official; три обычных web query могут быть self-labeled official/manual/secondary и дать `sourcesExhausted=true`, хотя фактическая hierarchy не пройдена.
- Минимальное воспроизведение: mocked Responses output с тремя completed queries и sourceAttempts official/manual/secondary, но `action.sources` только неофициального домена; вернуть exact quote с `confidence=high` и конфликтующим catalog value.
- Expected: tier/authority выводится deterministic из фактических source URL/document kind/approved manufacturer mapping; неподтверждённый tier не закрывает exhaustion и не получает authority 3.
- Actual: query label и model confidence достаточны.
- Самый маленький безопасный fix: сохранять validated source descriptor (`url`, normalized host, document kind, manufacturer/domain binding, tier); authority/exhaustion рассчитывать кодом из этих descriptors. Неофициальный exact источник может остаться corroborated, но не authoritative.
- Corrective hint: LLM выбирает semantic query и извлекает claim; код обязан классифицировать provenance/authority и механически применять conflict policy.

## Medium findings

### M1. Definitive pre-acceptance errors кроме 409 оставляют ложное optimistic user message

- AC: AC5, AC8.
- `src/client/chatStream.ts:240-254` типизирует `ChatMessageNotAcceptedError` только для 409; session 404 превращается в generic Error.
- `src/client/main.tsx:1485-1510` откатывает user+assistant и восстанавливает input только для typed not-accepted; generic branch `1515-1529` оставляет user message в истории и рисует assistant error.
- При inactive-session 404 server гарантированно не принял сообщение, но UI показывает его как отправленное. Минимальный fix: typed acceptance-state error для definitive 4xx (особенно 404), rollback optimistic pair, очистка stale session и безопасное предложение повторной отправки.

### M2. Ledger provenance хранится, но legacy `NeedItem.updatedAt` обновляется временем каждого rehydrate

- AC: AC5.
- `src/ai/dialogueLedgerReducer.ts:19-32` хранит source/confidence/createdAt.
- `src/ai/dialogueLedgerReducer.ts:140-146`, `589-610`, `661-663` создаёт каждый `NeedItem` с новым `now`, а source/event id не переносит.
- Старый факт выглядит свежим для consumer-ов `needState`; planner, читающий ledger напрямую, защищён, но cross-layer snapshot теряет возраст/provenance. Минимальный fix: `updatedAt = fact.createdAt ?? now` и один явно authoritative contract; добавить stable-rehydrate test.

### M3. Terminal response всегда публикует `usedWebSearch=false`

- AC: AC7, AC14.
- `src/ai/agentManagerOrchestrator.ts:9544` ставит top-level `usedWebSearch: false`, даже если `toolStatuses` показывает attempted/timed-out web.
- Это делает buyer/admin API contract противоречивым. Минимальный fix: derive флаг из persisted tool payload/status; отдельно хранить attempted/completed, если boolean недостаточен.

## Исправлено во время verifier-прохода и повторно проверено

1. Removal/negation replan: текущий `parallelIntentLedgerConflicts` теперь учитывает removed/replaced fact IDs (`src/ai/agentManagerOrchestrator.ts:371-390`); свежий targeted test `replans when the reducer removes an active hard requirement` — **1 PASS**, 149 skipped.
2. Verified attribute wildcard: `power/start` больше не удаляются как generic, пустой typed attribute fail-closed (`src/ai/verifiedFactMemory.ts:8-18,83-92,107-122`). Свежий direct repro после fix: `powerMatchesFuelTank=false`, `startMatchesFuelTank=false`, `powerCovered=false`.

## AC matrix на текущем local-срезе

| AC | Статус | Основание |
|---|---|---|
| AC1 | PASS (artifact-level) | `audit-report.md` содержит end-to-end карту и side paths; runtime claims всё равно требуют release verification. |
| AC2 | FAIL | новые High H1-H7 ещё не отражены полными LLM/code boundary решениями в финальном report/evidence. |
| AC3 | FAIL | H2 snapshot atomicity и H4 listing identity. |
| AC4 | FAIL | H3 verified memory lifecycle, H5 terminal gaps, H7 source authority/exhaustion. |
| AC5 | FAIL | H1 stale writer, H5 terminal, H6 session TOCTOU, M1/M2. |
| AC6 | UNKNOWN | post-fix production dialogues не выполнялись в этом проходе. |
| AC7 | UNKNOWN | post-fix widget/admin two-sided evidence отсутствует; M3 остаётся. |
| AC8 | FAIL | напрямую связанные owning layers остаются несогласованными; обязательных RED fixtures для H1-H7 нет. |
| AC9 | UNKNOWN | disposition документ прочитан, но текущая интеграция продолжает меняться; финальный bounded readback не выполнен. |
| AC10 | PARTIAL | root сообщил 814/814 + typecheck/lint/diff PASS до последних fixes для removal-replan и attribute wildcard; после них нужен свежий full rerun. Мои узкие проверки ниже. |
| AC11 | UNKNOWN | текущий commit не развёртывался; только baseline Railway artifact. |
| AC12 | NOT RUN | commit/push/deploy/live запрещены данным verifier-заданием. |
| AC13 | FAIL / IN PROGRESS | на момент среза нет `evidence.json`, `verdict.json`; fresh verifier пока обнаружил blockers. |
| AC14 | FAIL / IN PROGRESS | честный статус — работа не готова к completion claim. |

## Свежие команды verifier-а

1. `npm.cmd test -- --run tests/verifiedFactMemory.test.ts tests/catalogProductPageIdentity.test.ts tests/catalogRepositoryFreshness.test.ts tests/dialogueLedgerReducer.test.ts tests/conversationRepository.test.ts tests/chatSessionLifecycle.test.ts tests/chatHistory.test.ts tests/chatStream.test.ts`
   - единый параллельный запуск: 105 PASS, 2 timeout по 5 секунд (`chatSessionLifecycle`, `chatHistory`), exit 1;
   - это формально failed validation, поэтому оба файла были перезапущены последовательно.
2. `npm.cmd test -- --run tests/chatSessionLifecycle.test.ts tests/chatHistory.test.ts --testTimeout=15000 --maxWorkers=1 --no-file-parallelism`
   - 25/25 PASS.
3. `npm.cmd test -- --run tests/productComparisonResearch.test.ts tests/agentManagerRequirementProofs.test.ts --testTimeout=20000 --maxWorkers=1 --no-file-parallelism`
   - 49/49 PASS.
4. Focused orchestrator smoke до последних двух fixes: 5 PASS, 144 skipped.
5. После fix removal: targeted orchestrator test — 1 PASS, 149 skipped.
6. Direct verified-memory repro после fix: all three false, ожидаемо.
7. Direct page-identity repro на текущем коде: `pageEvidence=true`, `extractedName=Vibroplates`, дефект подтверждён.

Важно: первый non-zero не скрыт. Последовательный rerun доказал, что два route timeout зависели от параллельной нагрузки, но не превращает исходный агрегированный command в zero-exit.

## Что root обязан проверить после fixes

1. Добавить RED→GREEN contract/integration tests для каждого H1-H7, особенно:
   - stale owner после takeover не может писать event/snapshot/need/checkpoint/artifact;
   - product/facts/conflicts rollback при fault в середине replacement;
   - verified fact invalidation по catalog fingerprint и conflict adjudication;
   - category без IDs + ложный `og:type=product` отвергаются crawler и sitemap;
   - `final_fit + catalog ok + web timeout` даёт named preliminary terminal; `web ok + not_confirmed` сохраняет gaps;
   - close-vs-message и close-vs-final race на двух DB connections;
   - nonofficial sources не получают official/manual tier и authority 3.
2. Проверить M1 definitive 404 rollback на уровне UI contract; M2 stable timestamp; M3 terminal telemetry.
3. После последнего изменения заново выполнить targeted suites, затем один свежий полный `npm test`, typecheck, lint, build, `git diff --check`, secret scan.
4. Создать/обновить `evidence.json`; fresh verifier должен сформировать `verdict.json`. При любом non-PASS — `problems.md`, smallest safe fix и повторная верификация.
5. Только после local PASS: commit/push, дождаться GitHub-driven Railway deploy, доказать точный marker/deployed commit и провести обязательные adaptive live dialogues через embedded widget `https://bakautprof.ru/` с UI/admin readback.

## Требует уточнения или доработки

- H1 и H6 — P0 release blockers: без SQL-level fencing/lifecycle gate нельзя считать session/turn persistence безопасной, даже при зелёных unit tests.
- H2, H3, H4, H7 относятся к обязательным catalog/web provenance guarantees frozen remediation. Если root сознательно переносит их за пределы текущего release, соответствующие AC3/AC4/AC8 должны остаться FAIL; completion claim недопустим.
- H5 — P0 user-visible blocker: terminal answer не соответствует frozen требованию полезного предварительного вывода для всех релевантных selection goals и partial research payloads.

---

# Финальный повторный local-проход по текущему интегрированному дереву

Дата повторного среза: 2026-08-09, после интеграции исправлений H1–H7/M1–M3 и дополнительных cross-layer исправлений feedback/verified-memory/lead hydrate.
Источник истины: текущий production-код и свежие команды; предыдущая часть этого файла сохранена как история обнаружения и **не описывает текущий статус исправленных дефектов**.

## Текущий production-code verdict

**Новых подтверждённых Critical или High дефектов в текущем локальном коде после последнего fix/reverify нет.** Все H1–H7 и M1–M4 структурно закрыты на владеющих слоях и прошли связанные unit/contract tests. Real PostgreSQL verification по ходу этого прохода обнаружила два настоящих lifecycle/CTE дефекта; оба исправлены root на owning repository layer и независимо повторно проверены до GREEN, как описано ниже.

Это всё ещё не общий release PASS: post-fix GitHub→Railway deployment, embedded-widget dialogues и two-sided live evidence отсутствуют. Общий task verdict поэтому остаётся `FAIL`, хотя текущий local production-code verdict и AC5 теперь `PASS`.

Текущая severity-сводка после полного fix/reverify loop: **Critical — 0 unresolved; High — 0 unresolved; Medium — 0 unresolved**. Первоначальные H1–H7 и M1–M4 ниже сохранены как trace обнаружения и закрытия, а conservative manufacturer registry отмечен отдельно как непроявившийся non-blocking risk.

## Повторная оценка H1–H7

| ID | Текущий статус | Свежая проверка текущего дерева |
|---|---|---|
| H1 | RESOLVED / REAL PG GREEN | Все turn-owned mutations принимают `executionOwner` и fence-ятся в SQL по active session, exact owner, live lease/deadline и nonterminal status: `src/db/repositories.ts:830`, `1432`, `1524`, `1598`, `1667`, `1735`, `1803`. Zero-row приводит к typed `TurnMutationFenceError`. Real PostgreSQL barrier подтверждает owner takeover B → stale A artifact rejected с readback нового owner и отсутствующего artifact. |
| H2 | RESOLVED | `ProductRepository.inTransaction` (`src/db/repositories.ts:2424`) охватывает product upsert, source-scoped fact replacement и conflict refresh (`2830+`, `2910+`). Fault-injection проверяет `ROLLBACK`; свежий connected suite зелёный. |
| H3 | RESOLVED | Durable fact write хранит catalog hash/source fingerprint и транзакционно supersede-ит прежний same-source value (`src/db/repositories.ts:3167+`, `3309+`). Exact-ID lookup теперь не допускает `product_id IS NULL`: current ID/hash gate находится в `src/db/repositories.ts:3246-3268`; name-only fallback разрешён только при пустом списке exact IDs. Consumer дополнительно фильтрует exact bound facts в `src/ai/agentManagerOrchestrator.ts:5915-5944`. Regression с legacy null-ID fact не использует его. |
| H4 | RESOLVED | `src/catalog/productPageIdentity.ts:1-151` требует current-URL-bound Product JSON-LD либо согласованную page-level identity; shared detail CSS, false `og:type`, multi-card и sparse one-result listing отвергаются обоими consumers. |
| H5 | RESOLVED | Terminal recovery понижает `final_fit` до безопасного preliminary selection, сохраняет cards/model/price, выводит точные unresolved slots и разрешает technical handoff только если каждый unresolved required web check проходит строгий `webResearchResultProvesSourceExhaustion` (`src/ai/agentManagerOrchestrator.ts:2781-2877`, `9609-9658`). Timeout не предлагает специалиста/lead; доказанное exhaustion предлагает form без ложного «уже передано». |
| H6 | RESOLVED / REAL PG GREEN | Create turn+user message, claim, close, feedback и final commit проверяют exact active session/owner на owning DB layer (`src/db/repositories.ts:686-766`, `883`, `1069`, `1803`, `2103`). После real-PG RED close использует pinned Pool transaction: отдельный lock statement, затем fresh-snapshot turn/session/draft mutations. Barrier tests подтверждают оба close-vs-create порядка, close-vs-feedback и close-vs-final; atomic create readback подтверждает linked user message. Feedback route передаёт capability непосредственно repository (`src/routes/chat.ts:179-195`). |
| H7 | RESOLVED FOR FALSE AUTHORITY | Web search запрашивает `web_search_call.action.sources`; отсутствие поля fail-closed. Фактические URL/host/document kind классифицируются deterministic (`src/ai/productComparisonResearch.ts:507-671`), а `RequirementProof` получает manufacturer authority только из descriptor, не из model confidence (`src/ai/requirementProofs.ts:539-583`). Marketplace/manual-mirror repro больше не получает official/manufacturer. |

## Повторная оценка M1–M3 и дополнительных cross-layer краёв

| ID | Текущий статус | Свежая проверка |
|---|---|---|
| M1 | RESOLVED | Pre-stream session 404 типизируется как `ChatMessageNotAcceptedError` (`src/client/chatStream.ts:251-264`); UI откатывает ровно optimistic pair, восстанавливает input и очищает только совпавшую stale session (`src/client/main.tsx:1488+`). |
| M2 | RESOLVED | Legacy need projection использует provenance timestamp `fact.createdAt ?? updatedAt` (`src/ai/dialogueLedgerReducer.ts:145`); reducer regression зелёный. |
| M3 | RESOLVED | Terminal telemetry разделяет `webSearchAttempted` и `webSearchCompleted`; public/metadata `usedWebSearch` равен completed (`src/ai/agentManagerOrchestrator.ts:9571-9578`, `9683-9705`). Timeout fixture: used=false, attempted=true, completed=false. |
| X1 feedback close-race | RESOLVED / REAL PG GREEN | Capability, active/non-stale session lock, message update и audit-event enqueue находятся в одном CTE statement (`src/db/repositories.ts:2103+`); route больше не делает guard→mutation. Real PostgreSQL close-first barrier возвращает `null` и readback подтверждает отсутствие feedback metadata. |
| X2 lead hydrate | RESOLVED | Один history snapshot вычисляет latest offer и наличие более позднего durable lead (`src/db/repositories.ts:1223-1315`), route публикует boolean (`src/routes/chat.ts:145-156`), client подавляет только consumed latest offer (`src/client/chatHistory.ts:185-234`). |

## Остаточные риски, не подтверждённые как Critical/High code defect

1. **Rendered post-fix client proof отсутствует.** M1 и hydrate проверяются transport/source-contract tests, но не embedded production widget interaction. Это относится к обязательным AC6/AC7 live gates, не отменяет local AC5 PASS.
2. **Manufacturer-domain registry консервативен.** `approvedManufacturerDomainsByBrand` сейчас содержит FIRMAN/Honda/Husqvarna/STIHL (`src/ai/productComparisonResearch.ts:556-560`). Для остальных брендов официальный источник безопасно понижается до `secondary`; это не создаёт ложной authority, но может оставить разрешимый conflict как `unknown`. Классификация нуждается в расширяемом проверяемом registry, если production live покажет этот false-negative.

## Свежие независимые команды

1. `npm.cmd test -- --run tests/productComparisonResearch.test.ts --testTimeout=20000 --maxWorkers=1 --no-file-parallelism`
   - первый запуск во время незавершённого H7 patch: **35 PASS, 3 FAIL**, exit 1; старые fixtures не передавали `action.sources` и правильно стали fail-closed;
   - после исправления fixtures текущий повтор: **38/38 PASS**, exit 0. Первый non-zero не скрыт и относится к промежуточному shared-tree состоянию.
2. `npm.cmd test -- --run tests/agentManagerOrchestrator.test.ts -t "preserves eligible catalog cards|terminalizes final-fit" --testTimeout=20000 --maxWorkers=1 --no-file-parallelism` → **2 PASS, 148 skipped**, exit 0.
3. `npm.cmd test -- --run tests/productComparisonResearch.test.ts tests/agentManagerComparisonResearch.test.ts tests/catalogRepositoryFreshness.test.ts tests/conversationRepository.test.ts tests/chatSessionLifecycle.test.ts tests/chatHistory.test.ts --testTimeout=20000 --maxWorkers=1 --no-file-parallelism` → **6 files, 136/136 PASS**, exit 0.
4. Ранее в том же fresh verifier chain:
   - catalog/memory/source/identity bundle → **8 files, 99/99 PASS**;
   - ledger/session/client bundle → **8 files, 115/115 PASS**;
   - независимый H1/H6/M1 sub-pass → **4 files, 65/65 PASS**.
5. `git diff --check` → exit 0; только ожидаемые LF→CRLF warnings.
6. `npm.cmd run build` → exit 0; Vite client build и server `tsc -p tsconfig.server.json` завершились успешно.
7. Bounded secret-pattern/file-scope scan:
   - первая попытка непригодна: unsupported PowerShell `Path.GetRelativePath` дала runtime errors, script ошибочно дошёл до exit 0 с `files=0`; не засчитана;
   - исправленная fail-fast попытка завершилась exit 1 на unsupported path format; не засчитана;
   - рабочая широкая попытка просканировала 715 файлов и exit 1 на одном credential-URL syntax в `src/config.ts`; значение не выводилось;
   - shape-only review подтвердил localhost и одинаковый короткий low-entropy placeholder без вывода значения;
   - финальный reviewed rerun: `secret-scan-pass files=716 matches=0 allowedLocalPlaceholders=1`, exit 0. `.env`, dependencies/build/git/scratch исключены.
8. Root сообщил после последних code fixes: fresh full `npm test` → **77 files, 834/834 PASS**; typecheck и `lint:no-regex` → exit 0. Эти три результата должны быть сохранены root в evidence bundle; verifier не выдаёт их за собственный command run.
9. Real PostgreSQL verification после первоначального local verdict:
   - первый root barrier script обнаружил настоящий RED: прежний `createTurnWithUserMessage` пытался INSERT turn и sibling UPDATE той же строки в одном data-modifying CTE; repository возвращал `ConversationSessionUnavailable`. Root добавил постоянный RED и перестроил SQL message-before-turn;
   - verifier independently запустил `raw/postgres-session-race-proof.ts` на явно заданном loopback URL: atomic turn/message readback и `close_vs_feedback`, `close_vs_final_answer_commit`, `new_owner_vs_stale_durable_write` — PASS, exit 0;
   - verifier добавил `raw/postgres-close-create-verifier.ts`. Первые два запуска дали **exit 1**: при create-first → queued close session становилась `closed`, но turn оставался exact `received / user_message_saved / error_code=null` из-за старого snapshot close statement;
   - после root owning fix (pinned transaction, lock statement, fresh-snapshot mutations) тот же verifier script → **PASS**, exit 0: `close_first_rejects_without_orphans` и `create_first_links_then_close_revokes`;
   - focused permanent create+close regressions → 1 file, **2/2 PASS**, 37 skipped; fresh rerun основного PG barrier script после close fix также PASS, exit 0.

## Финальная local AC matrix до publication/live

| AC | Статус | Основание текущего среза |
|---|---|---|
| AC1 | PASS | Обновлённые `audit-report.md:420-457` связывают current main/side paths с owning files/functions, durable границами и buyer-visible failure states. |
| AC2 | PASS | Обновлённая per-finding matrix `audit-report.md:459-473` отдельно отвечает на все пять обязательных вопросов для H1-H7 и semantic High S1-S4. |
| AC3 | PASS | Catalog path прослежен; exact/fuzzy/hard/soft/comparison/missing/conflict fixtures присутствуют и связанные suites зелёные. |
| AC4 | PASS (local code) | Mandatory web, exact target/source, conflict, exhaustion, timeout и verified-memory producer/repository/consumer boundaries проверены текущим кодом/tests. Live остаётся в AC6/7/11. |
| AC5 | PASS | Session/history/ledger/hydrate/correction/recovery/navigation/inactive contracts зелёные. Real loopback PostgreSQL доказывает atomic turn-message readback, stale-owner fencing, close-vs-feedback/final и оба close-vs-create serialized outcome; rendered post-fix widget относится к AC6/7. |
| AC6 | FAIL | Нет post-fix adaptive production dialogues. |
| AC7 | FAIL | Нет post-fix two-sided widget/admin evidence; baseline admin raw неполон для всех counted dialogues. |
| AC8 | PASS | Current evidence сопоставляет каждый behavior change с retained RED→GREEN, включая M4 detached-baseline RED, PostgreSQL atomic-create RED и close-vs-create RED; directly coupled paths остаются green, новый narrow regex/keyword route не добавлен. |
| AC9 | PASS | Frozen initial dirty set полностью перечислен path-by-path в disposition с KEEP/FIX/DELETE reasoning, targeted proof и final absence/readback. Отдельного immutable raw status нет, но frozen criterion не требует конкретный формат snapshot; limitation честно сохранена. |
| AC10 | PASS | Обновлённый `evidence.md` сохраняет current unified `npm.cmd run verify` exit 0: full 834/834, agentic eval 249/249, typecheck, build, lint/no-regex и production audit; verifier independently подтвердил targeted/diff/build и reviewed 716-file secret scan. Dev-only audit non-zero отделён и честно описан. |
| AC11 | FAIL | Railway evidence относится к baseline commit `9bc454c`; post-fix deployed commit/marker/health match отсутствуют. |
| AC12 | FAIL | Task tree не committed/pushed/deployed; rollback branch документирован, но publication gate не выполнялся. |
| AC13 | FAIL | Fresh verifier, `evidence.md` и parseable `evidence.json` существуют, но не все AC PASS; AC13 прямо требует общий all-PASS. |
| AC14 | PASS | Audit report честно говорит `IN PROGRESS`/`NOT MET`, без ложного completion claim. |

## Обязательные следующие проверки root

1. После commit/push только через GitHub → Railway дождаться точного deployed commit/manifest и проверить health/readiness.
2. Провести всю post-fix adaptive matrix через embedded `https://bakautprof.ru/` с UI+admin/turnContract/tools/cards/warnings/latency audit.
