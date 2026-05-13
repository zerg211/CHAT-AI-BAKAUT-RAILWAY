# План исправления LLM-first подбора и показа карточек

Дата: 2026-05-13

## Цель

Перестроить подбор так, чтобы смысл диалога определяла LLM, а код только исполнял проверяемые операции: хранение состояния, нормализацию структур, расчет, поиск по каталогу, фильтрацию, guardrails и проверку фактов.

Проблема текущей архитектуры: рядом с LLM-планировщиком остались старые regex/heuristic слои, которые местами сами решают намерение покупателя, активную потребность, hard constraints, web search, уточняющие вопросы и момент показа карточек. Это создает "split brain": LLM может понять ход правильно, но код потом переопределяет смысл.

## Принцип исправления

- LLM решает смысл: что хочет покупатель, какая активная потребность, какие требования жесткие, какие мягкие, что изменилось, какие карточки уместны сейчас.
- Код проверяет факты: каталог, характеристики, цены, 220/380, мощность, роль товара, бизнес-ограничения, соответствие текста карточкам.
- Regex допустим только как parser/normalizer/retrieval hint/fact guard, но не как источник финального решения о смысле диалога.

## Обязательная проверка

Любое изменение поведения после реализации этого плана проверяется только через встроенный виджет чата на `https://bakautprof.ru/`.

Проверки через `localhost`, локальный iframe или прямой API не считаются валидной live-проверкой. Протокол сохранять в `local-live-tests/*.production.md` или другом `.md` файле с явным указанием, что проверка была через виджет на `bakautprof.ru`.

## План по 12 проблемным местам

### 1. `src/ai/needState.ts` - `heuristicNeedUpdate`

Проблема: regex сам создает потребности, ограничения, скрытые сигналы и может записывать их в память.

Исправление:
- убрать из обычного production-flow запись результата `heuristicNeedUpdate` в `needState`;
- оставить только как debug/emergency artifact без влияния на карточки и долговременную память;
- если LLM need extraction не вернул структуру, делать retry structured extraction;
- если retry не помог, возвращать безопасный текстовый fail-safe без подбора и без изменения памяти.

Результат: потребности фиксирует LLM, а не regex.

### 2. `src/ai/needState.ts` - `activeNeedsFromMessage`

Проблема: код по словам решает активную потребность: генератор, виброплита, доставка и т.д.

Исправление:
- перенести active needs в LLM `RequirementLedger`;
- код хранит только структуру: `needId`, `productClass`, `status`, `constraints`, `openQuestions`, `selectedProductIds`;
- не создавать/переключать active need по regex;
- старые active needs обновлять только если LLM явно указала продолжение, смену или возврат к потребности.

Результат: разные темы диалога не смешиваются из-за совпадения слов.

### 3. `src/ai/assistant.ts` - `fallbackTurnPlan`

Проблема: если LLM-план сломался, код сам выбирает `action`, `answerMode`, `cardPolicy`, `followUpPolicy`.

Исправление:
- заменить semantic fallback на retry LLM planner;
- без валидного `agentDecision` не выполнять подбор, не показывать карточки и не менять память;
- fail-safe ответ должен быть текстовым и честным: попросить переформулировать или уточнить, без каталожных утверждений.

Результат: без LLM-контракта бот не делает смысловых действий.

### 4. `src/ai/productClassifier.ts` - `inferProductIntent`

Проблема: функция по словам определяет тип товара и может влиять на финальный подбор.

Исправление:
- переименовать/разделить роль на `inferRetrievalHint`;
- использовать только для первичного поиска кандидатов и диагностики;
- финальный `productIntent` брать только из LLM contract / requirement ledger;
- добавить guard: если hint конфликтует с LLM intent, побеждает LLM intent.

Результат: regex помогает найти кандидатов, но не решает смысл диалога.

### 5. `src/ai/assistant.ts` - `buildProductFitProfile`

Проблема: функция смешивает LLM traits, старое состояние и regex из текста, из-за чего может додумать бензин/дизель/220/инвертор/тип товара.

Исправление:
- строить fit profile только из нормализованных LLM constraints и проверенных catalog facts;
- убрать самостоятельное извлечение hard constraints из текста;
- старое состояние использовать только если LLM явно вернула `contextScope=activeNeed` или `previousSelection`;
- regex-derived поля оставить только как retrieval hints с низким приоритетом.

Результат: профиль подбора не загрязняется старым диалогом и не придумывает требования.

### 6. `src/ai/assistant.ts` - `explicitCriteriaFromTurn`

Проблема: код сам строит hard constraints из фразы: мощность, бюджет, 220 В, кожух, инвертор, модель.

Исправление:
- заменить на `criteriaFromRequirementLedger`;
- вход: готовые LLM requirements;
- код только нормализует числа, enum, provenance и диапазоны;
- если LLM не указала constraint, код его не добавляет;
- regex может использоваться только для валидации формата внутри уже заявленного LLM constraint.

Результат: hard constraints задает LLM, код только приводит их к безопасному формату.

### 7. `src/ai/assistant.ts` - `generatorLoadProfileFromText`

Проблема: код сам интерпретирует нагрузки: насос, холодильник, свет, болгарка, одновременный запуск.

Исправление:
- LLM выделяет `loadItems`: что подключается, мощность, источник, уверенность, одновременно/не одновременно;
- код только считает сумму, пусковую нагрузку, запас и минимальную мощность;
- если данных мало, код возвращает `loadUncertainties`;
- LLM решает, задавать уточнение сейчас или дать предварительный подбор.

Результат: расчет остается deterministic, но смысл нагрузки определяет LLM.

### 8. `src/ai/assistant.ts` - `isCatalogShortlistTurn`

Проблема: regex решает, это каталоговый подбор, проверка наличия или другой тип вопроса.

Исправление:
- заменить production-использования на `agentDecision.catalogAction`;
- поддерживать значения: `none`, `exact_model_lookup`, `find_matching_products`, `verify_catalog_absence`;
- regex оставить только как diagnostic mismatch detector.

Результат: каталоговый режим выбирает LLM.

### 9. `src/ai/assistant.ts` - `shouldForceStructuredSelectionCards`

Проблема: код может включить карточки вопреки плану.

Исправление:
- карточки включает только LLM через `cardsRole` и `productCardsPolicy`;
- catalog executor подтверждает, что есть валидные карточки;
- если карточки невалидны, код блокирует показ и возвращает причины;
- убрать semantic override, где код сам решает "пора показывать".

Результат: код не решает уместность карточек, а только проверяет возможность их безопасного показа.

### 10. `src/ai/assistant.ts` - `selectionResultCanDriveCards`

Проблема: результат подбора может сам протолкнуть карточки при `answer_question` или `ask_clarifying_question`.

Исправление:
- убрать card-promotion на основании эвристики результата;
- catalog executor возвращает `matches`, `rejections`, `uncertainties`, `confidence`;
- LLM получает этот результат и решает: показать карточки, ответить текстом или задать уточнение.

Результат: карточки появляются по решению LLM, а не потому что код увидел подходящие товары.

### 11. `src/ai/assistant.ts` - `shouldPromoteGeneratorSizingCards`

Проблема: regex решает, пора ли показывать генераторы после расчета нагрузки.

Исправление:
- после расчета нагрузки делать LLM readiness-decision;
- LLM возвращает одно из: `showPreliminaryCards`, `askCriticalQuestion`, `answerCalculationOnly`;
- код блокирует карточки только при фактическом риске: нет фазы, нет мощности критичной нагрузки, нет валидных товаров, конфликт каталога.

Результат: бот показывает карточки вовремя, но не раньше, чем это уместно по консультации.

### 12. `src/ai/assistant.ts` - `shouldUseWebSearch`, `shouldUseDetailedFactStyle`, `missingQuestionsForSelection`

Проблема: код сам решает web search, глубину ответа и уточняющие вопросы.

Исправление:
- LLM contract должен вернуть:
  - `needsExternalVerification`;
  - `answerDepth`;
  - `mustAnswerNow`;
  - `clarifyingQuestions`;
  - `clarifyBeforeCards`;
  - `externalFactsNeeded`;
- код возвращает только фактические неопределенности: нет specs, нет voltage, нет цены, нет exact model, конфликт каталога;
- LLM решает, спрашивать сейчас или сначала дать полезный ответ/карточки.

Результат: LLM управляет диалогом, код сообщает только проверяемые пробелы в данных.

## Новая целевая архитектура

### 1. LLM `RequirementLedger`

Структура должна хранить:
- active needs;
- current focus;
- hard constraints;
- soft preferences;
- changed/superseded requirements;
- mentioned products and their roles;
- load items;
- clarification strategy;
- card strategy;
- external verification needs.

### 2. `CatalogExecutor`

Вход:
- `RequirementLedger`;
- hard constraints;
- catalog action;
- requested card policy.

Выход:
- `matches`;
- `rejections` с причинами;
- `uncertainties`;
- `catalogCompletenessWarnings`;
- `safeToShowCards`;
- `blockedCardReasons`.

Executor не решает, уместны ли карточки в диалоге. Он только говорит, можно ли их безопасно показать по фактам.

### 3. `AnswerOrchestrator`

Вход:
- LLM contract;
- результат `CatalogExecutor`;
- business guards;
- history summary.

Задача:
- собрать финальный answer context;
- не дать тексту противоречить карточкам;
- не обещать наличие, доставку, скидки, сроки;
- не показывать карточки, если executor их заблокировал.

## Каталоговая отдельная проблема

По проверке проектной БД под запрос `ТСС + бензин + 8-10 кВт + 220 В` сейчас проходит только `ТСС SGG 10000EI (9,0 кВт)`.

`ТСС SGG 10000EHA / 190009` в проектной БД не найден. Если он есть на сайте, это не ошибка LLM-подбора, а проблема полноты/sync каталога. Нужно добавить отдельный audit:
- сверять товары сайта и БД;
- ловить отсутствующие артикулы;
- заполнять структурные specs: `brand`, `fuel`, `nominalKw`, `maxKw`, `phase`, `voltage`, `inverter`, `startType`, `article`, `sourceUrl`, `specConfidence`.

## Порядок реализации

1. Добавить schema для `RequirementLedger`.
2. Расширить prompt need extraction / planner, чтобы LLM возвращала ledger и card strategy.
3. Перевести active needs и semantic memory на ledger.
4. Заменить `explicitCriteriaFromTurn` на `criteriaFromRequirementLedger`.
5. Ограничить `inferProductIntent` и другие regex-функции ролью retrieval hint.
6. Вынести расчет нагрузок: LLM выделяет `loadItems`, код считает.
7. Ввести `CatalogExecutor`.
8. Убрать semantic card-promotion из `shouldForceStructuredSelectionCards`, `selectionResultCanDriveCards`, `shouldPromoteGeneratorSizingCards`.
9. Перевести web search/detail/clarifying questions на поля LLM contract.
10. Добавить unit/eval тесты на каждый мигрированный участок.
11. Добавить catalog completeness audit для TSS 10 кВт и аналогичных exact model gaps.
12. Провести production widget live-проверку через `bakautprof.ru` и сохранить протокол.

## Критерии готовности

- В production-flow нет записи regex-derived needs как финального смысла диалога.
- Без валидного LLM contract бот не делает подбор и не показывает карточки.
- Hard constraints приходят из LLM ledger, а не из `explicitCriteriaFromTurn`.
- Catalog executor показывает все подходящие товары и объясняет все отказы.
- Код может блокировать карточки по фактам, но не решает вместо LLM, когда они уместны.
- Уточняющие вопросы выбирает LLM на основании uncertainties.
- Проверка проведена через виджет на `bakautprof.ru`, не через localhost.

## Дополнение 2026-05-13: exact model lookup и роль AI-менеджера

Новая ошибка из production-диалога: на вопрос `BISON 3250 есть у вас?` LLM нашла близкий товар `BISON BS3250i`, но contract разрешил `productCardsPolicy=none`, а card executor отбрасывал близкую модель из-за точного несовпадения `BISON 3250` vs `BS3250i`. В результате покупатель видел тупик: "точной модели нет, есть близкий вариант, но это другая модель" без карточки и без нормального вопроса "эту модель имели в виду?".

Исправление:
- если `catalogAction=exact_model_lookup` и LLM выбрала близкий `selectedProductIds`, contract repair переводит карточки в `productCardsPolicy=supporting_only`, `cardsRole=supporting`;
- при exact lookup selected-кандидат проходит deterministic проверку по всем hard constraints, кроме точного написания модели, чтобы показать близкую карточку как альтернативу, а не как точное совпадение;
- answer guidance требует предложить близкую модель и спросить, ее ли покупатель имел в виду;
- старые buyer-facing формулировки `менеджер подтвердит/проверяет` заменены на первую персону AI-менеджера: `вижу`, `сверю`, `проверю`, `посчитаю через логистику`;
- frontend при recovery stream очищает частичный assistant bubble перед повторной отдачей ответа, чтобы покупатель не видел один и тот же текст два раза.

Локальная проверка после исправления:
- `npm.cmd test -- tests/agentTurnContract.test.ts tests/recommendationRanking.test.ts tests/prompts.test.ts` — PASS;
- `npm.cmd test` — PASS, 19 файлов, 240 тестов;
- `npm.cmd run build` — PASS.

Production readiness: требуется деплой и живой прогон через виджет `https://bakautprof.ru/` с ручным аудитом ответа покупателя и metadata/code-аудитом. Без этого изменение не считается подтвержденным в production.

## Дополнение 2026-05-13: повторный BISON-аудит после деплоя

Живой прогон через виджет `https://bakautprof.ru/` показал частичный PASS и одну оставшуюся ошибку:

- видимый ответ больше не дублировался;
- формулировка `менеджер должен подтвердить` ушла, ответ говорил от лица AI-менеджера: `Актуальный склад и возможность отгрузки сверю перед оформлением`;
- но карточка `BISON BS3250i` не была показана, потому что LLM снова поставила `catalogAction=verify_catalog_absence`, `productCardsPolicy=none`, `cardsRole=none` и не заполнила `selectedProductIds`, хотя в тексте упомянула `BS3250i`.

Второе исправление:
- `selectProductsForTurn` теперь при exact availability / catalog absence и model tokens ищет close same-brand/model-token alternatives в каталоге;
- если точное написание не подтверждено, но найден близкий кандидат той же марки и класса, selection executor возвращает его как `exactLookupAlternative`, не как точное совпадение;
- `shouldPromoteCatalogFactCheckedCards` разрешает показать такие карточки как supporting alternatives даже если LLM забыла card policy;
- card selection теперь допускает selected alternatives и для `verify_catalog_absence`, не только для `exact_model_lookup`;
- answer guidance требует: сказать, что точной карточки не видно, показать близкую карточку и спросить, ее ли покупатель имел в виду.

Повторная локальная проверка:
- `npm.cmd test -- tests/recommendationRanking.test.ts tests/agentTurnContract.test.ts tests/agenticCycle876.test.ts` — PASS;
- `npm.cmd test` — PASS, 19 файлов, 241 тест;
- `npm.cmd run build` — PASS.

## Дополнение 2026-05-13: дублирование текста в виджете

Повторный BISON-прогон через production widget показал, что DB-ответ хранится один раз, `recovery=false`, но покупатель в виджете видит повтор. Причина не в recovery, а в compact-answer ветке:

- `executeAnswerRequest` для non-stream ответа сразу отправлял raw LLM text через `input.onDelta`;
- затем после `sanitizeVisibleAnswer`, card contract guard и `ensureCommercialManagerVerification` финальный ответ отправлялся второй дельтой;
- база сохраняла только финальный ответ, поэтому backend metadata выглядела чистой, а UI показывал склейку raw+final.

Исправление:
- ранняя отправка raw non-stream ответа удалена;
- в SSE теперь уходит только финальный согласованный ответ после всех проверок.

Проверка после исправления:
- `npm.cmd test -- tests/recommendationRanking.test.ts tests/agentTurnContract.test.ts tests/agenticCycle876.test.ts` — PASS;
- `npm.cmd test` — PASS, 19 файлов, 241 тест;
- `npm.cmd run build` — PASS.

## Дополнение 2026-05-13: ручной аудит #876 после PASS выявил плохой ответ

Автоматический production-прогон #876 прошел, но ручной buyer-view аудит показал, что PASS был недостаточным:

- на ходу `Подберите из наличия ТСС 8-10 кВт 220 и посчитайте доставку до Ейска` карточка была правильная: `ТСС SGG 9000ELA`;
- metadata и specs карточки показывали `число фаз: однофазные`, `напряжение: 230 В`, `мощность номинальная при 220 В: 8 кВт`;
- видимый текст ответа ошибочно сказал: `он трехфазный 230/400 В, не строго однофазный 220 В`;
- в этом же ответе просочилось лишнее давление на контакт: `оставить контакт`, хотя покупатель еще выбирал товар и просил подбор с расчетом доставки.

Причина:
- LLM-contract на этом ходу сам внес неправильный смысл в `mustAnswerNow`: уточнить, подойдет ли трехфазный вариант;
- код показал правильную карточку, но не заблокировал противоречие между видимой карточкой и финальным текстом;
- live-тест проверял фазность в тексте карточек, но не проверял, что сам ответ не противоречит строгому 220 В подбору;
- lead-pressure guard ловил `оставьте контакт`, но не ловил форму `оставить контакт`.

Исправление:
- для `product_selection_with_delivery`, когда покупатель еще выбирает товар, contract repair переводит `offer_contact_after_answer` в `explain_manager_required` и ставит `leadAllowed=false`;
- `repairAnswerForFinalCards` теперь проверяет финальный текст против видимых карточек и чинит ложное утверждение, что однофазная карточка является трехфазной / 230/400 В;
- `stripLeadPressureTail` удаляет и форму `оставить контакт`;
- production live-тест #876 теперь падает, если при строгом 220 В подборе текст ответа сам говорит `трехфазный`, `230/400`, `380/220` и это не фраза про исключение неподходящих товаров.

Ожидаемый результат:
- AI-менеджер отвечает как менеджер БАКАУТ от первого лица;
- карточка и текст больше не расходятся по базовым фактам;
- при подборе с доставкой бот сначала показывает подходящие товары и честно говорит, что доставку посчитает через логистику, без преждевременной просьбы оставить телефон;
- live PASS теперь включает не только факт карточек, но и buyer-view проверку смысла ответа.
