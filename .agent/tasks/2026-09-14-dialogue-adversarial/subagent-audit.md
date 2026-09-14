# Независимый аудит production-диалога №2185

Дата аудита: 2026-09-14. Проверенный артефакт: одна непрерывная production-сессия `dfd011fd-89e3-4cd4-965d-c43af4d346d6` на `https://bakautprof.ru/`, 10 покупательских ходов, 7 ответов, 3 хода без ответа. Текущий код: `main` / `4a8edb186ad7086fb2a302782993ff3713141116`.

## Главный вердикт

Финальный видимый ответ стал честным после PR #21–#25, но система пока остаётся частично рабочим агентным гибридом. Она умеет вести контекст, обновлять цены, читать страницы и корректировать ошибку, однако внутреннее состояние систематически выглядит завершённее реального результата. Главный незакрытый риск — `preSendValidation=pass` и `taskOutcome=resolved` не гарантируют, что каждый покупательский факт связан с конкретным подтверждённым значением и что неизвестные атрибуты действительно попали в outcome.

В этом диалоге покупатель затратил семь дополнительных реплик на исправление одного ошибочного сравнения веса/шума. Три из них не получили ответа. Итоговый ответ полезен, но достигнут ценой усилия, которое обычный покупатель почти наверняка не приложит.

## Что подтверждено по спорным значениям

- `89,2 кг` пришло из устаревшего каталожного `specs.weight_kg` FUBAG, `lastSeenAt=2026-04-26`, вложенного в результат `noise_research`. В массиве проверенных web-фактов этого значения не было. Ход 3 представил его как текущую массу и вычислил разницу 24,2 кг — это было необоснованно.
- `93,2 кг` подтверждено текущей страницей БАКАУТ точной модели как `Вес в упаковке, кг`.
- `93,5 кг` дословно найдено на `https://fubag.group/product/bs-8000-a-es/` как `Вес, кг 93.5`. Страница не говорит `нетто`, а значение конфликтует с меньшим упаковочным весом 93,2 кг, поэтому финальный отказ называть 93,5 кг подтверждённой массой нетто корректен.
- `84 дБ` и `72 дБ` дословно присутствуют на страницах точных моделей. Расстояние, нагрузка, режим, стандарт и вид метрики не подтверждены; практическое сравнение и вычитание 12 дБ недопустимы. Ход 4 это правильно исправил.
- `fubag.group` в фактическом tool payload остаётся `sourceAuthority=secondary`, `sourceTier=reliable_secondary`, хотя это официальный домен бренда. Это ошибка классификации источника, а не основание отвергать точную цитату.

## Походовый разбор

| Ход | Покупатель в виджете | Продавец/admin | Что произошло внутри | Вердикт |
|---|---|---|---|---|
| 1 | Получил расчёт рабочей нагрузки 3,2 кВт, предварительный ориентир 3,5 кВт и три модели с честной оговоркой о неизвестном пуске насоса. | Видит тот же полезный ответ и карточки; UI показывает readiness как `ready`. | `calculator.generatorLoad`, catalog и web; web завершился `timed_out`, `sourcesExhausted=false`. `selectionReadiness=ready_for_preliminary_cards` содержит два missing facts, но `taskOutcome=resolved`, `unresolvedFacts=[]`. | Видимый ответ PASS. Внутренний outcome завышен. |
| 2 | Получил актуальные цены 102 139 / 153 208 / 85 370 ₽ и осторожное объяснение различий. | Видит нормальный коммерческий ответ; карточки переиспользованы. | Точные first-party price verifications успешны. Калькулятор пересчитан, хотя профиль нагрузки не изменился. | PASS по содержанию; первый сигнал лишнего повторного calculator. |
| 3 | Увидел 65/89,2 кг и 72/84 дБ, затем категоричный вывод о преимуществе Energo на 24,2 кг и 12 дБ. | Видит `preSendValidation=pass`, `taskOutcome=resolved`; предупреждения не объясняют, что 89,2 — старый каталог, а методики шума несовместимы. | `noise_research` подтвердил внешними цитатами 84, 72 и 65 кг. 89,2 было лишь полем старого catalog product внутри payload. Официальные страницы помечены secondary. Claim-level сверки значения с источником нет; достаточно сослаться на весь request ID. | MATERIAL FAIL. Симптом сравнения исправлен PR #21, общий дефект provenance остаётся. |
| 4 | После возражения получил честное исправление: прямое сравнение дБ невозможно. | Видит PASS/resolved. | Первый web request `failed`, второй вернул числа при `skipped_budget`; оба `sourcesExhausted=false`. Continuation сохранил missing methodology. Калькулятор снова вызван без пользы. | Видимый corrective PASS; outcome снова скрывает незавершённые факты. |
| 5 | Вопрос сохранился, ответа нет; доступен повтор. | В переписке остаётся только новое сообщение покупателя. Техническая причина не связана с ним в admin UI. | После частичного web-результата continuation вызвал first-party reader; failure payload без `canonicalUrl` упал на Zod. Turn=`failed`, `agent_manager_generation_failed`, recoveryAttempts=0. | FAIL; schema-симптом исправлен PR #22. Общий fail-soft дефект остаётся. |
| 6 | После ручного повтора получил честный частичный ответ: 93,2 — упаковка; 89,2 и 93,5 нельзя считать решённой массой нетто; дБ не сравнивать. | Видит PASS/resolved и customerEffortCount=1, хотя это уже второй покупательский ход одной задачи. | Два web research: `timed_out` и `skipped_budget`, `sourcesExhausted=false`; continuation=`stopped`, missingFacts содержит точную массу нетто и методику. `selectionReadiness.not_applicable` тоже содержит missingFacts. Outcome всё равно `resolved`, unresolved пуст. Calculator вызван снова. | Ответ честный, telemetry FAIL. |
| 7 | Отправил две точные ссылки, ответа нет. | Видит ещё одно дублирующее сообщение без явной строки failed turn. | Planner ошибочно отправил `fubag.group` в `site.readFirstPartyPage`, затем Bakaut и web research. Лимит external reads исчерпан; `web_call_budget_exceeded` оборвал весь ход. | FAIL; routing исправлен PR #23. Hard-fail на read-only budget остаётся. |
| 8 | Нажал повтор, снова нет ответа. | В переписке третья копия вопроса; причина доступна лишь в сырых traces. | После denied FUBAG, успешного Bakaut и 52,5 с web сработал лишний injected Bakaut URL из-за `/`; ещё один read превысил лимит и оборвал ход. | FAIL; dedupe исправлен PR #24. Hard-fail и модель retry-effort остаются. |
| 9 | Получил 93,2 как упаковочный вес и честное `93,5 пока не подтверждено`, но только после трёх попыток. | UI не показывает, что внешний FUBAG URL не был прочитан. `taskOutcome=resolved`, хотя toolFailures содержит `source_changed`. | Planner ошибочно выбрал `conversation_only`; FUBAG read был denied, Bakaut read успешен, continuation read=`source_changed`, запрошенный alternative web не выполнился из-за answer reserve. Decision artifact содержит 4 unknowns, taskOutcome — 0 unresolved. | INCOMPLETE; external routing исправлен PR #25, outcome/admin не исправлены. |
| 10 | После прямого указания использовать внешний поиск получил корректный итог: 93,5 не маркировано net, 93,2 — упаковка, 84 дБ несопоставимо без методики. | Видит PASS/resolved. Из обычных flags не узнаёт, что исследование partial/timed_out и источники не исчерпаны. | `web_required`, required web успешен в смысле наличия usable evidence. Но payload: `researchOutcome=partial`, `searchDisposition=timed_out`, `sourcesExhausted=false`, 13 unconfirmedFacts; continuation имеет 2 missingFacts. FUBAG классифицирован secondary. Outcome снова `resolved`, unresolved пуст, effort=1. | Видимый PASS для узкого безопасного вывода; системный PASS не доказан. |

## Findings

### H1 — `taskOutcome` противоречит реальным unknowns и research status

Severity: **High**.

Evidence:

- Ход 6: continuation=`stopped` с четырьмя missing facts, web `timed_out/skipped_budget`, а outcome=`resolved`, unresolved=[].
- Ход 9: decision artifact содержит 4 unknowns и tool failure `source_changed`, outcome=`resolved`.
- Ход 10: `researchOutcome=partial`, `searchDisposition=timed_out`, `sourcesExhausted=false`, 13 `unconfirmedFacts`, continuation с двумя missing facts, но outcome=`resolved`.
- Ход 1 также теряет missing facts предварительного подбора.

Root cause:

- `src/ai/agentManagerOrchestrator.ts:3776-3787` передаёт unresolved facts только когда `finalAnswerContract.selectionReadiness.status === 'needs_more_info'`. В технических ответах writer ставит `not_applicable`, хотя `missingFacts` заполнен, поэтому они исчезают.
- `src/ai/taskOutcome.ts:120-143` считает turn resolved, если явный `input.unresolvedFacts` пуст. Он не понимает `researchOutcome`, `searchDisposition`, `sourcesExhausted`, coverage и continuation.
- `policyGateEnforcement.failedRequiredTools` в `agentManagerOrchestrator.ts:3741-3757` считает required tool успешным по верхнему `status=ok`, даже если его payload partial/timed_out.

Универсальное исправление:

1. LLM определяет цель, семантические fact slots и формулирует полезный ответ.
2. Код строит deterministic `TaskCoverage`: requested slots → confirmed / contradicted / not_confirmed, опираясь на tool coverage, continuation и validated facts.
3. `resolved` допустим только когда все обязательные slots текущей цели закрыты либо цель явно сформулирована как `safe_conclusion_from_available_evidence` и этот bounded conclusion полностью доказан. Unknowns не должны исчезать из-за `selectionReadiness=not_applicable`.
4. `partial/timed_out/failed/aborted/skipped_budget` при `sourcesExhausted=false` должен сохранять unresolved slots и `partially_resolved`, даже если верхний tool status=`ok`.

Acceptance:

- Unit fixture как ход 10: один confirmed noise fact + `researchOutcome=partial`, `timed_out`, `sourcesExhausted=false`, `unconfirmedFacts=[weight_net]`; ожидать `partially_resolved`, unresolved `weight_net`, без handoff.
- Fixture как ход 9: один successful first-party result + required external denial/error; outcome не `resolved`.
- Fixture полного bounded вопроса: exact label и отсутствие `net` доказаны одной страницей; статус может быть resolved только для цели «что написано на странице», при этом глобальная масса нетто остаётся отдельным unresolved fact в ledger.
- Live: admin outcome согласуется с visible caveat и research metadata.

### H2 — проверяется существование source ID, а не связь конкретного claim/value с доказательством

Severity: **High**.

Evidence:

- Ход 3: `factsUsed.fubag_weight_kg=89.2` ссылается на `noise_research`. Этот request содержит старый catalog product с 89,2, но проверенные внешние facts содержат только 84, 72 и 65. Ответ представил 89,2 как актуальную массу без freshness/conflict qualification.
- Ход 10: answer использует отдельные semantic claims из `answerGuidance.coverage`, но `factsUsed` ссылается только на весь `web_fubag_weight_noise`; final `facts[]` содержит лишь 84 дБ. Audit не может доказать claim-by-claim, откуда взяты label 93,5 и упаковочные 93,2.
- Несмотря на это, оба ответа получили `preSendValidation=pass`.

Root cause:

- `src/ai/agentManagerContracts.ts:544-561`: fact хранит свободный `factKey`, `value` и массив широких `sourceEventIds`; нет source path/evidence item ID.
- `src/ai/agentManagerReleaseValidator.ts:537-565`: валидатор проверяет только, что ID существует и весь tool result способен ground facts.
- `src/ai/agentManagerModelAdapter.ts:830-833`: любой `web.researchProductFacts status=ok`, кроме `not_needed`, считается fact-bearing, включая partial/timed_out payload.

Универсальное исправление:

- LLM возвращает semantic claim и binding к структурированной единице доказательства: `toolRequestId + evidenceItemId/coverageSlot/catalogProductId+attribute`, а не только к request ID.
- Код разыменовывает binding, сверяет exact product identity, normalized attribute/value/unit, freshness и conflict status. Неподтверждённое отсутствие оформляется как coverage `not_confirmed`, а не как confirmed fact.
- Проза остаётся у LLM; доказуемость значения, принадлежность модели и конфликт — deterministic.

Acceptance:

- Claim `89.2` не проходит, если binding указывает на web result, где exact validated fact отсутствует или catalog version stale/conflicted.
- Подмена 89.2 → 88.1 при том же request ID блокируется.
- 93.2 проходит только через exact Bakaut product/spec field `вес в упаковке`.
- 93.5 проходит как `published_weight_label`, но не как `weight_net_kg`.
- Pre-send validator выводит точный issue code и evidence path.

### H3 — превышение бюджета read-only инструментов оставляет покупателя без полезного частичного ответа

Severity: **High**.

Evidence:

- Ходы 7 и 8: уже имелся успешный Bakaut read и/или завершившийся research, но следующий external read превысил `maxWebCalls`; весь ход стал failed, assistant message не сохранён.
- Ход 5: после usable частичного web результата schema failure дополнительного reader тоже уничтожил весь ответ.
- `src/ai/agentManagerTurnBudget.ts:289-297` бросает исключение при превышении, `agentManagerOrchestrator.ts:2290-2305` помечает turn failed и rethrow; `src/routes/chat.ts:343-378` отправляет только общий error.

Универсальное исправление:

- До исполнения детерминированно планировать bounded read schedule, дедуплицировать и резервировать writer budget.
- Для read-only excess/timeout/schema-malformed сохранять non-fact-bearing result и переходить к compose с уже подтверждёнными фактами и точным gap. Не делать fail whole turn, если есть хоть один пригодный evidence artifact или можно дать честный bounded ответ.
- Hard failure оставить для невозможности сформировать безопасный ответ и для неопределённого состояния side effect; read-only search не относится к side effect.

Acceptance:

- Три легитимных external reads при лимите два: третий получает budget-stopped artifact, покупатель получает частичный ответ, turn=`completed`/outcome=`partially_resolved`.
- Malformed continuation после usable evidence не удаляет ответ.
- Никакой факт не может ссылаться на budget-stopped result.
- Live: один ход с заведомо широким исследованием завершается ответом, без кнопки повторного усилия.

### H4 — официальный домен производителя классифицируется как secondary

Severity: **High** из-за влияния authority на conflict resolution, confidence и очередность tiers.

Evidence:

- В ходах 3, 4, 6 и 10 `https://fubag.group/product/bs-8000-a-es/` сохраняется как `sourceAuthority=secondary`, `sourceTier=reliable_secondary`.
- Ход 10 сначала теряет 24 секунды на `official_page` timeout, а точную страницу FUBAG принимает в стадии `official_manual`; итоговый source attempt всё равно не отражает официальный page.
- `src/ai/productComparisonResearch.ts:758-810` имеет статический список только Firman/Honda/Husqvarna/Stihl; Fubag отсутствует.

Универсальное исправление:

- Вынести exact-host manufacturer registry в курируемые данные/конфигурацию с brand aliases и audit trail. `fubag.group` должен быть seed entry для Fubag.
- LLM может предложить publisher relation и exact quote, но код присваивает authority только через exact host/subdomain binding из registry либо через отдельную проверяемую publisher identity с сохранённым evidence.
- URL path/title не должны сами повышать authority.

Acceptance:

- `Fubag` + `fubag.group` и региональный subdomain → manufacturer/official_page.
- Lookalike `fubag.group.example` и сторонний магазин → secondary.
- Official product page выигрывает у stale catalog conflict и не тратит secondary tier, если requested slots закрыты.
- SourceAttempts отражает реальный официальный page, а не unrelated `official_manual`.

### M1 — неизменный generator load пересчитывается в технических follow-up и загрязняет readiness

Severity: **Medium**.

Evidence:

- Calculator вызывается в ходах 2, 3, 4, 5, 6 и 9, хотя после хода 2 покупатель спрашивал только вес, шум и источники и не менял нагрузку.
- Grounding технического хода 9 содержит required `calculator.generatorLoad`; selection policy остаётся `final_fit/reusePreviousCards`, хотя planner пишет, что это не новый подбор.
- Из-за калькулятора card readiness хода 9 становится `blocked_by_tool_safety: generator_load_unconfirmed_basis`, хотя карточки вообще не запрашивались. Это ложный admin signal и лишние budget/tool artifacts.

Root cause: structured `generator_load_scenario` живёт как hard selection requirement и planner повторно связывает его с current-turn typed tool даже когда current task не selection. Система смешивает durable need state и evidence, которое требуется именно сейчас.

Универсальное исправление:

- LLM выбирает current task/need action и помечает, влияет ли реплика на нагрузочный сценарий.
- Код переиспользует прежний calculator artifact по fingerprint входных loads. Новый call нужен только при изменении входов или новом решении о пригодности/карточках.
- Для `technical_answer` без card/catalog action selection policy не должна вызывать card readiness и calculator.

Acceptance:

- После сохранённого расчёта вопрос «из каких источников 72/84 дБ?» выполняет 0 calculator calls, сохраняет нагрузку в ledger и вызывает только evidence tools.
- Изменение мощности/режима инвалидирует fingerprint и вызывает calculator ровно один раз.
- Технический ответ без карточек не получает generator-load card warning.

### M2 — seller/admin UI скрывает failed turns и показывает ложное `ready`

Severity: **Medium**.

Evidence:

- Backend `src/routes/admin.ts:169-192` возвращает `turns` и позволяет traces по turnId.
- Client type `src/client/main.tsx:126-130` не содержит `turns`; detail UI их не рендерит. Поэтому три failed turns видны только как дублированные buyer messages без причины/статуса.
- `AgentTracePanel` (`main.tsx:207-243`) показывает только `traces.slice(0,12)` без группировки/фильтра по ходу, хотя API вернул до 200.
- `adminRuntimeFlags` (`main.tsx:256-336`) не выводит `taskOutcome`, toolFailures, researchOutcome, sourcesExhausted или build SHA; warningCount не считает `metadata.warnings` и tool warnings.
- UI использует legacy `metadata.cardSelection?.readinessBlocked`, которого в текущем сохранённом shape нет. Ходы с `selectionReadiness=blocked_by_answer_contract/tool_safety` поэтому отображаются как `readiness: ready`.

Универсальное исправление:

- Показать timeline turns с completed/partial/failed, errorCode, retry lineage, build SHA и связью с user/assistant messages.
- Отдельным seller summary показывать taskOutcome, unresolved facts, source exhaustion и required tool failures; подробные traces раскрывать по выбранному turn.
- Брать readiness из актуального `metadata.selectionReadiness.status`/`decision.status`; убрать legacy fallback после миграции.

Acceptance:

- Fixture диалога с failed turn между сообщениями: seller видит красную строку хода и error code, а не только две одинаковые реплики.
- Partial final turn показывает `partially_resolved`, `sourcesExhausted=false`, unresolved `weight_net`.
- Component test не показывает `ready` для `blocked_by_answer_contract`.

### M3 — `customerEffortCount` всегда равен 1 и retry создаёт дубликаты вместо одной линии попыток

Severity: **Medium**.

Evidence:

- Ходы 5–9 относятся к одной проверке двух страниц; покупатель отправил один и тот же текст три раза и потом дополнительное уточнение. Каждый сохранённый outcome сообщает `customerEffortCount=1`.
- `src/ai/taskOutcome.ts:47,75` поддерживает входной count, но `agentManagerOrchestrator.ts:3776-3787` его не передаёт; иных producers нет.
- `src/client/main.tsx:1489-1514,1778-1785`: `Спросить снова` вызывает `submitText` с новым `clientMessageId`, немедленно добавляя ещё одну user bubble. Пустая failed assistant bubble затем фильтруется на `main.tsx:1764`.

Универсальное исправление:

- Ввести stable goal/attempt lineage (`goalId`, `retryOfTurnId`) и считать buyer effort детерминированно по persisted turns этой цели.
- Public history группирует повторы как одну реплику с состоянием попыток; admin сохраняет все попытки.
- Основное снижение усилия даёт H3: partial answer вместо failed turn. Retry UI остаётся для реального инфраструктурного сбоя.

Acceptance:

- Два retry одного вопроса: одна user bubble с `attempts=3` в widget, три linked turns в admin, effort=3.
- Новый по смыслу вопрос получает новый goal lineage; решение принимает LLM в structured goal relation, код только хранит и считает.

### M4 — ответ приходит только после длинного полного цикла

Severity: **Medium**.

Evidence: first useful content совпадает с сохранением финального ответа; длительность примерно 141 с (ход 1), 124 с (3), 130 с (4), 134 с (6), 80 с (9), 111 с (10). Ходы 7–8 после ожидания завершились пусто.

Исправление: выполнять независимые official page/manual ветки с ранней отменой после покрытия requested slots, исправить authority H4, убрать calculator M1, сохранять краткий validated partial answer при reserve boundary H3. Не стримить непроверенный draft как факт.

Acceptance: p95 server first useful persisted answer для одного supplied product URL укладывается в установленный SLO; при исчерпании SLO сохраняется partial answer, а не пустой turn.

### L1 — причины карточек не специфичны для каждой модели

Severity: **Low**.

Evidence: три карточки хода 1 имеют один и тот же общий `reasons[]`, в котором перечислены все модели. Покупателю труднее понять компромисс конкретной карточки.

Исправление: LLM возвращает per-product rationale с bindings к конкретным proof; код запрещает reason, который не содержит target product identity или ссылается на факты другого товара.

## Что не является дефектом в этом проходе

- Преждевременного предложения контакта не было. Во всех десяти ходах `leadAllowed=false`, lead action `none`, контакт не просили и заявку не создавали.
- Это правильное поведение при `sourcesExhausted=false`. Guard в `src/ai/agentManagerReleaseValidator.ts:662-687` блокирует технический handoff до доказанного исчерпания источников; его следует сохранить.
- Финальный отказ объявлять 93,5 кг массой нетто и прямое сравнение 84/72 дБ — корректен.
- Текущие цены в ходе 2 подтверждены прямыми first-party reads; бот не обещал наличие, резерв или доставку.

## Граница LLM и deterministic-кода

LLM должна владеть:

- смыслом текущей реплики и тем, продолжает ли она подбор или задаёт отдельный технический вопрос;
- перечнем semantic fact slots, нужных для ответа;
- интерпретацией естественного label в источнике (`Вес, кг` не равен автоматически `масса нетто`);
- полезным предварительным выводом, формулировкой неопределённости и естественным ответом;
- решением о том, изменил ли покупатель потребность, приоритет или допустимость альтернатив.

Deterministic-код должен владеть:

- exact URL routing, host authority registry, first-party boundary и SSRF policy;
- fetch status, budgets, dedupe, retry lineage и fail-soft finalization;
- точным binding claim → product → attribute/value/unit → evidence excerpt/source;
- freshness, conflict ordering, price verification, calculator math и catalog filtering;
- итоговым task coverage/status, подсчётом customer effort и правилом `sourcesExhausted`;
- lead capture/side-effect идемпотентностью и запретом подтверждать передачу до durable success;
- seller/admin отображением фактических backend statuses.

Нельзя исправлять findings regex-правилами по словам `вес`, `шум`, `проверь` или конкретным моделям. Исключение — точный курируемый доменный registry: это проверка происхождения факта, а не семантическое понимание покупателя.

## Приоритет исправления и общий retest

1. H1 + H2: task coverage и claim-level evidence bindings. Без этого зелёные `resolved/pass` не являются доказательством factual correctness.
2. H3: fail-soft для read-only budget/schema failures.
3. H4: manufacturer domain authority registry.
4. M1: reuse calculator evidence и отделение technical task от card readiness.
5. M2 + M3: честная seller timeline и effort/retry lineage.
6. M4/L1 после correctness.

Live retest должен быть новым естественным диалогом через widget после deploy, а не повтором тех же фраз. Покупатель начинает с генератора под нагрузку, затем меняет приоритет на переноску/шум, просит источники и даёт один официальный внешний URL. Проверяются: отсутствие прямого сравнения несопоставимых дБ, корректная authority, отсутствие лишнего calculator в source follow-up, ровно один buyer turn на проверку URL, partial outcome при неполном research, отсутствие формы при `sourcesExhausted=false`, совпадение widget/admin/taskOutcome/traces. Отдельный fault-injection/integration test должен доказать fail-soft; искусственно ломать production live нельзя.
