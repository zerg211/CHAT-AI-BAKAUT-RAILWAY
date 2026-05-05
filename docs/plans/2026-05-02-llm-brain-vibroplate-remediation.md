# LLM-first AI менеджер: аудит и план чистки keyword-trigger поведения

> **For Hermes:** выполнять только в `C:\Projects\chatAI` / `/mnt/c/Projects/chatAI`. Цель — не добавить очередной trigger-word patch, а убрать места, где слова покупателя или текста товара могут перебить семантический план LLM.

**Goal:** сделать так, чтобы реплика покупателя и весь контекст диалога сначала интерпретировались LLM-планировщиком, а код ниже только исполнял этот план, проверял жесткие бизнес/каталожные инварианты и не подмешивал аксессуары/запчасти как основную технику.

**Root cause на текущем срезе:**
1. В `src/ai/prompts.ts` уже описан LLM-планировщик как semantic brain, но ниже в `src/ai/assistant.ts` и `src/ai/productClassifier.ts` остаются fallback/heuristic слои: `inferProductIntent`, `heuristicNeedUpdate`, `productFitPenalty`, `classifyProduct`, `productMatchesIntent`.
2. Часть этих слоев нужна как страховка и валидатор каталога, но они становятся опасными, когда:
   - buyer intent определяется по словам, а не по `requiredProductTraits`/`selectionState` LLM-плана;
   - product class определяется по широкому `containsAny(classText, plateTerms)`, из-за чего товар с категорией/названием вокруг виброплиты, но с ролью запчасти/расходника, может пройти как `plate`;
   - fallback-план после невалидного JSON от planner снова пытается сделать подбор по словам.
3. Для виброплит критический дефект: запрос на целую виброплиту должен показывать только core equipment. Фильтры, ремни, масло, подогревы, коврики, накладки, баки, крышки, запчасти и расходники не имеют права попадать в `plate` карточки только потому, что в названии/категории встретилась виброплита.

**Architecture:** LLM planner остается единственным источником смысла покупательской реплики. Детерминированный код оставляем только как:
- catalog safety validator: не показать аксессуар как основную технику;
- numeric/business validator: мощность, бюджет, вес, 220/380, точные модели;
- resilience fallback: если planner сломан, лучше честный текст/уточнение, чем самостоятельный keyword-подбор.

## Task 1: Regression — accessories/spares must not pass as core vibroplates

**Files:**
- Modify: `tests/recommendationRanking.test.ts`

**Test:** создать продукты:
- core `vibro-core`: `Виброплита бензиновая TSS VP80`, категория `Виброплиты`, цена;
- spare `plate-filter`: `Фильтр воздушный для виброплиты TSS VP80`, категория `Запчасти для виброплит`, цена;
- spare `plate-belt`: `Ремень привода виброплиты`, категория `Расходники и запчасти для виброплит`.

План LLM:
- `requiredProductTraits.productIntent='plate'`
- `requiredProductTraits.productRole='coreProduct'`
- `selectionState.targetProductClass='plate'`
- `cardPolicy='showProducts'`

Expected:
- `selectProductsForTurn(...).visibleProducts` содержит только `vibro-core`.
- `productSelectionHardViolation(spare, state, profile)` возвращает нарушение `not core equipment` или class mismatch.

## Task 2: Fix product classifier role safety, not buyer-word routing

**Files:**
- Modify: `src/ai/productClassifier.ts`

**Implementation:**
- Ввести общий `spareAccessoryTerms` для текстов товара/категории: `запчаст`, `расходник`, `фильтр`, `ремень`, `масло`, `подогрев`, `бак`, `крышка`, `свеча`, `карбюратор`, `коврик`, `накладка`, `комплект`, `авр`, `accessory`, `spare`, `parts`, `filter`, `belt`, `oil`.
- Разделить `isPlateAccessory` на любое accessory/consumable рядом с plate context, а не только коврик/накладка.
- `isPlate` должен быть `containsAny(classText, plateTerms) && !isPlateAccessory && !isGenericAccessoryProduct`.
- `isCoreEquipment` не должен включать такие позиции.

## Task 3: Reduce planner fallback authority

**Files:**
- Modify: `src/ai/assistant.ts`
- Modify/add test in `tests/recommendationRanking.test.ts`

**Implementation:**
- `fallbackTurnPlan` при невалидном planner JSON не должен создавать `recommend_products` на основе `inferProductIntent` из слов покупателя.
- Он должен вернуть `answer_question` или `ask_clarifying_question`, `cardPolicy='textOnly'`, `selectionState.shouldShowCards=false`, `answerGuidance` с честным восстановлением: ответить по контексту, при необходимости задать 1 уточнение, не подбирать карточки без LLM-плана.
- Исключение: уже выбранные товары и `collect_lead` могут сохраняться детерминированно.

## Task 4: Keep lexical need extraction as low-authority memory hints only

**Files:**
- Modify: `src/ai/needState.ts`
- Modify: `tests/needState.test.ts`

**Implementation:**
- `heuristicNeedUpdate` не должен называться или использоваться как intent-router. Он может сохранять soft hints, но `selectionState` и `requiredProductTraits` должны приходить из LLM planner.
- Понизить confidence товарных explicitSignals до уровня подсказок, или оставить только summary labels без влияния на structured selection.

## Task 5: Verification

Commands after edits:
- `npm test -- --run tests/recommendationRanking.test.ts tests/needState.test.ts tests/turnContract.test.ts`
- `npm run build`
- Локальный UI buyer-dialogue по виброплитам: покупатель просит целую виброплиту, затем критически возражает, если видит запчасти. GREEN только если карточки — целая техника и ответ не делает вид, что фильтр/ремень — виброплита.

**Current blocker:** terminal command был заблокирован пользователем (`BLOCKED: User denied. Do NOT retry.`), поэтому verification через shell возможен только после явного разрешения на команды. Пока правки должны быть минимальными и покрыты читаемыми тестами.
