# Полный аудит AI-ассистента БАКАУТ

Дата: 2026-08-09
Исходный production commit: `9bc454c164869c7f1e2c91e2417a50e3ea10b769`
Production runtime: `agent_manager`, manifest `v16`
Baseline live: встроенный iframe-виджет на `https://bakautprof.ru/`, диалоги Railway `#1842–#1845`.

## Итог для владельца

Проект уже не является простым prompt-ботом: в нём есть единый agent runtime, typed intent/tool/answer/review contracts, durable turn/ledger/checkpoints, каталог, web research, расчёты, карточки и lead outbox. Каркас соответствует задаче продвинутого AI-менеджера.

Но production пока нельзя считать надёжным заменителем живого менеджера. Главные проблемы находятся на стыках слоёв:

1. **Сессия защищена непоследовательно.** UUID сессии достаточно для ряда mutation-маршрутов; visitor capability проверяется только на history/heartbeat.
2. **Активный ответ не восстанавливается в UI.** При navigation/reload вопрос виден, pending turn — нет; следующая реплика получает 409 и локально изображается как сохранённая, хотя в БД её нет.
3. **Внутренняя память типизирована не полностью.** observed/inferred fact превращается в confirmed; пустые массивы могут стереть ограничения и rejected products; planner иногда работает по state до текущего correction.
4. **Карточки не являются долговечными referents.** В live #1844 следующий ход заявил, что двух карточек/цен нет, хотя они были показаны строкой выше.
5. **Web research систематически не укладывается в 19,5 сек.** Четыре baseline-диалога подряд не получили официальные данные; в одном случае покупатель увидел общий отказ, в других — полезный, но неполный ответ.
6. **Catalog missing-data сейчас часто трактуется как incompatibility.** Потенциально подходящий товар исключается до web-проверки, если веса/мощности/фазы нет в карточке.
7. **Незакоммиченный bulk enrichment небезопасен и недостижим в production.** Его нельзя выпускать: он способен сохранить факт соседней модели и добавить внешнее содержимое в embeddings.

Вердикт baseline: **NOT READY для заявленного уровня автономного AI-менеджера**, но архитектура пригодна для поэтапного исправления без смены стека.

## 1. Карта системы: что за что отвечает и на что влияет

```text
bakautprof.ru
  └─ embed.js / launcher
      └─ React iframe widget
          ├─ localStorage visitorId (capability)
          ├─ sessionStorage sessionId
          ├─ history + heartbeat + feedback + lead UI
          └─ POST message / SSE
              └─ Fastify chat route
                  ├─ session ownership / turn idempotency / deadline
                  └─ AssistantService (тонкий sole-runtime adapter)
                      └─ AgentManagerOrchestrator
                          ├─ messages + ledger snapshot/tail
                          ├─ LLM reducer + LLM planner
                          ├─ deterministic policy repairs
                          ├─ typed tools
                          │   ├─ catalog search/details
                          │   ├─ web research/PDF
                          │   ├─ calculator
                          │   └─ lead capture
                          ├─ evidence/selection/ranking/cards
                          ├─ answer writer + reviewer
                          ├─ deterministic fact/card/lead gates
                          └─ durable final answer contract + assistant message

PostgreSQL
  ├─ conversation_sessions/messages/turns
  ├─ dialogue ledger events/snapshots
  ├─ checkpoints/tool artifacts/final answer contracts/traces
  ├─ products/product_facts/catalog_pages/data_conflicts/embeddings
  ├─ verified_product_facts
  └─ leads/outbox

Railway
  ├─ GitHub auto-deploy from zerg211/CHAT-AI-BAKAUT-RAILWAY
  ├─ Docker build
  ├─ preDeploy DB migration
  ├─ chat-ai service / custom domains
  └─ PostgreSQL + volume
```

### Владельцы ответственности

| Слой | Ответственность | Ошибка этого слоя влияет на |
|---|---|---|
| `src/client/main.tsx`, `chatHistory.ts`, `chatStream.ts` | Видимое состояние, hydrate, SSE/recovery, оптимистические сообщения | Потерю/дублирование реплик, ложные статусы, карточки, lead UX |
| `src/routes/chat.ts`, `leads.ts` | HTTP contract, auth capability, turn creation, deadlines, SSE | Изоляцию пользователей, durable acceptance, recovery |
| `ConversationRepository` | Транзакции sessions/messages/turns/ledger/artifacts | Exactly-once, crash safety, долговременную память |
| `dialogueLedgerReducer.ts` | Активные needs/facts/constraints/selections/rejections | Что ассистент «помнит» и что считает подтверждённым |
| `AgentManagerOrchestrator` | Semantic loop, plan, tools, selection, answer, review, commit | Качество следующего шага и согласованность всех слоёв |
| `ProductRepository`, crawler/sitemap/import | Текущий catalog snapshot, exact/text/vector retrieval | Полноту кандидатов, характеристики, актуальность карточек |
| `productComparisonResearch.ts`, PDF/security | Источники, exact quotes, web facts, conflicts | Техническую достоверность и время ответа |
| `agentManagerToolRegistry.ts` | Tool schema, timeout, side effects | Что LLM может безопасно выполнить |
| Railway/config/manifest | Фактическая версия, модель, DB, deploy | Соответствие проверенного кода production |

## 2. Реальный production path и side paths

Основной путь:

1. Widget создаёт/восстанавливает visitor/session.
2. POST `/messages` создаёт turn.
3. Orchestrator сохраняет user message, загружает 80 сообщений и ledger.
4. Reducer и planner строят delta/intent.
5. Policy repair меняет/валидирует plan.
6. Инструменты получают каталог, web facts, расчёты или lead action.
7. Selection/filter/ranking формируют products/cards.
8. Writer создаёт answer contract; reviewer проверяет; deterministic gates блокируют unsupported claims/cards.
9. Final contract и assistant message сохраняются; SSE отдаёт результат.

Side paths:

- SSE transport error → `/recover` того же turn;
- persisted answer contract → replay без повторного semantic turn;
- reviewer rewrite → повторный answer draft;
- exhausted budget/timeout → terminal catalog recovery или terminal failure;
- exact search failure → structured catalog recovery/broad pool;
- web gap → verified fact memory или live web research;
- lead action → durable lead/outbox с confirmation только после success.

Сильная сторона: final contract сохраняется до доставки, tool artifacts/checkpoints можно переиспользовать. Слабая сторона: UI не получает pending/committed state после разрыва транспорта, а orphan-turn lifecycle не имеет полного reaper.

## 3. Граница LLM и deterministic-кода

### Оставить deterministic

- ownership/capability, 404 indistinguishability;
- schema/input validation;
- idempotency, transactions, leases, deadlines, reaper/replay;
- allowlist tools, budgets, timeouts, side effects;
- арифметика и нормализация единиц;
- exact product/source identity и provenance;
- catalog snapshot/freshness/conflicts;
- доказанный hard conflict и сортировка по typed criteria;
- text ↔ product ID ↔ card consistency;
- lead authorization/outbox/audit;
- deployment marker и audit trace.

### Передать/оставить LLM planner

- смысл реплики и роль числа/модели;
- активная потребность, смена темы и возврат;
- correction/negation/supersession;
- hard requirement против preference;
- неоднозначность и решение «уточнить или искать»;
- допустимость альтернатив и компромиссов;
- какие missing facts decisive;
- план catalog/web/calculator в разрешённых границах;
- естественное объяснение и следующий лучший шаг.

### Нужный объединённый semantic contract

```ts
type TurnSemanticContract = {
  basedOnLedgerVersion: string;
  activeNeedId: string;
  stateDelta: TypedLedgerOperation[];
  supersededFactIds: string[];
  requirementRevisions: RequirementRevision[];
  productReferents: { productId: string; relation: 'selected'|'rejected'|'compared' }[];
  ambiguity: { status: 'resolved'|'needs_clarification'; question?: string };
  intent: {
    nextAction: 'answer'|'clarify'|'search_catalog'|'research_web'|'calculate'|'capture_lead';
    decisiveRequirements: Requirement[];
    toolRequests: TypedToolRequest[];
  };
};
```

Код проверяет версию, ссылки, факты, tools и business gates. Он не переписывает semantic plan по substring.

## 4. Аудит памяти одного пользователя

### Что реально хранится

- `visitorId` — localStorage; `sessionId` — sessionStorage.
- Messages — PostgreSQL; runtime читает до 80.
- LLM provider prompt — последние 12 сообщений.
- Ledger — snapshot + до 2000 tail events / replay до 10000.
- Turn checkpoints, tool artifacts, final answer contract и trace — durable.
- Cards — message metadata + system ledger event с selected IDs.

### Где забывает или смешивает

| Severity | Проблема | Доказательство | Последствие |
|---|---|---|---|
| High | Mutation routes не проверяют visitor capability | `chat.ts:103-160,293-377`; `chatStream.ts:121-126,178-183` | Чужая реплика/feedback/close/recovery может попасть в сессию |
| High | Reload active turn не восстанавливается | history отдаёт только messages; `main.tsx:1217-1236` | Вопрос виден, processing/result не виден; новый send конфликтует |
| High | observed и confirmed сводятся вместе | `dialogueLedgerReducer.ts:304-330,463-549` | Вывод LLM может вытеснить явный факт и стать confidence=1 |
| High | needs обновляются полными массивами | `dialogueLedgerReducer.ts:241-281` | `[]` стирает rejection/constraint/open question |
| High | planner работает по pre-delta state | `agentManagerOrchestrator.ts:5903-5943` | Коррекция веса/бюджета/фазы не всегда вызывает replan |
| High | product objects восстанавливаются из bounded message history | `agentManagerOrchestrator.ts:3426-3540`; repo limit 80 | Ledger помнит ID, но модель теряет карточку/facts |
| High | verified facts без TTL/adjudication | `repositories.ts:2492-2581`; `verifiedFactMemory.ts:80-110` | Старые конфликтующие значения объявляются answered |
| Medium | lead UI state только local | `chatHistory.ts:149-155`; `main.tsx:676-721` | После reload форма может открыться снова и создать duplicate |
| Medium | Stop abort-ит только браузер | `main.tsx:1416-1418` | Server turn продолжает, UI перестаёт следить, next send 409 |
| Medium | raw last-12 без semantic compaction | `agentManagerOrchestrator.ts:224-229` | Неизвлечённая ранняя договорённость исчезает без сигнала |
| Medium | malformed nested snapshot не валидируется глубоко | reducer `146-185` | Одна повреждённая запись может сломать memory всей сессии |

### Что уже работает

- Completed assistant messages/cards восстанавливаются после обычной навигации.
- Ledger может накопить нагрузку, фазность и методы пуска: live #1842 answer contract сохранил семь facts.
- Same-turn checkpoints/tool artifacts действительно переиспользуются recovery.
- Явное новое ограничение «до 100 кг» перестроило выбор live #1844 и не вернуло тяжёлые модели в следующем видимом ответе.

## 5. Аудит каталога и характеристик

### Текущий путь

Crawler/sitemap/CSV → normalize/upsert → product facts/embeddings → LLM intent → catalog search/details → hard filter/proofs → ranking → validated selection → cards.

### Главные разрывы

1. **Missing attribute исключает кандидата до web.** Weight/power/phase/source/autostart/material имеют fail-closed ветки (`agentManagerOrchestrator.ts:2445-2542`). Web получает только оставшиеся selected products (`7649-7668`). Правильно: `unknown` не равно `violated`.
2. **Maximum подменяет nominal.** `nominalKw ?? maxKw` (`2474-2478`), а proof canonicalization сводит qualifiers к `power` (`requirementProofs.ts:153-165`).
3. **Exact model identity раздроблена.** Split model `TSS SGG 5000 EH` не даёт token; отдельные matchers принимают совпадение одной части. Риск соседней модификации.
4. **Listing/category может стать товаром.** Sitemap/crawler используют product-like URL только для sorting; child Product/Offer в listing достаточно для detector. Сохранённый snapshot: 4673 URL, 24 явных category/listing candidates.
5. **Sync сохраняет stale specs/raw.** `products.specs || EXCLUDED.specs` не удаляет исчезнувшую/исправленную характеристику (`repositories.ts:2180-2201`).
6. **Product/facts refresh не транзакционен.** Старые conflicts не закрываются после схождения.
7. **Собранные данные недоступны AI.** `raw` ожидается mapper-ом, но не выбирается `PRODUCT_RESPONSE_COLUMNS`; `catalog_pages`, product facts и conflicts не подключены к tool path.
8. **Cards continuity ломается.** Live #1844: три карточки/цены видны, следующий `getProductDetails=not_found`, ответ утверждает, что карточек и цен нет.

### Правильная модель пригодности

| State | Значение | Действие |
|---|---|---|
| `satisfied` | Требование доказано catalog/verified fact | Можно ранжировать и рекомендовать |
| `violated` | Есть подтверждённое противоречие hard requirement | Исключить, объяснить конкретный conflict |
| `unknown` | Решающий факт отсутствует/просрочен/конфликтует | Не исключать; оставить preliminary candidate и проверить web/manual |

## 6. Аудит web research и долговременного знания

### Сильные стороны

- SSRF, DNS rebinding, redirects и byte limits защищены (`outboundHttp.ts:251-305`).
- PDF parser запускается isolated child с env allowlist, memory limit, queue и hard timeout.
- Exact quote перепроверяется локально; URL перечитывается.
- Planner умеет требовать web tool для конкретных requirement IDs.

### Почему production не находит паспортные данные

- Tool budget — 19,5 сек, одна попытка (`agentManagerToolRegistry.ts:185-193`).
- Research допускает до 12 sources × 4 сек, concurrency 4, плюс LLM/validators/retry.
- Live #1842, #1843, #1844, #1845: `web.researchProductFacts=timeout`; #1845 ровно 19 510 мс, `Request was aborted`.
- Нет OCR fallback для scanned PDF.
- Частичный exact fact способен преждевременно завершить retry, даже если decisive attribute остался unresolved.

Независимый контроль сети показал, что это не отсутствие данных в интернете:

- официальный Honda manual для GX120/GX160 и отдельный GX160T2 manual нашлись одним поиском; второй содержит oil capacity 0,58 л и spark gap 0,7–0,8 мм;
- официальная страница Husqvarna K 770 сразу отдаёт 3,9 кВт, максимальную глубину 125 мм, массу 10,1 кг, варианты диска и ссылки на operator manuals/accessories;
- официальный STIHL TS 410/420 instruction manual найден как PDF и содержит глубину 100 мм для 12-дюймового и 125 мм для 14-дюймового диска.
- страница официального дилера MAGNUS содержит отдельную позицию `Magnus 25/400 FA`, 25 кВт и расход 6,4 л/ч при 75%; exact `Азимут АД-30С-Т400-1РМ16` также находится в профильных источниках с расходом при 75%, хотя authority/variant нужно валидировать отдельно.

Следовательно, live-ответы «внешняя проверка не завершилась» отражают budget/extraction/recovery defect проекта, а не доказанное отсутствие официальных источников. Точные расходники всё равно должны привязываться к engine type/serial и exact manual revision.

### Verified fact memory

Проблемы: нет TTL/catalog fingerprint/source reread; отличающиеся значения остаются active; memory hit скрывает conflicts и объявляет все attributes answered. Это долговременная галлюцинация, а не память.

### Незакоммиченный enrichment

Вердикт DELETE/redesign. Критические причины:

- failed web превращается в `complete` благодаря catalog spec/description;
- exact product identity не проверяется перед persistence;
- raw external JSON попадает в embedding;
- product enrichment и facts пишутся неатомарно;
- source tier не подтверждается фактическим hostname/type;
- feature не вызывается production runtime/job;
- production image не содержит `tsx`, нужный npm-script.

## 7. Аудит живых диалогов baseline

### #1842 — генератор, расчёт, mixed phase, exact comparison

Покупатель увидел:

- разумный preliminary расчёт 20 кВт и рекомендацию 25–30 кВт;
- три корректно связанные карточки MAGNUS 20/25 и Азимут 30;
- правильное объяснение 230/400 В и распределения однофазной нагрузки;
- на точное сравнение AVR/перекоса/расхода/АВР — общий отказ «не смог… вопрос сохранен»;
- после перехода по карточке отказ исчез, остался unanswered user message.

Внутри:

- intent потребовал catalog details + web по четырём requirement IDs;
- catalog `ok`, web `timeout`;
- recovery переиспользовал checkpoints/artifacts;
- answer contract сохранил семь facts;
- terminal fallback не сохранился assistant message.

Оценка: понимание и расчёт хороши; delivery/recovery — FAIL; web — FAIL; память facts — PASS; полезность terminal answer — FAIL.

### #1843 — ремонт BPS 1550 Aw / Honda GX160

Покупатель увидел:

- полезный безопасный порядок проверки: вентиляция бака, искра, топливо, фильтр, датчик масла, ремень/эксцентрик;
- корректный запрос двигателя, потому что исполнения различаются;
- после `Honda GX160 QX2` снова не получил масло/свечу/фильтр/зазор — web не завершился;
- бот попросил ещё serial/photo, хотя exact engine/type уже достаточен для начала официальной проверки.

Оценка: troubleshooting reasoning — PASS; exact technical facts/web — FAIL; escalation contract — PARTIAL (конкретный gap назван, но нет полноценного handoff choice после исчерпания поиска).

### #1844 — виброплита, полный комплект, смена ограничений

Покупатель увидел:

- первый ответ преждевременно предложил 171 и 278 кг, одна карточка — 1,1 млн ₽, не спросив площадь/проходы/погрузку;
- после уточнения `80 м²`, `90 см`, `один`, `до 100 кг` — хороший replan на 56–64 кг и три карточки;
- compatible mat остался неподтверждённым;
- на следующем сравнении Champion/Wacker в бюджете до 90 тыс. бот заявил, что карточки и цены не нашлись, хотя они были показаны строкой выше (50 290 и 80 000 ₽).

Внутри последнего turn:

- `catalog.getProductDetails=not_found`, web `timeout`;
- answer contract использовал бюджет/вес/ширину/погрузку, но не previous products;
- reviewer обнаружил missing/unsupported issues и сделал rewrite;
- durable product referent не был восстановлен.

Оценка: requirement correction — PASS; initial discovery — FAIL; cards continuity — FAIL; exact comparison/web — FAIL; rejection handling в короткой видимой последовательности — PASS.

### #1845 — navigation во время активного ответа

Ход:

1. Отправлено точное сравнение Husqvarna K 770 vs Stihl TS 420 с manuals и catalog discs.
2. Во время `Отвечаю` выполнен переход на `/catalog/rezchiki/`.
3. Reopened widget показал один user message и статус `Онлайн`; pending state отсутствовал.
4. Follow-up «Вы продолжаете проверку?» локально появился в истории и получил «Вопрос сохранен».
5. После server completion UI не обновился.
6. После reload появился только исходный user message + исходный assistant answer; follow-up полностью исчез.

Admin:

- #1845 содержит ровно 2 сообщения, follow-up не сохранён;
- catalog search `ok`, web timeout 19 510 мс;
- answer contract factsUsed `[]`;
- assistant message был сохранён через минуту и доступен только после нового reload.

Оценка: durable background completion — PASS; pending restore — FAIL; truthfulness UI — FAIL; lost follow-up — FAIL; web — FAIL.

## 8. Аудит диалогового поведения в совокупности

| Фактор | Оценка baseline | Комментарий |
|---|---|---|
| Понимание естественной реплики | 7/10 | Хорошо распознаёт задачи и corrections; keyword override остаётся риском |
| Уточнение потребности | 5/10 | Иногда уточняет правильно, иногда рекомендует 171–278 кг до критичных вопросов |
| Расчёты | 7/10 | Генераторный ориентир полезен, но qualifiers/одновременность должны быть строго доказаны |
| Поиск каталога | 6/10 | Находит релевантные карточки, но missing-data и details failure ломают continuity |
| Полнота списка | 6/10 | Даёт несколько вариантов и комплект; accessories часто общие, не exact catalog SKUs |
| Сравнение | 4/10 | Без web даёт отказ; предыдущие две карточки может «забыть» |
| Web/manual research | 2/10 | 4/4 baseline sessions timeout по требуемому web tool |
| Технические характеристики | 4/10 | Не выдумывает, но слишком часто не добывает доступные официальные facts |
| Ремонт/эксплуатация | 7/10 | Диагностический порядок полезен и безопасен; exact расходники не найдены |
| Запчасти/совместимость | 3/10 | Нет устойчивого exact identity + source proof path |
| Память одного диалога | 5/10 | Ledger facts работают, cards/rejections/corrections и long context ненадёжны |
| Recovery/navigation | 2/10 | Live доказана потеря pending state и несохранённой follow-up реплики |
| Честность неопределённости | 7/10 | Обычно не выдумывает; UI ошибочно утверждает persistence |
| Продажный следующий шаг | 5/10 | Preliminary guidance есть; fallback часто заканчивается отказом/«могу продолжить» |
| Карточки | 6/10 | Хорошо показываются при успешном selection; текст и cards могут разойтись |
| Lead/business boundaries | 7/10 по коду | Deterministic gates сильные; full live lifecycle/reload ещё не доказан |
| Наблюдаемость | 7/10 | Admin trace полезен, но не показывает полный ledger/checkpoints/artifacts contract |

## 9. Архитектурные High findings

| ID | Finding | Root cause | Owner |
|---|---|---|---|
| H1 | Capability не покрывает все mutations | Auth сделан route-by-route, не session invariant | routes/repository/client |
| H2 | Turn создаётся отдельно от user message | Durable input разделён между route и orchestrator | repository/orchestrator |
| H3 | Orphan active turn блокирует сессию | Нет stale terminalization/reaper | repository/maintenance/client |
| H4 | Keyword override стирает LLM plan | Semantic ambiguity решается substring без context | orchestrator/planner contract |
| H5 | Reducer/planner расходятся | Параллельность по старой ledger version | orchestrator |
| H6 | Provider видит last 12 без summary proof | Raw truncation вместо semantic compaction | orchestrator/memory |
| H7 | Live marker ожидает v15 вместо v16 | Дублированная версия в checker | production test/runtime manifest |

## 10. Railway и operations

Проверено без вывода значений:

- Project: `laudable-unity`, environment `production`.
- Services: `chat-ai` и PostgreSQL; оба running/success.
- Active deployment commit совпадает с baseline `9bc454c...`, branch `main`.
- GitHub source: `zerg211/CHAT-AI-BAKAUT-RAILWAY`; Dockerfile builder; 1 replica, Europe west.
- Custom domains присутствуют; production admin работает на Railway domain.
- PostgreSQL volume ready: около 679/5000 MB на момент проверки.
- Required names присутствуют: DB, OpenAI key, admin auth, public HTTPS base, HTTP email transport, lead recipient.
- Railway `OPENAI_MODEL` присутствует, но не равен `gpt-5.6-terra`; production `config.ts` принудительно задаёт Terra всем answer/planner/fact/deep/review models. Это не текущая смена модели, а operational drift.
- `OPENAI_ANSWER_MODEL`, planner/fact/deep overrides, review mode и explicit CORS origins отсутствуют; production code задаёт часть значений сам.
- Railway `preDeploy` запускает migration, Docker `CMD` тоже содержит migration перед server, тогда как Railway start command запускает server отдельно. Нужно оставить один документированный lifecycle path либо advisory lock.
- Default production marker в test ждёт v15, runtime manifest/app — v16: текущий live gate без env override не доказывает правильную версию.

Dependency audit первоначально обнаружил три High-уязвимости в production-дереве (`undici`, `fast-uri`, `brace-expansion`). Совместимые обновления дают текущий `npm audit --omit=dev --audit-level=high` exit 0. В development-only дереве остаются пять High через необязательный Promptfoo/HuggingFace/ONNX путь (`adm-zip`, `sharp`); npm предлагает только принудительный downgrade Promptfoo, поэтому он не применён без доказательства совместимости. Точный протокол: `raw/dependency-audit-root.md`.

Риск безопасности во время аудита: защищённая browser-интеграция отразила значение admin password в закрытом tool output. Значение не помещено в файлы/ответ и не повторяется, но credential следует считать скомпрометированным. Автоматическая rotation не выполнена: policy требует явного разрешения на security-sensitive Railway mutation/redeploy.

## 11. Приоритетный план

Полный исполняемый план заморожен в `remediation-plan.md`. Кратко:

1. P0: capability, atomic user-turn, pending/reload recovery, orphan terminalization, честные UI states.
2. P0: typed ledger operations/certainty, rejected products, post-delta semantic coherence.
3. P0: durable prior-product referents и useful terminal answer с catalog evidence.
4. P1: exact product identity, tri-state eligibility, power qualifiers, catalog snapshot atomicity.
5. P1: verified fact TTL/conflicts и безопасный bounded enrichment redesign.
6. P1: runtime marker/Railway drift/observability.
7. После каждого tranche — adaptive production widget + admin audit; merge только при release PASS.

## 12. Как проверять на живом диалоге

Обязательная матрица после fixes:

- vague need → questions → complete catalog selection;
- generator calculation with changed load/phase;
- two suitable + one proven unsuitable;
- missing attribute kept preliminary and researched;
- exact repair/maintenance/parts/compatibility;
- reject product → normal follow-up → rejection persists;
- «эти две модели» → exact details/cards/prices persist;
- 12–20 turns + return to old need;
- navigation/reload while active and after completion;
- lost SSE → same turn result, no duplicate semantic execution;
- commercial question → no unverified promise;
- exhausted gap → technical handoff → synthetic contact → selected message/call → reload without duplicate form.

Для каждого: фактический UI transcript, cards/links, latency, deployed marker, admin turn/ledger/intent/tools/source attempts/warnings/recovery/review/lead state и ручная оценка правильности каждого хода. Следующая реплика строится только после чтения ответа.

## 13. Текущий primary signal

Baseline audit signal: **MET** — проблемы доказаны кодом, UI и admin trace.
Local remediation signal: **MET** — текущий integrated tree прошёл 77 файлов / 834 теста, 249 agentic evals, typecheck, `lint:no-regex`, production build и реальный двухклиентный PostgreSQL barrier proof; свежий verifier не подтвердил оставшихся Critical/High в коде.
Production remediation signal: **IN PROGRESS** — commit/push, Railway marker и post-deploy adaptive widget verification ещё не выполнены на этом срезе.
Готовность заявленного продукта: **PARTIALLY VALIDATED** до production widget/admin evidence.

## 14. Текущая post-remediation карта с кодовыми ссылками

Baseline-разделы 4–9 выше описывают найденное исходное состояние. Ниже — карта текущего дерева после RED→GREEN исправлений; это не попытка выдать baseline-дефекты за остающиеся.

| Путь | Владеющий код | Durable/typed граница | Что видит покупатель при ошибке |
|---|---|---|---|
| Create/restore UI | `src/client/main.tsx::createSession`, `src/client/chatHistory.ts::restoreSavedChatSession` | visitor capability из localStorage, session ID из sessionStorage; public history + `pendingTurn` + `leadOfferConsumed` | восстановленная история, pending/recovering, либо честный stale/error state |
| Send/SSE | `src/client/chatStream.ts::streamChatAnswer`, `src/routes/chat.ts::registerChatRoutes` POST `/messages` | `ConversationRepository.createTurnWithUserMessage` атомарно связывает client message, user message и turn под capability/session lock | optimistic pair остаётся только после server acceptance; 404/409 откатывает несохранённый текст |
| Active-turn hydrate | GET `/api/chat/sessions/:id/messages`, `ConversationRepository.getHistorySnapshot` | один SQL snapshot: messages, latest pending turn, expired-deadline transition и latest lead-offer consumption | reload не превращает выполняющийся turn в «Онлайн» и не создаёт второй фиктивно сохранённый вопрос |
| Sole AI runtime | `src/ai/assistant.ts`, `src/ai/agentManagerOrchestrator.ts::generateAnswer`, `executeClaimedTurn` | sole manifest `src/ai/aiManagerRuntimeManifest.ts`; claimed owner/lease/deadline | один semantic turn, либо replay/recovery того же turn |
| Context update | `AgentManagerOrchestrator.loadDialogueLedgerContext`, `src/ai/dialogueLedgerReducer.ts::reduceDialogueLedger` | typed ledger events/snapshot; fact event type, source, confidence, createdAt; merge/replace/clear list operations | corrections/rejections сохраняются, observed не маскируется как confirmed |
| Planning consistency | `parallelIntentLedgerConflicts`, post-delta replan in `agentManagerOrchestrator.ts` | replan на add/change/remove/negate/supersede hard state | текущая коррекция веса/фазы/потребности применяется до выбора |
| Tool execution | `src/ai/agentManagerToolRegistry.ts`, `AgentManagerOrchestrator.executeTools` | Zod tool request/result, one-attempt budget, durable checkpoint/tool artifact fenced by execution owner | повторный recovery не запускает новый смысловой ход и не теряет уже добытые данные |
| Catalog search/details | `ProductRepository.searchProducts/getProductsByIds`, `agentManagerCardSelection.ts` | canonical product IDs, exact referents, tri-state requirement proof | unknown остаётся preliminary; исключается только доказанный conflict; прошлые карточки доступны по ID |
| Catalog ingest/snapshot | `src/catalog/crawler.ts`, `sitemapSync.ts`, `productPageIdentity.ts`, `ProductRepository.upsertProduct` | URL-bound Product identity; product/source facts/conflicts replace в одной transaction; stale embedding очищается | listing не становится карточкой; исчезнувшая характеристика не продолжает жить как текущая |
| Web/manual research | `productComparisonResearch.ts::researchProductComparisonFacts`, `classifyProductResearchSource` | exact model identity, actual `action.sources`, approved manufacturer domain, exact HTTP quote, source tier/outcome | официальный/secondary факт не определяется самоназванием LLM; unresolved факт остаётся явно unresolved |
| Verified fact memory | `ProductRepository.upsertVerifiedProductFact/searchVerifiedProductFacts`, `verifiedFactMemory.ts` | 90-day TTL, HTTP provenance, catalog hash, source fingerprint, supersession/conflict lifecycle, exact product binding | stale/name-only/conflicting fact не short-circuit-ит новый поиск |
| Selection/cards/answer | `filterProductsByStructuredSelectionPolicy`, `requirementProofs.ts`, answer/card gates | `satisfied | violated | unknown`; selected product IDs связывают text, facts и cards | текст не отрицает показанную карточку и не выдаёт maximum/engine power за nominal |
| Terminal path | `AgentManagerOrchestrator.completeTerminalTurn`, `terminalCatalogRecovery` | persisted intent/tools; typed coverage; strict `webResearchResultProvesSourceExhaustion`; atomic final contract + message | catalog model/price/card и точный gap сохраняются; specialist form только после доказанного exhaustion |
| Recovery/replay | POST `/recover`, `recoverTurn`, `completedFromFinalAnswerContract`, `completedPayload` | existing turn ID, answer contract replay, owner-fenced final commit | нет второго LLM-ответа; завершённый результат подхватывается после транспорта/reload |
| Close/feedback | `ConversationRepository.closeSession`, `updateAssistantFeedback` | capability + active/non-stale session lock в том же SQL; close отзывает active execution | закрытая/чужая сессия получает одинаковый 404 и не мутируется |
| Lead | `src/routes/leads.ts`, `LeadRepository.createClientLeadWithOutbox`, history `leadOfferConsumed` | durable lead+outbox+draft consume; confirmation только после queued row | форма не утверждает передачу до success и не открывается повторно после reload того же offer |
| Railway | `Dockerfile`, `src/config.ts`, runtime manifest, `tests/productionRuntimeMarker.mjs` | GitHub auto-deploy, migration/start, forced production Terra, v16 marker | live проверяется против развернутого commit/runtime, не устаревшей v15 копии |

### Прямо связанные side/failure paths

| Side path | Текущий контракт и ссылка |
|---|---|
| SSE оборвался после durable acceptance | Client использует returned `turnId`; `/recover` вызывает `recoverTurn`; final contract/message replay выполняют `completedFromFinalAnswerContract`/`completedPayload`. |
| Reload во время ответа | `getHistorySnapshot` возвращает `pendingTurn`; `main.tsx` регистрирует hydrate controller в общем Stop slot и poll/recover-ит тот же turn. |
| Crash оставил active turn | `createTurnWithUserMessage` атомарно terminalize-ит turn с истёкшим deadline; active-turn index больше не создаёт вечный deadlock. |
| Lease потерян/сессия закрыта | Need, ledger event/snapshot, checkpoint, tool artifact, draft и final writes требуют current `executionOwner`, живой lease/deadline и active session в repository SQL. |
| Reviewer требует rewrite | Answer draft повторно проверяется; deterministic gates сохраняют fact/card/lead invariants и не принимают failed tool как факт. |
| Catalog details `not_found` после показанных cards | `previousProductReferents` восстанавливает exact IDs/objects из видимой истории и текущего need state; terminal/normal answer сохраняет модель и цену. |
| Web `timeout/failed` | Это interrupted, не exhausted: no premature lead; catalog evidence остаётся preliminary, telemetry различает attempted/completed. |
| Web `ok`, но coverage unresolved | `terminalUnfinishedWebVerification` не считает envelope доказательством; strict exhausted result даёт конкретный technical handoff, иначе — только честный gap. |
| Source conflict/catalog refresh | Source snapshot и conflicts обновляются транзакционно; verified fact fingerprint/hash блокирует reuse после изменения карточки. |
| Lead success/reload | History сравнивает latest `offer_form` message с последующим durable lead; client подавляет только уже использованное последнее предложение. |

## 15. Пять обязательных вопросов LLM/кода по каждому High

| ID | Где код подменял LLM | Где терялся контекст | Что обязано остаться deterministic | Что принадлежит planner | Безопасный typed результат |
|---|---|---|---|---|---|
| H1 stale-owner writes | Не semantic defect: LLM здесь не должен иметь власти | Новый owner/session мог сосуществовать со старыми durable writes | owner/lease/deadline/session fencing и atomic commit | ничего | `{turnId, executionOwner, leaseExpiresAt, deadlineAt}` как обязательный fence каждого write |
| H2 catalog snapshot atomicity | Не semantic defect | product row мог быть новым, facts/conflicts — старыми | transaction, rollback, source replacement, conflict close | какие attributes решающие для покупателя | source snapshot `{productId, sourceHash, facts[], conflicts[]}` |
| H3 verified memory freshness | Код объявлял memory hit `answered` по имени/TTL-less записи | Текущий catalog fingerprint и новый conflicting value терялись | exact product binding, TTL, URL, fingerprint, supersession, conflict gate | можно ли использовать уже подтверждённый факт в объяснении | fact `{productId, attributeQualifier, value, sourceUrl, sourceFingerprint, catalogHash, verifiedAt, status}` |
| H4 page identity | HTML-sигналы принимали решение «это товар» без page scope | Контекст URL и нескольких child cards терялся | URL-bound Product JSON-LD либо непротиворечивые page ID+SKU | ничего | detector result `{pageType:'product'|'listing'|'unknown', boundId, evidence[]}` |
| H5 terminal `ok`≠answered | Код принимал tool status как смысловой ответ и выбрасывал final-fit product | Decisive attribute/coverage и прежняя карточка не доходили до terminal text | typed coverage/conflict/exhaustion validation, preliminary downgrade, card parity | назвать decisive missing facts и полезный предварительный вывод | web result `{coverage[], facts[], conflicts[], outcome, sourcesExhausted, sourceAttempts[]}` |
| H6 auth→mutation TOCTOU | Не semantic defect | Между route guard и write могла закрыться/истечь сессия | same-statement capability/session lock; close/final CAS | ничего | repository command включает `{sessionId, visitorCapability}` и для turn writes owner fence |
| H7 source authority | Self-reported tier/confidence модели становился authority | Реальный hostname/document/source list отсутствовал | requested `action.sources`, approved domain registry, exact URL/model quote | выбрать запросы и интерпретировать подтверждённый факт | descriptor `{url, host, documentKind, tier, authority}`; absent provenance fail-closed |
| S1 keyword intent override | Fragments/keywords переписывали валидный semantic plan | Роль «эти», числа и correction вне полной истории | только schema/tool/business validation | intent, referents, correction, ambiguity, alternatives | `AgentIntentContract` с `productMentions`, `selectionPolicy`, grounding и typed tool requests |
| S2 pre-delta planning | Planner мог продолжить по старому hard state | Текущий negate/supersede/clear не учитывался | version/conflict detection и обязательный replan | новое active need/state delta | ledger delta с typed event operations + plan based on resulting state |
| S3 missing-data exclusion | Код превращал отсутствие характеристики в incompatibility | Было неизвестно, отсутствует факт или доказан conflict | tri-state proof и fail-closed final recommendation | решить, является ли attribute decisive и нужен ли web | requirement proof `{status:'satisfied'|'violated'|'unknown', sources[], needsEvidence}` |
| S4 prior-card amnesia | Fuzzy details failure трактовался как отсутствие товара | Visible product IDs/price выпадали из bounded history | durable referent IDs и exact re-fetch | понять ссылку покупателя «эти две» | product mention `{name, role, evidence}` + selected/rejected product ID operations |

## 16. Остаточные риски после локального исправления

1. Реальная сериализация PostgreSQL locks проверена на локальном PostgreSQL после миграции: отдельные соединения и `FOR UPDATE`-барьеры подтвердили обе очередности close-vs-create, close-vs-feedback, close-vs-final-commit и ownership-change-vs-stale-write; atomic create/replay дополнительно прочитан обратно отдельными запросами. Первый прогон обнаружил старый-snapshot defect, после RED→GREEN close использует pinned transaction и свежий READ COMMITTED snapshot. Это доказывает контракт текущей схемы, но не заменяет post-deploy наблюдение под Railway latency/load.
2. Approved manufacturer domain registry намеренно fail-closed и сейчас покрывает FIRMAN, Honda, Husqvarna и STIHL. Официальные домены других брендов не становятся ложной manufacturer authority, но downgrade-ятся в secondary до добавления проверенного mapping.
3. Development-only dependency tree Promptfoo/HuggingFace/ONNX сохраняет пять High advisory; production dependency tree — 0. Forced breaking downgrade не применён.
4. Credential, случайно отразившийся в закрытом browser-tool output, требует rotation; внешняя security mutation не выполняется без явного разрешения пользователя.
