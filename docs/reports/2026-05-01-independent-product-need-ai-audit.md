# Независимый аудит CHAT-AI-BAKAUT: подбор товара по потребности покупателя

Дата: 2026-05-01
Репозиторий: `/mnt/c/Projects/chatAI` / `C:\Projects\chatAI`
Тип: независимый статический аудит + локальные тесты, без фиксов и без Railway/live проверки.

## Короткий вердикт

Проект уже содержит серьёзную базу AI-продавца: LLM-планировщик, состояние потребности, deterministic selection engine, turn contract, web search для фактов, сохранение web evidence/facts, генераторную базу нагрузок и большой набор регрессий по карточкам/подбору.

Но главная проблема: система пока не является единым AI-менеджером с одним источником истины. Вокруг LLM-планировщика построено много параллельных ручных слоёв: эвристики, selection engine, turn contract, card selection, answer repair, post-generation card enforcement, duplicate types. Они часто полезны как safety rails, но сейчас конкурируют друг с другом. Поэтому проект может проходить unit-тесты и всё равно ошибаться в живом диалоге: не так понять текущую потребность, смешать старый контекст, показать не те карточки, назвать в тексте не тот товар, либо сохранить web-факт, но не использовать его как знание в будущем.

## Что проверено

Критическая цепочка:

1. Покупательская реплика → extraction/need state.
2. Need state + history → turn planner.
3. Turn planner → turn contract.
4. Turn planner/contract/state → deterministic selection.
5. Selection → visible/hidden product cards.
6. Product cards + knowledge/web context → final answer.
7. Post-generation repair/card contract.
8. Web search → web evidence/product facts → future reuse.
9. Тесты по need/turn/selection/web/generator load.

Ключевые файлы:

- `src/ai/assistant.ts`
- `src/ai/prompts.ts`
- `src/ai/turnContract.ts`
- `src/ai/needState.ts`
- `src/ai/productClassifier.ts`
- `src/ai/generatorLoadReference.ts`
- `src/db/repositories.ts`
- `sql/001_init.sql`
- `tests/needState.test.ts`
- `tests/turnContract.test.ts`
- `tests/recommendationRanking.test.ts`
- `tests/generatorLoadReference*.test.ts`

## Сильные стороны, связанные именно с AI-менеджером

1. Есть отдельная модель состояния потребности.
   - `src/ai/needState.ts:32-52` хранит explicit/implicit needs, constraints, criteria, confirmed/uncertain facts, contradictions, feature signals и selectionState.
   - `src/ai/needState.ts:264-292` умеет ослаблять старые needs при scope change.

2. Planner явно проектирован как semantic brain.
   - `src/ai/prompts.ts:145-238` описывает внутренний turn planner: action, answerMode, cardPolicy, contextScope, searchScope, requiredProductTraits, selectionState, needsWebSearch.
   - `src/ai/prompts.ts:232-236` содержит важные правила по генераторам, нагрузкам, hard constraints и web search для недостающих фактов.

3. Есть typed turn contract.
   - `src/ai/turnContract.ts:111-188` нормализует план в action/scope/knowledge/selection/render/guidance.
   - `src/ai/turnContract.ts:50-72` защищает от финального подбора генератора, если 220/380 только inferred, а не явно подтверждено покупателем.

4. Есть deterministic selection engine, а не только LLM-выбор.
   - `src/ai/assistant.ts:3475-3613` строит product selection по full catalog, hard constraints, previous selection, budget/ranking, visible/hidden products.
   - `src/ai/assistant.ts:3737-3749` для structured catalog slice при бюджете сортирует подходящие варианты внутри бюджета дешевле-сначала.

5. Есть card/text safety rails.
   - `src/ai/assistant.ts:4237-4245` заставляет final answer называть только видимые cards и не превращать текст в каталог.
   - `src/ai/assistant.ts:4398-4414` выполняет sanitize/repair/enforce card contract перед сохранением ответа.

6. Есть web search и сохранение источников.
   - `src/ai/assistant.ts:4308-4315` включает `web_search_preview`, когда `mustUseWebSearch=true`.
   - `src/ai/assistant.ts:4430-4438` сохраняет web findings после ответа.
   - `src/db/repositories.ts:535-557` пишет verified web facts в `product_facts`.
   - `src/db/repositories.ts:559-581` пишет citations/evidence в `web_evidence`.
   - `sql/001_init.sql:78-118` содержит durable `product_facts`, `data_conflicts`, `web_evidence`.

7. Есть настоящая узкая agent memory для генераторных нагрузок.
   - `src/ai/generatorLoadReference.ts:64-67` хранит overlay в `GENERATOR_LOAD_REFERENCE_PATH` или `RAILWAY_VOLUME_MOUNT_PATH`.
   - `src/ai/generatorLoadReference.ts:142-178` читает persisted overrides и объединяет их с curated table.
   - `src/ai/generatorLoadReference.ts:741-765` умеет web-enrichment неизвестных нагрузок и сохраняет sanitized entry.

8. Тестовая база сильная для deterministic selection.
   - `tests/recommendationRanking.test.ts`: 96 сценариев по budget, previous selection, card count, exact model/accessory confusion, generator load, answer/card consistency.
   - `tests/turnContract.test.ts`: 7 сценариев по render policy, lead, web, generator phase, authoritative cards, requested card limit.

## P0: что реально мешает проекту быть AI-продавцом

### P0-1. Нет единого источника истины: planner, selection engine, turn contract и card repair конкурируют

Evidence:

- LLM planner вызывается в `src/ai/assistant.ts:3311-3407`.
- Потом `purchasePlanIfNeeded` может переписать plan: `src/ai/assistant.ts:2830-2855`, вызов `3869-3870`.
- Selection engine может переписать action/cardPolicy/selectedProductIds/traits: `src/ai/assistant.ts:3914-3955`.
- Exact model branch ещё раз меняет plan: `src/ai/assistant.ts:3956-3970`.
- Generator no-basis/pump branches принудительно выключают рекомендации: `src/ai/assistant.ts:3973-4000`.
- Turn contract ещё раз нормализует/переписывает plan: `src/ai/assistant.ts:4010-4011`, `2865-2888`.
- После генерации текста cards могут снова измениться через `enforceAnswerCardContract`: `src/ai/assistant.ts:4402-4414`.

Root cause:

LLM-планировщик не является authoritative decision state. Он только один из слоёв. Каждый следующий слой может менять решение, но нет единого финального `Decision` object, который был бы источником правды для selection, answer context, UI cards и metadata.

Почему это мешает AI:

AI-менеджер должен понимать намерение и стабильно проводить его через весь turn. Сейчас намерение может быть понято planner-ом, затем изменено selection engine, затем снова изменено card contract. В живом диалоге это даёт drift: текст, карточки, metadata и предыдущий контекст могут описывать разные наборы товаров.

### P0-2. Answer/card alignment всё ещё частично answer-first, а не selection-first

Evidence:

- Answer context получает `productCardsShown` до final card enforcement: `src/ai/assistant.ts:4151-4169`.
- LLM генерирует answer: `src/ai/assistant.ts:4308-4344`.
- Затем answer чинится под текущие cards: `src/ai/assistant.ts:4398-4401`.
- Затем `enforceAnswerCardContract` может изменить cards после уже сгенерированного текста: `src/ai/assistant.ts:4402-4414`.
- Final metadata строится уже по новым cards: `src/ai/assistant.ts:4415-4428`.

Root cause:

Сначала генерируется текст по одному card context, потом код может менять card set под текст или из-за text mentions. Это обратное направление для рекомендаций. Для AI-продавца authoritative должны быть: need → selection → cards → answer. Не answer → repair cards.

Риск:

Покупатель видит карточки, которые не полностью соответствуют сгенерированному reasoning. Или наоборот: текст говорит о главном варианте, но card set после enforcement изменён.

### P0-3. Понимание потребности покрыто тестами несоразмерно хуже, чем карточки

Evidence:

- `tests/needState.test.ts` содержит только 2 сценария:
  - `tests/needState.test.ts:5-10` — одна реплика про виброплиту/дачу/перенос/бюджет.
  - `tests/needState.test.ts:13-20` — смена generator homeUse на brigade/pro duty.
- Основная масса сложных тестов находится в `tests/recommendationRanking.test.ts`, но там часто используются hand-made turn plans и already-filled traits.

Не покрыто достаточно:

- отрицания: “не дизель”, “без ручного запуска”, “не такой тяжёлый”;
- conflict resolution: “до 50 тыс, но 8 кВт и тихий”;
- длинная естественная реплика с явными и скрытыми needs;
- extractor ошибся/вернул неполный JSON;
- уточняющий вопрос → ответ покупателя → обновлённый state → подбор;
- objections/corrections: “ты показал не то”, “дорого”, “нужен аналог дешевле”.

Root cause:

Тесты доказывают, что selection engine умеет фильтровать при уже заданных criteria. Но AI-менеджер начинается раньше: он должен сам достать criteria из слов покупателя и корректно обновлять их по диалогу.

### P0-4. Durable web facts сохраняются, но почти не становятся рабочей памятью ассистента

Evidence:

- Web facts пишутся в `product_facts`: `src/db/repositories.ts:535-557`.
- Web evidence пишется в `web_evidence`: `src/db/repositories.ts:559-581`.
- Но `mapProduct()` возвращает `Product.specs` только из `products.specs`: `src/db/repositories.ts:67-82`.
- `buildAssistantContext()` передаёт compact products, где используются product specs: `src/ai/prompts.ts:241+`, compact product block `src/ai/prompts.ts:77-87`.
- Видимого чтения `web_evidence` обратно в answer/planner context нет.
- `product_facts` после web extraction в основном влияют косвенно через `data_conflicts`: `src/db/repositories.ts:705-732`.

Root cause:

Есть слой хранения evidence/facts, но нет полноценного retrieval/merge слоя “verified facts overlay → product context”. Сохранённая информация не становится обычной характеристикой товара для будущего подбора.

Почему это мешает AI:

Покупатель ожидает, что ассистент “узнал и запомнил”. Сейчас это работает хорошо для generator load reference, но не для общей информации о товарах. Web search может быть повторён, а сохранённый факт может не попасть в следующий подбор.

### P0-5. Full dialogue/e2e поведение почти не проверяется автоматически

Evidence:

Локальные проверки зелёные:

- Focused tests: 5 files passed, 113 tests passed.
- Full tests: 13 files passed, 134 tests passed.
- Typecheck: passed.
- Build: passed.
- `npm audit --omit=dev`: 0 vulnerabilities.

Но покрытие в основном unit/helper level:

- `tests/turnContract.test.ts` вызывает `resolveTurnContract` и hooks.
- `tests/recommendationRanking.test.ts` широко использует `assistantTestHooks`, `selectProductsForTurn`, hand-made plans.
- Нет набора автоматических multi-turn evals полного `generateAnswer`: user history → need extractor/planner → selection → answer → UI metadata.

Root cause:

Проект тестирует детали selection safety, но не достаточно тестирует саму роль AI-менеджера в живом диалоге.

Риск:

Зелёные тесты не гарантируют, что реальный buyer dialogue корректно:

- понял потребность;
- спросил ровно один нужный вопрос;
- учёл ответ;
- не смешал старый контекст;
- показал нужные карточки;
- дал верное заключение;
- довёл до заявки.

## P1: серьёзные конфликты архитектуры и поведения

### P1-1. Монолитный `assistant.ts` — 4991 строка с бизнес-логикой, prompt policy, selection, DB/web orchestration и test hooks

Evidence:

- Локальные типы/контракты: `src/ai/assistant.ts:60-245`.
- Fallback planner: `571-618`.
- Product fit/scoring/heuristics: примерно `752-1150+`.
- Card contract/selection: `2632-3099`.
- Full catalog selection engine: `3475-3613`.
- Main generateAnswer pipeline: `3798-4499`.
- JSON schema planner: `4648-4892`.
- Response utils/test hooks: `4894-4991`.

Риск:

Любая правка “как AI понимает/подбирает/отвечает” касается одного сверхфайла. Сложно гарантировать, какой слой реально сработает.

### P1-2. Дубли типов и dead/parallel decomposition

Evidence:

- `GenerateAnswerInput`: `src/ai/assistant.ts:60-65` и `src/ai/assistantTypes.ts:3-8`.
- `AssistantTurnPlan`/action/mode/scope/card types: `assistant.ts:73-152`, `assistantTypes.ts:11-90`, `turnContract.ts:1-38`.
- `ProductIntent`: `src/shared/types.ts:127-141`, `assistant.ts:154`, `assistantTypes.ts:92-106`, `productClassifier.ts:3`.
- `responseUtils.ts:3-107` дублируется в `assistant.ts:4894-4955`.
- По статическому поиску `assistantTypes.ts` и `responseUtils.ts` выглядят неиспользуемыми живым `assistant.ts`.

Риск:

Разработчик может править вынесенный файл, но production path продолжит использовать локальную копию в `assistant.ts`.

### P1-3. `findStructuredCatalogSlice` выглядит dead path

Evidence:

- Метод определён: `src/ai/assistant.ts:3615-3795`.
- Вызовов по статическому поиску не найдено.
- В `generateAnswer` structured slice строится inline из `selectionResult`: `src/ai/assistant.ts:3886-3910`.

Риск:

В проекте есть параллельная логика structured filtering, которая не влияет на runtime. Это симптом распада orchestration.

### P1-4. Prompt/schema/type drift

Evidence:

- TS type разрешает `structured_selection`: `src/ai/assistant.ts:115-121`.
- JSON schema разрешает `structured_selection`: `src/ai/assistant.ts:4849-4852`.
- Prompt для planner перечисляет cardDisplayMode без `structured_selection`: `src/ai/prompts.ts:221`.
- Runtime сам ставит `structured_selection`: `src/ai/assistant.ts:3944-3948`.

Риск:

LLM получает неполное описание состояния. Runtime использует режим, который planner не должен/не может сознательно выбрать по prompt. Это снижает управляемость AI-планирования.

### P1-5. `selectedOnly` существует в turn contract, но не выражается в `CardPolicy`

Evidence:

- `TurnRenderCards` включает `selectedOnly`: `src/ai/turnContract.ts:22`.
- `CardPolicy` в `assistant.ts` не включает `selectedOnly`: `src/ai/assistant.ts:90-94`.
- `applyResolvedTurnContractToPlan` мапит `selectedOnly` обратно в `showProducts`: `src/ai/assistant.ts:2866-2869`.

Риск:

Семантика “покажи только выбранное” теряется при обратном преобразовании contract → plan. Дальше selection/card layers могут расширить набор.

### P1-6. Web search зависит от правильного planner/heuristic routing

Evidence:

- Web tool добавляется только если `mustUseWebSearch=true`: `src/ai/assistant.ts:4308-4315`.
- `shouldUseWebSearch` смотрит plan/action/mode и fallback regex: `src/ai/assistant.ts:1448-1461`.

Риск:

Если planner не поставил `needsWebSearch`, а heuristic не распознал вопрос, финальный ответ не получит web tool, несмотря на общий prompt “не выдумывать характеристики”. Для фактов типа THD/AVR/шум/расход/актуальная линейка это критично.

### P1-7. Сохранение web facts идёт по raw answer до финального sanitize/repair

Evidence:

- `rawAnswer = answer`: `src/ai/assistant.ts:4397`.
- Затем выполняется sanitize/repair/enforce: `src/ai/assistant.ts:4398-4414`.
- `storeVerifiedWebFindings` получает `answer: rawAnswer`: `src/ai/assistant.ts:4431-4435`.
- Пользователю и в `messages` сохраняется final `answer`: `src/ai/assistant.ts:4440-4448`.

Риск:

Fact extraction может сохранить факт из текста, который потом был исправлен/удалён перед показом пользователю.

## P2: важные, но менее срочные пробелы

1. Категории вне генераторов и виброплит покрыты слабее.
   - Есть intents для rammer/roller/cutter/diamondBlade/diamondCore/trowel/weldingGenerator, но полноценных сценариев подбора меньше.

2. Коммерческие ограничения недостаточно проверены end-to-end.
   - Prompt запрещает обещать наличие/скидки/сроки: `src/ai/prompts.ts:101`, routing guidance `src/ai/prompts.ts:177`.
   - Но нет достаточного полного dialogue coverage: “есть в наличии?”, “доставка завтра?”, “скидка?”, “забронируйте”.

3. Objection handling почти не покрыт как dialogue.
   - Частично есть tests на cheaper alternatives/brand/exact comparison, но мало сценариев “дорого”, “не то”, “почему этот”, “покажи только 2”, “без этой марки”.

4. Недостаточно metadata/diagnostics tests.
   - Финальный `metadata.productSelection`, `cardSelection`, `cardContract`, `internalSources` важны для аудита, но не выглядят как полноценный контракт e2e.

## Статус локальной проверки

Команды:

```bash
cd /mnt/c/Projects/chatAI
npm test -- --run tests/needState.test.ts tests/turnContract.test.ts tests/generatorLoadReference.test.ts tests/generatorLoadReferenceEnrichment.test.ts tests/recommendationRanking.test.ts
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

Результат:

- Focused tests: 5 files passed, 113 tests passed.
- Typecheck: passed.
- Full tests: 13 files passed, 134 tests passed.
- Build: passed.
- npm audit prod deps: 0 vulnerabilities.
- `git status --short` до записи отчёта был чистый.

Что не выполнялось:

- Railway deploy/live проверка.
- Browser диалог через виджет.
- Реальный multi-turn dialogue eval через OpenAI API.
- Проверка production DB/Railway Postgres состояния.

## Root-cause вывод

Главный root cause не в том, что “мало правил” или “мало LLM”. Наоборот: правил и слоёв слишком много, и они не сведены в один decision contract.

Текущая архитектура выглядит так:

```text
buyer text
  -> heuristic need update + LLM extraction
  -> LLM planner
  -> fallback/heuristic interpretations
  -> purchase plan override
  -> deterministic selection engine
  -> structured catalog override
  -> generator safety overrides
  -> turn contract override
  -> card selection
  -> LLM answer
  -> answer repair
  -> card enforcement after answer
  -> metadata/save/web fact extraction
```

Для AI-менеджера нужна более строгая форма:

```text
buyer text + history
  -> NeedStateUpdate with provenance
  -> Decision/TurnContract as single source of truth
  -> SelectionResult authoritative
  -> Cards authoritative
  -> Answer generated/repaired only to selected cards
  -> Evidence/facts saved and reused as product knowledge overlay
```

## Рекомендованный staged plan без trigger-word patches

### Stage 1. Зафиксировать единый AI-manager decision contract

Цель: один объект `TurnDecision`/`ResolvedTurnContract` должен быть источником истины для action, scope, knowledge, selection, render, lead.

Сделать:

- Вынести типы из `assistant.ts` в один живой модуль, убрать dead `assistantTypes.ts` или начать реально использовать его.
- Убрать расхождение `CardPolicy` vs `TurnRenderCards`; выразить `selectedOnly` без потери семантики.
- Синхронизировать prompt/schema/types: включая `structured_selection` или убрать его из planner-visible контракта и оставить только runtime-only с явным provenance.
- Запретить post-planner override без записи причины/provenance в decision diagnostics.

Verification:

- Unit tests на mapping planner → contract → selection → render.
- Regression: generator inferred phase, lead selectedOnly, broaden alternatives, previousSelectionOnly, requested card limit.

### Stage 2. Перевернуть answer/card contract в selection-first

Цель: final cards не должны меняться после генерации answer, кроме строго безопасного удаления/санитизации.

Сделать:

- Selection/cards authoritative до LLM answer.
- Если LLM назвал не-card model, чинить/перегенерировать текст под cards, а не добавлять/reorder cards под текст.
- `enforceAnswerCardContract` перевести в режим diagnostics + answer repair, не card mutation для recommendation turns.
- Metadata должна фиксировать original selected cards, final visible/hidden, repair diagnostics.

Verification:

- Тест: LLM упомянул товар не из cards → cards не меняются, answer repair убирает/заменяет упоминание.
- Тест: “1 основной + 1 запасной” → ровно 2 visible cards, остальные только hidden/show more; текст не называет третий.

### Stage 3. Усилить need understanding как отдельную подсистему

Цель: тестировать не только карточки, а понимание покупателя.

Сделать:

- Добавить dialogue eval fixtures: 20-30 multi-turn сценариев по generator/plate/cutter/diamond/accessories/lead.
- Покрыть negation, scope change, objection, budget conflict, previous-selection follow-up.
- Отдельно проверять provenance: explicit_user vs inferred_from_load vs previous_selection vs catalog_fact.

Verification:

- Автоматический `npm test -- tests/dialogue*.test.ts` без live API, через stubbed planner/extractor и deterministic expected decision.
- Позже — live eval suite с сохранением transcript.

### Stage 4. Сделать saved web facts реальной knowledge overlay

Цель: “нашёл в сети → сохранил → использовал в будущем” для всех товаров, не только generator load reference.

Сделать:

- Добавить repository method: load verified product facts by product ids / attribute / query.
- При сборке `Product` context объединять `products.specs` + high-confidence `product_facts` с provenance.
- `web_evidence` использовать как internal citations cache для повторных factual/current-lineup вопросов.
- Fact extraction делать по final sanitized answer или лучше по structured cited facts, не по raw answer.
- Разделить exact facts, approximate facts, conflicting facts.

Verification:

- Тест: fact saved in product_facts → next answer context contains it.
- Тест: conflicting facts → answer says uncertainty and does not state disputed value as truth.
- Тест: no source → no exact technical claim.

### Stage 5. Разобрать монолит без изменения поведения

Цель: снизить риск будущих фиксов.

Вынести из `assistant.ts`:

- planner schema/coercion;
- need/selection decision types;
- selection engine;
- card policy/card contract;
- answer context builder;
- web fact storage;
- response utils.

Порядок важен: сначала characterization tests, потом move-only refactor.

Verification:

- `npm test`
- `npm run typecheck`
- `npm run build`
- `git diff --check`

### Stage 6. Live/browser/Railway verification

Цель: доказать именно поведение AI-консультанта.

Минимальные сценарии:

1. Генератор для дома, неизвестна мощность → спросить нагрузки, не показать cards слишком рано.
2. Генератор: покупатель перечисляет холодильник/котёл/свет/насос → спросить насос/220-380 если нужно, потом подобрать.
3. Покупатель просит “1 основной и 1 запасной” → текст и cards ровно 2 visible, остальные под “Показать ещё”.
4. Покупатель говорит “дорого, покажи дешевле из этих/альтернативы” → корректный contextScope/searchScope.
5. Вопрос по факту товара, которого нет в catalog specs → web search, факт с provenance, без URL покупателю, сохранение в DB.
6. Повторный похожий факт-вопрос → reuse saved fact без повторного поиска, если confidence/source valid.
7. Готов купить → lead flow без обещаний наличия/доставки/скидки.

## Итог

Проект близок к AI-продавцу на уровне компонентов, но ещё не стабилен как целостный AI-менеджер. Самые важные работы — не добавлять новые keyword patches, а:

1. Свести planner/contract/selection/cards/answer в один authoritative decision flow.
2. Сделать потребность покупателя и её provenance первоклассным объектом, а не побочным результатом эвристик.
3. Запретить card mutation после answer для recommendation turns.
4. Превратить saved web facts в реально используемую knowledge overlay.
5. Добавить e2e dialogue evals, потому что текущие unit-тесты проверяют детали, но не всю консультацию.
