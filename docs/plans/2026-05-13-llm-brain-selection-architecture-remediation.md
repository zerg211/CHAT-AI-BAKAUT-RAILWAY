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
