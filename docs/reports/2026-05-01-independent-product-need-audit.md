# 2026-05-01 — независимый аудит подбора товара по потребности покупателя

## Область аудита

Проверял не общий стиль кода, а способность проекта вести себя как AI-консультант/менеджер БАКАУТ:

- понять озвученную потребность и скрытые критерии;
- отделить текущий запрос от старого контекста;
- правильно выбрать действие: уточнить, подобрать, сравнить, ответить фактом, передать в заявку;
- подобрать товары по каталогу, а не по случайному совпадению слов;
- не показывать неподходящие карточки;
- не расходиться текстом ответа с карточками;
- честно отделять известные факты от предположений.

Не вносил продуктовых исправлений. Этот файл — audit evidence/report.

## Проверенное покрытие

Статически просмотрены:

- `AGENTS.md` — целевая роль AI-менеджера и запрет на костыли.
- `docs/ASSISTANT_BEHAVIOR.md`, `docs/ARCHITECTURE.md`, `docs/EVALS.md` — заявленная модель поведения.
- `src/ai/prompts.ts` — системный промпт, extractor prompt, turn planner prompt, answer context.
- `src/ai/assistant.ts` — основной runtime: need update, turn planning, retrieval, selection, answer generation, card contract.
- `src/ai/needState.ts` — merge/decay состояния потребности.
- `src/ai/turnContract.ts` — отдельный typed turn contract.
- `src/ai/generatorLoadReference.ts` и связанные tests — расчёт потребителей генератора.
- `src/shared/types.ts` — структура CustomerNeedState/ProductSelectionState/ProductSelectionMetadata.
- `tests/*` — покрытие regressions по ранжированию, карточкам, генераторам, turn contract, need state.

Запущены проверки:

```bash
npm test -- --run tests/needState.test.ts tests/turnContract.test.ts tests/generatorLoadReference.test.ts tests/recommendationRanking.test.ts
# PASS: 4 files, 106 tests

npm run typecheck
# PASS

npm test
# PASS: 13 files, 131 tests

npm run build
# PASS

npm audit --omit=dev
# PASS: found 0 vulnerabilities

git diff --check
# PASS
```

Локальный browser/live не завершён: Vite UI на `127.0.0.1:5173` был доступен, но backend `127.0.0.1:3000` не был поднят. Попытка `npm run dev:server` зависла без вывода на этапе старта/миграции, healthcheck не поднялся; процесс был остановлен. Поэтому вывод ниже — repo/static + tests, без нового live-dialogue green.

## Короткий вердикт

Проект заметно сильнее обычного “чатбота по промпту”: в нём уже есть отдельное состояние потребности, LLM-планировщик хода, deterministic selection engine, hard constraints, генераторный load profile, show-more UX и несколько слоёв защиты текста/карточек.

Но система пока не полностью единый AI-менеджер. Главный риск не в отсутствии “интеллекта”, а в том, что несколько слоёв одновременно принимают решение о смысле, подборе, карточках и финальном выводе. Из-за этого часть контрактов протестирована изолированно, но не всегда включена в реальный `generateAnswer` path; часть post-generation логики может подстраивать карточки под уже написанный текст, вместо того чтобы жёстко заставлять текст следовать авторитетной селекции.

## Что уже сильное

### 1. Роль AI-продавца задана правильно, не как скрипт

Evidence:

- `docs/ASSISTANT_BEHAVIOR.md:7-17` задаёт цикл: понять смысл, извлечь явные требования, определить скрытые потребности, обновить ограничения, найти товары/факты, проверить данные, ответить.
- `src/ai/prompts.ts:90-114` требует отвечать как AI-продавец, учитывать историю, явные/скрытые потребности, не смешивать старые требования с новыми, не выдумывать характеристики, не обещать наличие/скидки/доставку.
- `AGENTS.md` прямо запрещает превращать ассистента в набор костылей и требует live-проверку как покупатель.

Оценка: направление верное.

### 2. Есть отдельный semantic planning layer, а не только финальный промпт

Evidence:

- `src/ai/assistant.ts:3166-3265` — `updateNeedState()` вызывает отдельный LLM extractor и мержит `CustomerNeedState`.
- `src/ai/assistant.ts:3268-3364` — `planAssistantTurn()` вызывает отдельный turn planner и возвращает structured plan.
- `src/ai/prompts.ts:144-238` — planner обязан выбрать `action`, `answerMode`, `cardPolicy`, `contextScope`, `searchScope`, `requiredProductTraits`, `selectionState`, `needsWebSearch`, `missingInformation`.

Это правильная архитектурная ось: смысл реплики сначала структурируется, потом runtime выбирает товар и ответ.

### 3. Контекст прошлых требований ослабляется при смене задачи

Evidence:

- `src/ai/needState.ts:264-292` — при `scopeChanged` старые explicit/implicit/constraints/criteria decays, signals ослабляются, selection state мержится с reset.
- `src/ai/assistant.ts:3766-3778` — предыдущий selection state сохраняется только при follow-up, который распознан как продолжение.
- Tests: `tests/needState.test.ts`, `tests/recommendationRanking.test.ts` включают сценарии смены задачи и старых ограничений.

Оценка: хорошая база для контекстной консультации, но см. P1/P2 по конфликтам planner scope.

### 4. Подбор товара не доверен свободному LLM-тексту

Evidence:

- `src/ai/assistant.ts:3367-3393` — retrieval объединяет exact model, text search, supplemental queries, vector search и ранжирование.
- `src/ai/assistant.ts:3432-3569` — `selectProductsForTurn()` строит selection state, hard constraints, source pool, фильтрует по `productMatchesSelectionCriteria`, возвращает matched/visible/hidden/comparison/rejected.
- `src/ai/assistant.ts:2492-2545` — hard violations проверяют класс товара, role, fuel, startType, enclosure, budget, brand, exact model, weight/diameter/power/load.

Это сильная часть: финальная модель не должна сама “придумать” карточки.

### 5. Генераторы проработаны лучше большинства категорий

Evidence:

- `src/ai/generatorLoadReference.ts` + tests — controlled load reference и overlay/enrichment.
- `src/ai/assistant.ts:2291-2347` — load profile строится из explicit/reference/web-average потребителей.
- `src/ai/assistant.ts:3928-3940` — если нет надёжной базы нагрузки/мощности, карточки отключаются и задаётся уточнение.
- `src/ai/assistant.ts:3942-3954` — насос с неизвестной мощностью блокирует финальную рекомендацию.
- Tests: `recommendationRanking.test.ts` покрывает load calculation, non-simultaneous loads, pump risk, cheapest policy, current-selection follow-up.

Оценка: генераторная ветка уже близка к консультанту, особенно после последних исправлений.

### 6. Есть защита соответствия текста и карточек

Evidence:

- `src/ai/assistant.ts:4104-4129` — в answer context передаются `productCardsShown`, `productCardsVisibleFirst`, `productCardsBehindShowMore`, `allSuitableProducts`.
- `src/ai/assistant.ts:4189-4204` — финальному ответу запрещено называть модели вне `productCardsShown`; главный товар должен быть первой видимой карточкой.
- `src/ai/assistant.ts:4351-4367` — после генерации текст санитизируется, repair’ится и пропускается через `enforceAnswerCardContract()`.
- Tests: `recommendationRanking.test.ts` содержит проверки card alignment, uncarded candidates, show-more note, no random fallback cards.

Оценка: нужная защита есть, но она не абсолютная — см. P1-3/P1-4.

## P0 / критические системные риски

### P0-1. Typed turn contract существует и тестируется, но фактически не включён в основной `generateAnswer()` path

Evidence:

- `src/ai/turnContract.ts:111-150` содержит `resolveTurnContract()` с важной бизнес-логикой: lead form, render policy, selected ids, missing info, generator phase confirmation.
- `src/ai/assistant.ts:40` импортирует `resolveTurnContract`.
- `src/ai/assistant.ts:2841-2845` есть `resolveTurnContractForPlan()` wrapper.
- Поиск по runtime показывает, что в `generateAnswer()` contract не создаётся и в `selectProductsForTurn()` передаётся `undefined`: `src/ai/assistant.ts:3833`.
- При этом `selectProductsForTurn()` ожидает optional `contract?: ResolvedTurnContract` и проверяет `contract?.render.cards`, `contract?.selection.selectedProductIds` (`src/ai/assistant.ts:3432-3452`, `3475-3481`, `3489-3491`).
- Tests `tests/turnContract.test.ts` проходят, но это isolated unit-level contract, а не доказательство, что production turn использует этот contract.

Почему это критично для покупателя:

Система имеет правильную идею “единый контракт хода” — что ассистент должен сделать, какие карточки показать, когда suppress, когда ask clarification. Но в основном runtime часть этих решений дублируется вручную, а часть вообще остаётся только в tests/helper. Это прямой риск расхождения: локальный test green по turn contract может не означать, что живой диалог реально соблюдает тот же контракт.

Особенно опасная зона — генераторная фаза 220/380:

- `turnContract.ts` умеет downgrade’ить рекомендацию, если 220 В только inferred, а не явно подтверждено.
- В основном selection path `hasReliableGeneratorSelectionBasis()` (`src/ai/assistant.ts:2479-2485`) проверяет load/profile/power, но не проверяет provenance `singlePhase220 === inferred_from_load`.
- `explicitCriteriaFromTurn()` может поставить `singlePhase220=true` с provenance `inferred_from_load` (`src/ai/assistant.ts:2405-2411`).

Итог: защита “не финально рекомендовать генератор до явного 220/380” есть в typed contract, но основной `generateAnswer()` не обязан её применить.

Рекомендация: ввести `const turnContract = resolveTurnContractForPlan(effectivePlan, ...)` в `generateAnswer()` после purchase/selection adjustments и перед selection/render; затем пропустить его через `selectProductsForTurn`, card selection, answer context и metadata. Убрать дублирующие ручные suppress-правила только после regression/live.

## P1 / серьёзные риски качества подбора

### P1-1. `contextScope=previousSelection` может заблокировать расширение вариантов, даже если покупатель просит “дешевле/лучше/альтернативу”

Evidence:

- Planner prompt правильно различает `searchScope=broadenAlternatives` и `previousSelectionOnly` (`src/ai/prompts.ts:171-176`).
- Но selection layer считает previous-only так: `const previousSelectionOnly = plan.searchScope === 'previousSelectionOnly' || plan.contextScope === 'previousSelection'` (`src/ai/assistant.ts:3474`).
- Если previous ids есть, source pool фильтруется только до них (`src/ai/assistant.ts:3484-3488`).

Почему это важно:

В естественном диалоге покупатель может сказать: “из этих понял, а есть дешевле при тех же нагрузках?” Planner может сохранить `contextScope=previousSelection` как связь с текущими карточками, но поставить `searchScope=broadenAlternatives`. Текущая логика `OR` делает contextScope сильнее searchScope и может не пустить новые товары.

Рекомендация: previous-only должен включаться только при `searchScope === 'previousSelectionOnly'` или при `contextScope=previousSelection` без explicit broaden/replace intent. Если `searchScope=broadenAlternatives`, source pool должен расширяться.

### P1-2. Бюджетная сортировка внутри лимита иногда поднимает более дорогие товары выше дешёвых

Evidence:

- `sortSelectionProducts()` при `budgetMax` и обеих ценах внутри бюджета делает `return bPrice - aPrice` (`src/ai/assistant.ts:2555-2584`, особенно 2561-2568).
- Аналогичная логика есть в structured slice sorting: если оба товара within budget, `return bPrice - aPrice` (`src/ai/assistant.ts:3693-3706`, особенно 3700).
- В проектной памяти/требованиях для генераторов: если бюджет неизвестен и покупатель не отверг дешёвые варианты, suitable results должны идти cheapest-first; если buyer budget-sensitive — дешёвые выше.

Почему это важно:

Покупательская фраза “до 100 тысяч” часто означает верхний предел, а не просьбу показать максимально дорогой вариант внутри предела. Для менеджера правильнее дать “лучший/достаточный” и объяснить компромисс, а не автоматически максимизировать цену до потолка.

Рекомендация: разделить политики:

- `rankingPreference=cheapest` или budget-sensitive -> cheapest-first среди подходящих;
- `balanced` -> score/distance first, price as tie-break;
- explicit “лучше/премиум/с запасом” -> допускается дороже внутри бюджета.

### P1-3. Post-generation card contract может подстроить карточки под текст LLM, а не текст под авторитетную селекцию

Evidence:

- `enforceAnswerCardContract()` вызывается после генерации ответа (`src/ai/assistant.ts:4351-4367`).
- Card contract получает answer + current cards + productsForCardSelection и может менять cards.
- В metadata сохраняются diagnostics, но нет hard fail/regeneration при `firstCardAligned=false` или спорных claims (`src/ai/assistant.ts:4393-4411`).
- По независимой инспекции: логика contract alignment вокруг упомянутых товаров может добавить/переупорядочить card-worthy products из pool, если LLM назвал их в тексте.

Почему это важно:

Для AI-менеджера авторитетом должна быть селекция по потребности и каталогу. Если финальный LLM случайно назвал не первый/не лучший товар, безопаснее чинить текст или регенерировать краткий вывод, чем расширять/переставлять UI под текст.

Рекомендация: сделать contract enforcement однонаправленным: selection/card set authoritative -> answer repair/regenerate. Добавление новых карточек по тексту разрешать только для exact model fact-answer, но не для recommendation turns.

### P1-4. Card/answer validator проверяет модели, но не валидирует все фактические claims

Evidence:

- Ответ санитизируется и чистится от visible links (`src/ai/assistant.ts:4351-4354`).
- Есть `ConsistencyGuard` после сохранения (`src/ai/assistant.ts:4426-4430`), но он только предупреждает в console.
- `cardContract` diagnostics сохраняются в metadata (`src/ai/assistant.ts:4409-4411`), но не блокируют ответ.
- Web search включается по planner/factual conditions (`src/ai/assistant.ts:1447-1461`, `3996-4004`), но если LLM внутри обычного recommendation текста сделает сравнительный claim по шуму/THD/расходу, runtime не валидирует это поле как hard fact.

Почему это важно:

Текст может быть “похож на менеджера”, но содержать неверное заключение: “тише”, “лучше для электроники”, “экономичнее”, “подойдёт”, “есть запас” — без подтверждённой характеристики. Для покупателя это хуже, чем неправильная карточка.

Рекомендация: добавить claim-level gate для recommendation answer: извлечь claims по ключевым осям (power fit, price, noise, inverter/THD, fuel, start, enclosure, availability) и проверять их против card specs/selection metadata/web verified facts. Непроверенные technical superiority claims либо удалять, либо маркировать как предположение.

### P1-5. `findStructuredCatalogSlice()` выглядит как устаревший/мёртвый параллельный selection path

Evidence:

- `src/ai/assistant.ts:3572-3752` содержит крупный метод `findStructuredCatalogSlice()`.
- Поиск по `findStructuredCatalogSlice(` в `src/ai/assistant.ts` показывает только его объявление; `generateAnswer()` строит `structuredCatalogSlice` из `selectionResult`, а не через этот метод (`src/ai/assistant.ts:3842-3866`).

Почему это важно:

Это не buyer-facing баг сам по себе, но это симптом того, что selection architecture росла слоями. Мёртвые/параллельные механизмы увеличивают риск, что tests или будущие фиксы будут цепляться за неиспользуемый путь.

Рекомендация: либо удалить метод после подтверждения, либо вернуть в явный pipeline и покрыть integration tests. Сейчас лучше удалить/архивировать, чтобы не поддерживать ложный контракт.

## P2 / вторичные, но важные замечания

### P2-1. `heuristicNeedUpdate()` не используется как fallback

Evidence:

- `src/ai/needState.ts:299-384` содержит heuristic extractor.
- Поиск по `heuristicNeedUpdate` показывает только экспорт/объявление.
- При сбое AI need extraction `updateNeedState()` возвращает current state без применения heuristics (`src/ai/assistant.ts:3259-3265`).

Риск:

При временном сбое planner/extractor бот продолжит искать по тексту текущего сообщения, но долговременное состояние потребности не обновится. В многоходовом диалоге это ухудшает контекст.

Рекомендация: в fallback merge’ить `heuristicNeedUpdate(userMessage)` с current state, но только как low-confidence update.

### P2-2. Финальный answer context для обычных turns сжимает историю до 4 последних сообщений

Evidence:

- `src/ai/prompts.ts:3-11` задаёт compact history limits.
- `buildAssistantContext()` берёт последние 4 сообщения (`src/ai/prompts.ts:241-285`).
- `generateAnswer()` для обычных recommendation turns использует compact mode (`src/ai/assistant.ts:4093-4103`).

Риск:

Если buyer возвращается к условию, сказанному 5-8 реплик назад, финальный answer LLM может видеть только summary + state, а не исходную формулировку. Это нормально для экономии токенов, но повышает важность качества `needState` и `historySummary`.

Рекомендация: для turns с `contextScope=fullSession` или conflict/objection включать expanded history; для “первый/второй/из этих” сохранять compact previous-selection evidence в state.

## Статус тестового покрытия

Сильное покрытие:

- `tests/recommendationRanking.test.ts` — 94 теста по ranking/card/product selection, включая current selection, card caps, exact model, category switch, generator loads, pump, show-more.
- `tests/turnContract.test.ts` — базовый typed contract.
- `tests/generatorLoadReference*.test.ts` — static/dynamic load reference.
- `tests/needState.test.ts` — базовая extraction/decay логика.
- Full suite: 131/131 passed.

Пробелы покрытия:

1. Нет integration test, который доказывает, что `resolveTurnContract()` реально применяется внутри `generateAnswer()`.
2. Нет теста на конфликт `contextScope=previousSelection` + `searchScope=broadenAlternatives`.
3. Нет claim-level теста: LLM/repaired answer не должен утверждать noise/THD/consumption/availability/fit без evidence.
4. Browser/live проверка не выполнена в этом аудите из-за недоступного backend.

## Приоритетный план исправлений

### Stage 1 — включить единый turn contract в runtime

Цель: убрать расхождение “contract tests green, generateAnswer может идти мимо”.

Минимум:

- создать contract в `generateAnswer()` после effectivePlan/purchase adjustments;
- передать contract в `selectProductsForTurn()`;
- использовать contract для card render policy, selected ids, lead form, phase confirmation;
- добавить integration regression: inferred 220 from home load + calculated load не показывает финальные generator cards до явного 220/380.

### Stage 2 — исправить scope precedence

Цель: если покупатель просит дешевле/лучше/альтернативы, previous context остаётся якорем, но не клеткой.

Минимум:

- `previousSelectionOnly` не должен включаться одним `contextScope=previousSelection`, если `searchScope=broadenAlternatives`;
- regression на “из этих понял, а есть дешевле?” с новым товаром в каталоге.

### Stage 3 — бюджетная политика ранжирования

Цель: не максимизировать цену до бюджета без явного запроса premium.

Минимум:

- cheapest/budgetSensitive -> price ascending;
- balanced -> score/distance then price;
- premium/запас/проф -> допускает price descending внутри лимита;
- regression на генератор/виброплиту “до N, без требования premium”.

### Stage 4 — сделать answer/card contract однонаправленным

Цель: карточки авторитетны, текст подчиняется карточкам.

Минимум:

- для recommendation turns запретить добавлять новые cards только потому, что LLM назвал товар в тексте;
- если текст назвал не-card product, repair/regenerate text;
- diagnostics mismatch -> warning + fallback answer, а не молчаливое изменение UI.

### Stage 5 — claim-level factual gate

Цель: верные заключения, а не только верные модели.

Минимум:

- извлекать и проверять claims: подходит/не подходит, запас мощности, дешевле/дороже, тише, инвертор/THD, наличие/доставка/скидка;
- непроверенные comparative claims удалять или маркировать как “по общему классу, точное значение надо проверить”.

## Итог

На уровне кода проект уже движется в сторону реального AI-менеджера: state, planner, selection engine, load profile, card/answer guardrails и тесты есть. Но “единый менеджер” пока не полностью собран: typed turn contract не интегрирован в основной ход, context/search scope могут конфликтовать, бюджетное ранжирование может вести себя не как покупатель ожидает, а post-generation contract иногда может подстраивать карточки под LLM-текст.

Самая важная следующая работа — не добавлять новые trigger-word patches, а замкнуть runtime вокруг одного turn contract и сделать selection/card set авторитетным источником для финального ответа.
