# 2026-05-01 — план исправления P0/P1 по подбору товара из потребности

## До исправлений: оценка результата

Аудит показал, что проект уже имеет сильную основу AI-консультанта: need state, turn planner, deterministic selection, hard constraints, generator load guards, contract repair карточек/ответа. Но до исправлений есть разрыв между протестированными контрактами и основным runtime.

Оценка до исправлений: НЕ GREEN для live-quality критерия “AI-консультант/менеджер”. Локальные тесты зелёные, но поведенческие гарантии P0/P1 не полностью enforced в `generateAnswer()`.

## P0. Turn contract тестируется, но основной generateAnswer не делает его авторитетным

Root cause:
- `src/ai/turnContract.ts:111-188` содержит важный runtime contract: action, scope, knowledge, selection, render, generator phase downgrade.
- `src/ai/assistant.ts:2841-2845` уже имеет adapter `resolveTurnContractForPlan()`.
- Но `src/ai/assistant.ts:3833` вызывает `selectProductsForTurn(..., undefined, visibleCardLimit)`, то есть selection получает `contract` как `undefined`.
- Далее `src/ai/assistant.ts:3986-3991` вызывает `selectCardsFromPlan(...)`, хотя рядом существует `selectCardsFromTurnContract()` (`src/ai/assistant.ts:3041-3052`).

Buyer-facing риск:
- зелёный `turnContract.test.ts` может не соответствовать живому диалогу;
- generator phase downgrade (“если 220/380 только inferred — спросить, не показывать карточки”) может обойтись основным потоком;
- lead/card/text policy остаётся рассыпанной по нескольким слоям.

Исправление:
1. После финализации `effectivePlan` и deterministic selection overrides пересчитать `turnContract = resolveTurnContractForPlan(effectivePlan)`.
2. Применить contract обратно к `effectivePlan`: `action`, `answerMode`, `followUpPolicy`, `needsWebSearch`, `missingInformation`, `selectedProductIds`, `answerGuidance`, `cardPolicy`.
3. Передать contract в финальную карточную селекцию через `selectCardsFromTurnContract()`.
4. Сохранить diagnostics contract в metadata, чтобы live/debug видел, какие overrides сработали.
5. Добавить regression test, который доказывает: plan с `singlePhase220: true` и provenance `inferred_from_load` через hook contract даёт zero cards и action ask_clarifying_question.

## P1. `previousSelection` слишком сильно ограничивает расширение альтернатив

Root cause:
- `src/ai/assistant.ts:3474` сейчас: `previousSelectionOnly = plan.searchScope === 'previousSelectionOnly' || plan.contextScope === 'previousSelection'`.
- Это смешивает якорь контекста (`contextScope=previousSelection`) с запретом поиска (`searchScope=previousSelectionOnly`).
- Если покупатель говорит “из этих, но есть дешевле/лучше/альтернатива?”, planner может держать контекст previousSelection, но searchScope должен broadenAlternatives.

Buyer-facing риск:
- ассистент не показывает новые более подходящие/дешёвые товары, хотя покупатель явно попросил расширение;
- старый контекст становится клеткой, а не якорем сравнения.

Исправление:
1. В `selectProductsForTurn()` считать previous-selection cage только при `searchScope === 'previousSelectionOnly'`.
2. Для `contextScope === 'previousSelection' && searchScope !== 'previousSelectionOnly'` использовать previous ids только как boost/anchor, но не фильтровать `sourceProducts`.
3. Добавить regression test: current selected две модели, catalog имеет cheaper-new; plan: `contextScope=previousSelection`, `searchScope=broadenAlternatives`, `rankingPreference=cheapest`; expected: cheaper-new появляется первым/в visible, а текущие модели остаются comparison/anchored, не блокируют поиск.

## P1. Бюджетный лимит сортирует самый дорогой товар внутри бюджета выше дешёвого

Root cause:
- `src/ai/assistant.ts:2561-2568`: если обе позиции within budget, comparator возвращает `bPrice - aPrice`.
- `src/ai/assistant.ts:3693-3706`: аналогичная логика в stale structured slice.

Buyer-facing риск:
- на запрос “до 100 тыс.” или бюджетный подбор ассистент может первым показать самый дорогой товар внутри лимита;
- противоречит правилу: если бюджет неизвестен/покупатель не просил premium и не отвергал дешёвые варианты — подходящие варианты cheapest-first.

Исправление:
1. Вынести comparator для budget ranking: within-budget сначала; внутри within-budget — cheapest-first, кроме `preference === 'premium'`.
2. Использовать этот порядок в `sortSelectionProducts()`.
3. Заменить аналогичный comparator в `findStructuredCatalogSlice()`.
4. Добавить tests для `budgetMax` и `budgetMax + premium`.

## P1. Card contract не должен подменять авторитетную selection под текст LLM

Root cause:
- `src/ai/assistant.ts:2631-2688` может добавить/переупорядочить карточки по упомянутым в answer моделям, если они проходят фильтры.
- Для recommendation turns авторитетом должна быть deterministic selection/card set, а не LLM text.

Buyer-facing риск:
- если LLM назвала не первую/невыбранную модель, система может “подогнать” карточки под ошибку текста;
- это не валидирует вывод, а маскирует drift.

Исправление:
1. Для `recommend_products/productRecommendation` не добавлять карточки по тексту; разрешить только диагностику drift.
2. Сохранить `repairAnswerCardText()` как текстовую правку в сторону первой карточки.
3. В metadata оставить `cardContract.mentionedProductIds`, `addedCardIds=[]`, `reordered=false` для recommendation turns.
4. Добавить regression test: answer упоминает вторую/третью подходящую модель, cards заданы как authoritative; contract не меняет cards.

## Проверка после исправлений

Targeted:
- `npm test -- --run tests/turnContract.test.ts tests/recommendationRanking.test.ts`
- `npm test -- --run tests/needState.test.ts tests/generatorLoadReference.test.ts tests/recommendationRanking.test.ts tests/turnContract.test.ts`

Broad:
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm audit --omit=dev`
- `git diff --check`

Live/Railway:
- локальные тесты не считать достаточными;
- после push/deploy проверить Railway/GitHub и провести полный живой диалог, если backend поднимется и есть доступ к deploy flow.

## После исправлений: что изменено

Статус: P0/P1 remediation выполнен локально и покрыт regression/full проверками. Изменения сделаны без trigger-word patches: исправлены общие контракты selection/card/ranking.

### P0 — turn contract включён в основной runtime

Изменено в `src/ai/assistant.ts`:
- добавлен `applyResolvedTurnContractToPlan()` — contract теперь возвращается в `effectivePlan`, а не остаётся только тестовым объектом;
- основной `generateAnswer()` создаёт `turnContract = resolveTurnContractForPlan(effectivePlan)` и передаёт его в `selectProductsForTurn(...)`;
- после deterministic selection / load guidance contract пересчитывается и снова применяется к `effectivePlan`;
- финальная карточная селекция идёт через `selectCardsFromTurnContract(...)`, а не напрямую через `selectCardsFromPlan(...)`;
- `selectCardsFromTurnContract(...)` принимает `cardLimit` и уважает `contract.render.cards === 'none'`.

Эффект: если contract говорит “text only / ask clarifying / no cards”, основной путь ответа больше не может молча обойти это через прямой `selectCardsFromPlan()`.

### P1 — previousSelection стал якорем, а не клеткой

Изменено в `src/ai/assistant.ts`:
- `previousSelectionOnly` теперь включается только при `plan.searchScope === 'previousSelectionOnly'`;
- `contextScope === 'previousSelection'` сам по себе больше не режет каталог до старого набора.

Добавлен regression test в `tests/recommendationRanking.test.ts`:
- `uses previousSelection as an anchor, not a cage, when the buyer asks to broaden alternatives`.

### P1 — бюджетный подбор внутри лимита стал cheaper-first

Изменено в `src/ai/assistant.ts`:
- основной comparator для budget ceiling больше не поднимает самый дорогой товар внутри бюджета;
- structured catalog slice comparator приведён к той же логике;
- исключение сохранено для premium preference.

Обновлены ожидания в `tests/recommendationRanking.test.ts`:
- budget order теперь `['cheap', 'mid', 'near-budget']`;
- генераторный бюджетный подбор теперь ждёт `['honda4000', 'honda5000']`.

### P1 — карточки recommendation authoritative относительно текста LLM

Изменено в `src/ai/assistant.ts`:
- для recommendation/productRecommendation, если уже есть authoritative selected cards, выравнивание по текстовым mentions LLM не добавляет и не переставляет карточки;
- направление repair остаётся правильным: карточки/selection → текст, а не текст LLM → карточки.

Добавлен regression test в `tests/turnContract.test.ts`:
- `does not change authoritative recommendation cards to follow an LLM text mention`.

### Metadata / provenance

Изменено в `src/ai/assistant.ts`:
- `RequiredProductTraits` получил `provenance?: ProductSelectionCriteria['provenance']`;
- selection metadata/criteria теперь сохраняет `provenance`, чтобы различать explicit user / inferred / previous selection provenance.

## Проверки после исправлений

Targeted regression:
- `npm test -- --run tests/turnContract.test.ts tests/recommendationRanking.test.ts` — PASS, 2 files, 103 tests.
- `npm test -- --run tests/needState.test.ts tests/turnContract.test.ts tests/generatorLoadReference.test.ts tests/recommendationRanking.test.ts` — PASS, 4 files, 109 tests.

Broad verification:
- `npm run typecheck` — PASS.
- `npm test` — PASS, 13 files, 134 tests.
- `npm run build` — PASS (`vite build && tsc -p tsconfig.server.json`).
- `npm audit --omit=dev` — PASS, `found 0 vulnerabilities`.
- `git diff --check` — PASS.

Live/backend:
- повторная локальная попытка `npm run dev:server` стартовала процесс, но за 51s не дала stdout/log readiness;
- `curl -m 5 http://127.0.0.1:3010/api/health` — корректный локальный health endpoint;
- процесс был остановлен, `process list` после kill пустой;
- live-диалог локально не подтверждён из-за неподнявшегося health endpoint. Локальная кодовая верификация зелёная, live остаётся отдельным ограничением.
