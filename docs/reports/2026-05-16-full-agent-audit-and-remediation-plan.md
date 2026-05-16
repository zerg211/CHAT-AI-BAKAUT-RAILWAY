# Полный аудит AI-менеджера БАКАУТ и план усиления

Дата: 2026-05-16  
Проект: `C:\Projects\chatAI`  
Цель: разложить полный аудит AI-чат-бота на 10 отдельных проверок, найти технические и поведенческие слабые места, описать лучший путь исправления и общий план, который усиливает миссию проекта: AI-менеджер на сайте `bakautprof.ru`, который ведет консультацию, подбирает товары, проверяет факты и не превращается в набор костылей.

## Метод проверки

Я не принимал проектные документы за истину. Документы использованы только как контекст ожиданий, а выводы ниже опираются на код, тесты и live-cycle.

Проверено:

- код: `src/ai/assistant.ts`, `src/ai/agentTurnContract.ts`, `src/ai/turnContract.ts`, `src/ai/needState.ts`, `src/ai/productClassifier.ts`, `src/routes/chat.ts`, `src/client/chatStream.ts`, `src/client/main.tsx`, `src/db/repositories.ts`, каталог и lead routes;
- тесты: `npm run typecheck` - PASS;
- агентские регрессионные тесты: `npm test -- --run tests/agentTurnContract.test.ts tests/agenticCycle876.test.ts tests/turnContract.test.ts tests/assistantFallback.test.ts tests/chatStream.test.ts` - FAIL в `tests/agenticCycle876.test.ts:581`;
- production live-cycle через `https://bakautprof.ru/`: `npm run test:live:production` - FAIL, поле ввода не стало активным до таймаута;
- failure artifact: `local-live-tests/production-agent-cycle-failure.json`.

Внешние практики, которые использованы как ориентир:

- OpenAI: Responses API, Structured Outputs, Web Search, Agents, Tracing, Evals.
- OpenAI practical guide to building agents: agents should combine model reasoning, tools, guardrails, memory and orchestration around a clear task loop.
- Anthropic: tool use, prompt engineering, test and evaluate.
- Google Vertex AI: function calling, grounding, evaluations.

Ссылки:

- https://platform.openai.com/docs/guides/responses
- https://platform.openai.com/docs/guides/structured-outputs
- https://platform.openai.com/docs/guides/tools-web-search
- https://platform.openai.com/docs/guides/agents
- https://platform.openai.com/docs/guides/evals
- https://platform.openai.com/docs/guides/tracing
- https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf
- https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview
- https://docs.anthropic.com/en/docs/test-and-evaluate/overview
- https://cloud.google.com/vertex-ai/generative-ai/docs/grounding/overview
- https://cloud.google.com/vertex-ai/generative-ai/docs/evaluation/overview

## Executive Summary

Проект уже имеет сильную основу: Fastify/React/Postgres, `pgvector`, OpenAI Responses API, строгие JSON-схемы для need extraction и planner, хранение metadata, product cards, lead flow и production live scripts. Главная проблема не в отсутствии AI, а в "split brain": LLM-планировщик понимает диалог, но после него несколько deterministic-слоев снова принимают смысловые решения по regex, fallback, thresholds, card policy и recovery.

Критичный воспроизводимый дефект: `tests/agenticCycle876.test.ts:581` показывает, что сохраненные LLM-ограничения `brand=TSS` и `fuel=gasoline` могут не удержаться в selection executor, и в карточки попадает `other-8`. В живом поведении это означает: покупатель уточнил бренд/топливо, бот может показать товар другого бренда или другого топлива, хотя внутренний trace частично считает constraint сохраненным.

Критичный live-дефект: production cycle через iframe не завершился: `Chat input did not become enabled before timeout`. В failure artifact видно, что первые ходы отвечают содержательно, но дальнейший цикл зависает на уровне доступности ввода/stream/recovery. Для покупателя это выглядит как потеря управляемости чата.

Главное исправление: сделать один авторитетный `AgentTurnContract + ExecutionContract`, где LLM отвечает за смысл, а код исполняет только проверяемые операции: поиск, фильтрацию, валидацию фактов, бизнес-ограничения, rendering, lead creation, recovery. Все deterministic-правила должны стать либо validators, либо retrieval hints, либо hard business guardrails, но не вторым мозгом диалога.

---

# Аудит 1. Архитектура и AI-оркестрация

## Что проверялось

Пайплайн одного хода: user message -> need extraction -> planner -> AgentTurnContract -> product selection -> card selection -> answer generation -> repairs -> DB metadata -> SSE/frontend.

Ключевые места:

- `src/ai/assistant.ts:7137` - главный `generateAnswer`.
- `src/ai/assistant.ts:6175` - `updateNeedState`.
- `src/ai/assistant.ts:6289` - `planAssistantTurn`.
- `src/ai/assistant.ts:6598` - `selectProductsForTurn`.
- `src/ai/assistant.ts:5538` - `selectCardsFromPlan`.
- `src/ai/assistant.ts:7993` - post-answer repairs.
- `src/ai/assistant.ts:8074` - сохранение assistant message metadata.

## Найдено

`src/ai/assistant.ts` стал runtime-монолитом: один файл одновременно обновляет память, планирует, выбирает товары, чинит контракт, вызывает web search, генерирует ответ, чинит ответ, пишет metadata и управляет recovery. Из-за этого смысл хода может меняться несколько раз после planner:

1. `coerceTurnPlan` нормализует plan.
2. `deriveAgentTurnContract` ремонтирует `agentDecision`.
3. `applyAgentTurnContractToPlan` меняет action/cardPolicy/lead.
4. `selectProductsForTurn` заново выводит criteria из текста и памяти.
5. `resolveTurnContract` снова может запретить cards.
6. `selectCardsFromPlan` еще раз решает, какие cards показать.
7. `sanitizeVisibleAnswer`, `repairAnswerForFinalCards`, `ensureCommercialManagerVerification`, `enforceAnswerCardContract` меняют ответ после модели.

## Проблема

Это не агентная оркестрация, а каскад конкурирующих решений. Даже если LLM правильно поняла покупателя, downstream-код может:

- показать карточки, когда planner хотел text-only;
- скрыть карточки, когда нужна подборка;
- восстановить старую потребность вместо текущей;
- добавить lead pressure;
- заменить смысл availability/product selection.

## Как отражается в поведении

Пример: покупатель говорит "покажи TSS бензин 8-10 кВт". Planner и memory могут хранить `brand=TSS`, `fuel=gasoline`, но selection executor добавляет `other-8`, потому что один downstream слой расширяет candidates не по тем hard constraints.

## Лучший способ исправления

Ввести явный `ExecutionContract` после `AgentTurnContract`:

- `semanticIntent`: что покупатель делает сейчас;
- `activeRequirementIds`: какие требования обязательны;
- `catalogExecution`: exact lookup / constrained slice / no catalog;
- `allowedCards`: none / primary / supporting / selectedOnly;
- `leadExecution`: forbidden / optional / requiredAfterAnswer / requiredNow;
- `factPolicy`: catalogOnly / webRequired / specialistRequired;
- `recoveryPolicy`: textOnly / replayFinalContract / noCards.

После создания `ExecutionContract` downstream-код не имеет права менять смысл, только валидировать и возвращать `contractViolation`.

## Что изменится после исправления

До:

- бот может понять запрос, но показать лишние товары.

После:

- если `ExecutionContract.hardConstraints.brand=TSS`, `visibleProductIds` не содержит другие бренды;
- если `leadExecution=forbidden`, ни текст, ни форма не давят на контакт;
- если `catalogExecution=noCatalog`, recovery не показывает карточки.

## Риски после исправления

- Бот может стать слишком осторожным и чаще спрашивать уточнение.
- Исполнитель может скрывать полезные альтернативы.

## Как закрыть риски

Добавить в контракт `alternativePolicy`:

- `none`;
- `afterExactPrimary`;
- `fallbackOnly`;
- `showButMarkAsAlternative`.

Альтернативы показываются только если LLM разрешила это в структуре, а код подписывает cardsRole как `alternative`, не `primary`.

---

# Аудит 2. Граница LLM и deterministic-кода

## Что проверялось

Где код подменяет семантическое понимание LLM.

Ключевые места:

- `src/ai/needState.ts:548` - `heuristicNeedUpdate`.
- `src/ai/productClassifier.ts:583` - `inferProductIntent`.
- `src/ai/agentTurnContract.ts:45` - `contactRefusalText`.
- `src/ai/assistant.ts:2821` - current lineup fallback.
- `src/ai/assistant.ts:2830` - web search routing.
- `src/ai/assistant.ts:6598` - selection executor.

## Найдено

В коде есть правильный комментарий, что lexical extraction должен быть low-authority hint (`src/ai/needState.ts:579`), но на практике regex и helper-функции все еще участвуют в:

- intent detection;
- смене active need;
- product class;
- phase/power parsing;
- budget parsing;
- availability/current-lineup routing;
- contact refusal;
- lead suppression;
- card display.

## Проблема

Regex допустим для фактов формата: число кВт, вес кг, телефон, артикул, URL, SKU. Regex плох для смысловых решений: "я пока без звонка", "а если дешевле", "покажи похожее", "вернусь к генератору", "это не подходит".

`contactRefusalText` в `src/ai/agentTurnContract.ts:45` является примером: отказ от контакта определяется regex-ом по тексту и reason, хотя это должно быть частью LLM planner contract.

## Как отражается в поведении

Покупатель: "пока без звонка, сначала по технике".  
Правильное поведение: продолжить подбор и не просить телефон.  
Риск текущей логики: regex может поймать не все формы отказа или поймать ложный отказ, а downstream меняет lead/card policy.

## Лучший способ исправления

Разделить deterministic-код на 3 категории:

1. `FactExtractors`: числа, модели, телефоны, URL, цена, вес, кВт.
2. `Validators`: проверка соответствия карточек контракту.
3. `SemanticHints`: только diagnostics, не могут менять contract.

LLM planner должен вернуть:

```json
{
  "buyerIntent": "continue_selection",
  "contactPolicy": {
    "allowed": false,
    "reason": "buyer explicitly postponed calls",
    "scope": "this_turn"
  },
  "catalogPolicy": {
    "action": "find_matching_products",
    "requiredConstraints": ["productClass", "powerRange", "fuel", "brand"]
  }
}
```

## Что изменится после исправления

До: добавление новых regex под каждую фразу.  
После: одна schema для semantic decision, а regex только подсвечивает mismatch: "LLM says no contact refusal, but text has possible refusal phrase".

## Риски после исправления

- Если LLM ошиблась, regex больше не спасает поведение.

## Как закрыть риски

Сделать validator retry:

1. LLM возвращает contract.
2. Validator находит contradiction.
3. Повторный короткий LLM-call: "contract contradicts latestUserMessage; repair only contract".
4. Если снова плохо - text-only clarification, no cards, no lead.

---

# Аудит 3. TurnContract и AgentTurnContract

## Что проверялось

Единый ли контракт управляет действием, карточками, lead и fact policy.

Ключевые места:

- `src/ai/agentTurnContract.ts:49` - coercion LLM decision.
- `src/ai/agentTurnContract.ts:263` - apply contract to plan.
- `src/ai/turnContract.ts:111` - resolved turn contract.
- `src/ai/assistant.ts:7288` - `resolveTurnContractForPlan`.

## Найдено

Сейчас есть два слоя contract:

- `AgentTurnContract`: semantic LLM-derived contract.
- `ResolvedTurnContract`: renderer/execution-oriented contract.

Но они не являются единственным источником правды. `selectProductsForTurn`, `selectCardsFromPlan`, generator blockers, exact lookup repairs и post-answer guards продолжают менять поведение.

`coerceSemanticAgentDecision` в `src/ai/agentTurnContract.ts:140-218` уже активно "ремонтирует" contradictory planner decisions. Это полезно, но repair сейчас сразу меняет бизнес-смысл: например exact availability превращается в lead handoff.

## Проблема

Contract одновременно:

- валидирует LLM;
- чинит LLM;
- меняет plan;
- формирует answer guidance.

Смешаны 4 ответственности. Поэтому трудно понять, где именно "кроется" проблема: в planner, validator, executor или answer prompt.

## Как отражается в поведении

Availability:

- покупатель спрашивает "есть ли в наличии";
- contract repair может превратить ход в `lead_handoff`;
- cards могут быть показаны как supporting;
- frontend открывает lead form;
- answer repair добавляет "не обещаю склад".

Это верное бизнес-ограничение, но оно не должно уничтожать подбор или точность карточек.

## Лучший способ исправления

Разделить:

- `SemanticTurnContract`: только LLM meaning.
- `BusinessPolicyContract`: deterministic business constraints.
- `ExecutionContract`: объединенный результат.
- `ExecutionReport`: что реально было выполнено.

Пример:

```json
{
  "semantic": {"task": "pure_availability", "catalogAction": "exact_model_lookup"},
  "businessPolicy": {"stockPromise": "forbidden", "handoff": "required_for_live_stock"},
  "execution": {"showCards": "supporting_exact_or_close", "leadForm": "optional_after_answer"},
  "postconditions": ["no_live_stock_promise", "named_models_must_be_in_cards_or_exactMatches"]
}
```

## Что изменится после исправления

Ответ "есть ли TSS 10 кВт" станет стабильным:

- "В каталоге вижу такую/близкую карточку";
- "живой склад я не обещаю";
- "оставьте имя и телефон, проверю склад";
- карточка будет либо точная, либо явно отмеченная как близкая альтернатива.

## Риски после исправления

- Больше schema и кода вокруг контракта.

## Как закрыть риски

Сначала внедрять без переписывания всего `assistant.ts`: новый `buildExecutionContract(plan, agentContract, businessPolicy)` и golden tests на 20 ходов.

---

# Аудит 4. Память, контекст и смена требований

## Что проверялось

Как проект хранит явные и скрытые потребности, переключается между генератором и виброплитой, сохраняет требования бренда/топлива/мощности.

Ключевые места:

- `src/ai/needState.ts:209` - `mergeSemanticMemory`.
- `src/ai/assistant.ts:7162-7179` - update/preserve selection.
- `src/ai/assistant.ts:6613` - apply semantic memory to selection.
- `tests/agenticCycle876.test.ts:520-586` - воспроизводимый regression.

## Найдено

Память сильная: есть `semanticMemory`, `requirements`, `replacesRequirementIds`, `selectionPolicy`, `mentionedProducts`. Но реальное применение памяти в selection нестабильно.

Факт проверки:

```text
FAIL tests/agenticCycle876.test.ts:581
expected visible ids not to include other-8
visible ids include: tss-8, tss-10, other-8, ...
```

Тест проверяет, что когда later planner опускает brand/fuel, система должна сохранить LLM-extracted `brand=TSS` и `fuel=gasoline`. Сейчас этого не происходит полностью.

## Проблема

Сохранение semantic memory и применение hard constraints разнесены:

- LLM может записать requirement;
- `mergeProductSelectionState` может оставить часть state;
- `applyPlannerSelectionContract` может перетереть часть state;
- `relaxedPlannerOnlyOptionalGeneratorTraits` может ослабить constraints;
- alternatives могут добавиться после strict match.

## Как отражается в поведении

Покупатель:

1. "Нужен TSS бензиновый 8-10 кВт."
2. "Что есть в наличии?"

Неправильный риск: бот показывает 8 кВт другого бренда или дизельный вариант, потому что поздний planner не повторил brand/fuel.

## Лучший способ исправления

Ввести `RequirementLedger` как отдельную структуру authority:

- каждое требование имеет `id`, `kind`, `value`, `scope`, `source`, `status`, `strictness`;
- active constraints для selection строятся только из active ledger requirements;
- later planner не может "молчанием" удалить strict requirement;
- удалить можно только через explicit supersede/reject.

Selection executor должен принимать `ActiveSelectionConstraints`, а не собирать смысл заново из `userMessage + plan + memory text`.

## Что изменится после исправления

До:

- brand/fuel может потеряться, если planner в следующем ходе их не повторил.

После:

- "TSS" и "бензин" остаются active до явной отмены;
- если каталог не находит точных TSS gasoline 8-10 кВт, бот говорит об отсутствии точных совпадений и отдельно предлагает альтернативы, если разрешено.

## Риски после исправления

- Старые требования могут слишком долго держаться.

## Как закрыть риски

Добавить `scope`:

- `currentNeed`;
- `currentComparison`;
- `thisTurnOnly`;
- `untilSuperseded`.

И LLM contract должен возвращать `requirementsToPause` / `requirementsToSupersede`.

---

# Аудит 5. Каталог, retrieval, ranking и карточки

## Что проверялось

Как товары попадают в shortlist и frontend cards.

Ключевые места:

- `src/catalog/crawler.ts:145` - site crawl.
- `src/catalog/csvImport.ts:68` - CSV import.
- `src/db/repositories.ts:674` - product facts.
- `src/ai/assistant.ts:6598` - selection executor.
- `src/ai/assistant.ts:6951` - structured catalog slice.
- `src/ai/assistant.ts:5538` - card selection.
- `src/client/main.tsx:429` - product cards render.

## Найдено

Каталог строится из crawler и CSV, embeddings есть, facts сохраняются, conflicts обновляются. Но card pipeline имеет несколько независимых фильтров:

- product selection returns `matchedProducts`;
- structured slice может вернуть другой набор;
- card selection может добавить selected/ranked;
- frontend показывает count по всем cards, а initial visible count отдельно.

Особенно опасная зона:

- `src/ai/assistant.ts:5651` structuredSelectionAuthoritative;
- `src/ai/assistant.ts:5674` selected products branch;
- `src/ai/assistant.ts:5729` exact matches;
- `src/ai/assistant.ts:5758` ranked fallback.

## Проблема

Карточки должны быть доказательством ответа, но сейчас cards иногда становятся вторым подборщиком. Если ответ говорит "лучший вариант X", первая карточка должна быть X, а все cards должны соответствовать contract. Это частично проверяется `enforceAnswerCardContract`, но уже после генерации.

## Как отражается в поведении

Из production failure видно, что когда бот наконец показывает генераторы, он показывает 50 вариантов и первые 7, но это может быть слишком широкая выдача для покупателя. Для живого менеджера лучше: 1 главный, 2 альтернативы, и только потом "показать еще".

## Лучший способ исправления

Сделать `CardManifest` обязательным артефактом до answer generation:

```json
{
  "primaryCardIds": ["..."],
  "alternativeCardIds": ["..."],
  "hiddenCardIds": ["..."],
  "rejectedCardIds": [{"id": "...", "reason": "..."}],
  "cardClaims": {
    "firstCardMustMatchMainRecommendation": true,
    "allVisibleMustSatisfyHardConstraints": true
  }
}
```

Answer generator получает не просто `productCards`, а roles. Frontend отображает роли: "мой основной вариант", "альтернативы", "еще варианты".

## Что изменится после исправления

До:

- "подходящие варианты: 50 шт." может выглядеть как каталог, а не консультация.

После:

- бот ведет как менеджер: "Я бы начал с X; если хотите дешевле - Y; если нужен запас - Z";
- остальные cards остаются раскрываемыми и не мешают.

## Риски после исправления

- Слишком узкая выдача может скрыть полезный ассортимент.

## Как закрыть риски

Frontend показывает "еще N подходящих", но answer text фокусируется на 1-3 вариантах. В metadata сохранять полный slice для аудита.

---

# Аудит 6. Факты, web search и антигаллюцинации

## Что проверялось

Когда бот проверяет факты в сети, как хранит evidence, и запрещены ли неподтвержденные характеристики.

Ключевые места:

- `src/ai/assistant.ts:2830` - web search routing.
- `src/ai/assistant.ts:7898` - `web_search_preview`.
- `src/ai/assistant.ts:8446` - `storeVerifiedWebFindings`.
- `src/config.ts:79` - `OPENAI_ENABLE_WEB_FACT_EXTRACTION`.
- `src/ai/prompts.ts:137-144` - prompt policy.

## Найдено

Сильные стороны:

- Responses API web search используется через tool;
- citations извлекаются;
- verified web findings пишутся;
- LLM fact extraction использует strict JSON schema;
- prompt запрещает выдумывать характеристики.

Проблема: web routing решается в `shouldUseWebSearch`. Если `plan.agentDecision` есть, функция почти полностью доверяет `plan.needsWebSearch`, `verify_with_web`, `currentLineup`, `serviceCostComparison` и не проверяет фактические gaps по product data.

## Проблема

Фактологическая политика должна быть не "planner попросил web", а "answer claim требует source". Если каталог не содержит spec, а ответ хочет сказать spec, нужно либо web, либо "не вижу точного значения".

## Как отражается в поведении

Покупатель спрашивает "какой расход топлива у конкретного генератора". Если карточка не содержит расход, бот может ответить общим знанием или не пойти в web, если planner не поставил `needsWebSearch`.

## Лучший способ исправления

Добавить `FactClaimPlanner`:

1. До ответа определить, какие факты нужны: specs, compatibility, service interval, availability, delivery.
2. Для каждого факта определить source policy: `catalog`, `web`, `specialist`.
3. Запретить final answer claims, у которых нет source или specialist handoff.

Структура:

```json
{
  "requiredFacts": [
    {"claimType": "technical_spec", "attribute": "fuel_consumption", "productId": "...", "sourcePolicy": "web_required"}
  ]
}
```

## Что изменится после исправления

До:

- "расход примерно..." может появиться из модели.

После:

- "В карточке расход не указан. Я проверю внешние источники; если не найду надежно - скажу, что точное значение нужно сверить по паспорту/у специалиста."

## Риски после исправления

- Больше web calls, выше latency.

## Как закрыть риски

Кэшировать verified facts по `productId + attribute + sourceUrl`, TTL и confidence. Для service/general facts использовать troubleshooting memory.

---

# Аудит 7. Коммерческие ограничения и lead workflow

## Что проверялось

Как бот работает с доставкой, наличием, скидками, заявкой, контактом.

Ключевые места:

- `src/ai/agentTurnContract.ts:140-218` - availability/contact repairs.
- `src/ai/assistant.ts:6055` - auto lead from chat contact.
- `src/routes/leads.ts:20` - lead API.
- `src/client/main.tsx:477` - lead panel.
- `src/client/leadSubmit.ts:1` - lead submit timeout.

## Найдено

Бизнес-ограничения в целом правильные: не обещать склад/доставку/скидку, просить контакт для специалиста. Но lead pressure сейчас регулируется сразу несколькими слоями:

- planner fields;
- `contactRefusalText`;
- `shouldSuppressLeadRequestFromContract`;
- `stripLeadPressureTail`;
- frontend lead form auto-open;
- auto lead from message.

## Проблема

Lead collection должен быть результатом state machine, а не смесью текста, regex и UI. Покупатель может "пока без звонка", а UI все равно показывает форму из-за прошлого `leadRequested`. Или наоборот, дал телефон, а suppress logic решит не создавать lead.

## Как отражается в поведении

Production failure first turns: текст технически полезный, но в конце все равно появляется блок "актуальный склад сверю перед оформлением" и lead panel в интерфейсе, даже когда покупатель еще только подбирает генератор. Это может ощущаться как преждевременная продажа, а не консультация.

## Лучший способ исправления

Ввести `LeadStateMachine`:

- `not_relevant`;
- `eligible_after_answer`;
- `requested_by_bot`;
- `buyer_declined`;
- `buyer_provided_contact`;
- `lead_created`;
- `specialist_followup_required`.

LLM возвращает только semantic contact policy, deterministic code решает создание lead только при `buyer_provided_contact` и валидном contact.

## Что изменится после исправления

До:

- "оставьте контакт" может появляться как хвост.

После:

- технический подбор идет без давления;
- когда вопрос реально про склад/доставку/скидку, бот объясняет границу и предлагает контакт;
- если контакт уже дан, бот создает lead и не просит повторно.

## Риски после исправления

- Можно снизить conversion, если слишком редко показывать форму.

## Как закрыть риски

Разрешить мягкий CTA только после полноценного ответа и только при `leadTemperature >= warm`, но не как замена консультации.

---

# Аудит 8. Живое поведение как менеджер-продавец

## Что проверялось

Смотрел production live-cycle через существующий Playwright scenario: генератор для дачи, неизвестный насос, предварительный подбор, сравнение, параллельная виброплита, сервисный вопрос.

Artifact: `local-live-tests/production-agent-cycle-failure.json`.

## Найдено

Положительное:

- на первых ходах бот не показал генераторы при неизвестном насосе;
- объяснил пусковой риск;
- после уточнения скважинного насоса дал preliminary selection;
- при сравнении дешевле/без запаса ответил содержательно;
- при новой потребности по виброплите переключился и показал релевантные плиты.

Проблемы:

- live-cycle не завершился: input не стал enabled до timeout;
- sessionId не был получен в failure artifact, значит admin metadata audit не был выполнен;
- в некоторых ответах есть преждевременный коммерческий хвост про склад/отгрузку;
- при широких подборках показывается 50 товаров, что больше похоже на каталог, чем на менеджерский short-list.

## Проблема

Поведение стало лучше, чем "скрипт", но устойчивость диалога слабая: один зависший ввод делает весь агентский цикл непроходимым.

## Как отражается в поведении

Покупатель видит нормальные ответы, а потом не может продолжить, потому что поле ввода остается disabled. Это хуже, чем неправильная карточка: диалог полностью останавливается.

## Лучший способ исправления

Для live UX:

- frontend должен иметь fail-open strategy: если stream/recovery закончились ошибкой или idle timeout, input обязательно re-enabled;
- `done/error/recover` должны иметь idempotent state update;
- disabled input не должен зависеть только от happy path;
- recovery должен иметь свой max duration и visible state.

Для sales behavior:

- ограничить answer text до 1 главного варианта + 1-2 альтернатив;
- cards role-based;
- commercial handoff только когда покупатель дошел до commercial question или availability/stock.

## Что изменится после исправления

До:

- диалог может зависнуть после 6-7 хода.

После:

- даже при server timeout покупатель получает понятный recoverable state и может написать снова;
- менеджерский стиль: меньше "все 50 вариантов", больше "вот лучший выбор и почему".

## Риски после исправления

- Fail-open может позволить отправить новый message, пока старый еще writes.

## Как закрыть риски

Backend idempotency уже имеет `request_hash` и `turnId`; добавить client-side `activeTurnId` и server-side rejection/queue policy: один active turn per session.

---

# Аудит 9. Iframe, SSE, recovery и admin diagnostics

## Что проверялось

Транспортный слой, recovery, turn tracking, admin metadata.

Ключевые места:

- `src/routes/chat.ts:79` - SSE message route.
- `src/routes/chat.ts:159` - recovery route.
- `src/client/chatStream.ts:112` - stream client.
- `src/db/repositories.ts:422` - update turn.
- `sql/006_conversation_turns.sql:1` - turn table.

## Найдено

Сильные стороны:

- SSE sends `start`, `turn`, `status`, `delta`, `done`, `error`;
- turn table stores stage/status/planner contract;
- client has idle watchdog and one recovery attempt;
- assistant metadata stores `turnContract`, `productSelection`, `aiDiagnostics`, `cardSelection`, `cardContract`.

Проблемы:

- server timeout `GENERATION_TIMEOUT_MS = 120_000`, client idle timeout `45_000`; это может запускать recovery, пока backend еще работает;
- turn table хранит только текущий `planner_contract`, но не полную последовательность stage artifacts;
- live failure показал, что input state может не восстановиться;
- `production-agent-cycle-failure.json` имеет `sessionId: null`, значит audit metadata не всегда достижим из live script.

## Проблема

Диагностика есть, но она не полностью reconstructable. Когда поведение плохое, нужно видеть цепочку:

need extraction -> planner -> contract repair -> selection constraints -> cards -> answer request -> repairs -> final.

Сейчас это частично лежит в message metadata, частично в turn row, частично теряется при failure.

## Лучший способ исправления

Добавить `turn_events` таблицу:

- `turn_id`;
- `stage`;
- `input_snapshot`;
- `output_snapshot`;
- `warnings`;
- `duration_ms`;
- `model`;
- `response_id`;
- `request_id`;
- `error`.

На клиенте:

- `finally` всегда включает input;
- recovery не должен создавать дубль, если main turn completed;
- live script должен читать session id надежно из iframe storage или backend response.

## Что изменится после исправления

После любого плохого диалога можно будет точно сказать:

- LLM ошиблась в contract;
- validator repaired неправильно;
- selection executor добавил лишние cards;
- frontend recovery продублировал ответ;
- server timeout оборвал генерацию.

## Риски после исправления

- Metadata может стать тяжелой.

## Как закрыть риски

Сохранять compact snapshots: ids, enum, top warnings, hashes, short excerpts. Полный payload писать только при debug flag или failed turn.

---

# Аудит 10. Тесты, evals и production readiness

## Что проверялось

Насколько тесты доказывают качество агента и защищают от регрессий.

Ключевые места:

- `tests/agenticCycle876.test.ts`;
- `tests/agentTurnContract.test.ts`;
- `tests/recommendationRanking.test.ts`;
- `tests/liveAgentCycle.production.mjs`;
- `docs/EVALS.md`.

## Найдено

Сильные стороны:

- есть regression tests на contract, selection, answer fallback, SSE;
- есть production live scripts;
- тесты уже ловят реальную проблему, а не только syntax.

Проблемы:

- один целевой test сейчас падает;
- production live-cycle сейчас не прошел;
- PASS автоматического сценария не равен buyer-view quality audit;
- нет единого eval scorecard по 10-20 каноническим задачам менеджера.

## Проблема

Проект быстро развивается через точечные фиксы. Без eval matrix новый фикс availability может ломать selection memory, а фикс lead pressure может ломать conversion.

## Лучший способ исправления

Создать `evals/agent-manager-suite`:

1. Генератор для дачи с неизвестным насосом.
2. Генератор с точной мощностью и брендом.
3. "Есть ли в наличии X?"
4. "Пока без звонка".
5. Смена потребности на виброплиту.
6. Возврат к генератору.
7. Технический вопрос без cards.
8. Web-required spec gap.
9. Delivery/discount handoff.
10. Exact model absent but close alternative.
11. Accessory/consumable follow-up.
12. Неподходящая карточка и возражение покупателя.

Каждый eval должен проверять:

- buyer-view answer;
- card ids and roles;
- lead state;
- usedWebSearch;
- turnContract;
- no fallback diagnostics;
- no stale constraints;
- no unverified claims.

## Что изменится после исправления

Каждый merge будет отвечать на вопрос: "бот стал лучше как менеджер или просто прошел unit tests?"

## Риски после исправления

- Evals требуют времени и могут стать хрупкими.

## Как закрыть риски

Разделить:

- fast unit contract tests;
- local deterministic agent-cycle tests;
- nightly production live tests;
- manual buyer-view audit только для behavior changes.

---

# Опасные пересечения между аудитами

## 1. Contract repair vs semantic memory

Риск: contract repair может заставить cards/lead, а memory при этом держит старые constraints. Итог: правильная lead policy, но неправильные товары.

Решение: `ExecutionContract` должен включать frozen `ActiveSelectionConstraints`, которые selection executor не пересобирает.

## 2. Web search vs catalog authority

Риск: web search найдет внешнюю характеристику, но catalog cards показывают другой товар или старую карточку.

Решение: fact claims должны быть связаны с `productId` или явно помечены как generic technical guidance.

## 3. Lead handoff vs консультация

Риск: бизнес-ограничение по складу превращает техническую консультацию в форму заявки.

Решение: `leadExecution=eligible_after_answer`, а не `requiredNow`, пока покупатель не просит оформить/проверить склад/доставку.

## 4. Recovery vs main generation

Риск: recovery стартует при client idle 45s, backend еще генерирует до 120s. Возможны дубли, disabled input, conflicting messages.

Решение: согласовать таймауты, добавить active-turn lock и finalization idempotency.

## 5. Wide catalog slice vs sales answer

Риск: показывать 50 товаров полезно для каталога, но мешает ощущению личного менеджера.

Решение: role-based cards: 1 primary, 2 alternatives, hidden slice for "еще".

## 6. Regex hints vs LLM intelligence

Риск: проект снова начнет чиниться частными правилами.

Решение: запретить semantic regex в production path. Regex может быть только fact extractor или diagnostic mismatch detector.

---

# План исправления

## Phase 0. Стабилизировать текущую ветку

Цель: не строить дальше поверх падающего agent-cycle.

Действия:

1. Исправить regression `tests/agenticCycle876.test.ts:581`: active brand/fuel constraints из semantic memory должны фильтровать `matchedProducts`, `visibleProducts`, alternatives и close exact lookup.
2. Добавить тест, что `catalogShortlistAlternatives` не нарушают strict `brand`/`fuel`, если `semanticMemory.selectionPolicy.strictOnly=true`.
3. Прогнать целевой набор:
   - `npm run typecheck`;
   - `npm test -- --run tests/agenticCycle876.test.ts tests/agentTurnContract.test.ts tests/recommendationRanking.test.ts tests/turnContract.test.ts`.

Ожидаемый результат: selection не показывает `other-8` и `tss-diesel`, если active requirements требуют TSS gasoline.

## Phase 1. Ввести ExecutionContract

Цель: убрать split brain.

Действия:

1. Создать `src/ai/executionContract.ts`.
2. Собрать `ExecutionContract` из `AgentTurnContract`, `ResolvedTurnContract`, business policy и active requirements.
3. Запретить downstream менять `action`, `cardsRole`, `leadPolicy`, `requiredConstraints`.
4. Все repairs перевести в `validatorWarnings` + `contractRepair` object.

Ожидаемый результат: один артефакт объясняет весь ход и управляет всеми исполнителями.

## Phase 2. RequirementLedger вместо смешанной памяти

Цель: сохранить смысл диалога между ходами.

Действия:

1. Добавить typed active requirements с scope/status/strictness.
2. Selection executor принимает compiled hard constraints.
3. Later planner может supersede/reject, но не удалять молчанием.

Ожидаемый результат: смена требований работает явно, старые constraints не протекают в новые needs и не исчезают без причины.

## Phase 3. Перевести regex в hints/validators

Цель: остановить рост костылей.

Действия:

1. Провести inventory semantic regex:
   - `contactRefusalText`;
   - `inferProductIntent`;
   - availability/current-lineup fallback;
   - product card follow-up;
   - lead suppression;
   - web search fallback.
2. Оставить regex как `FactExtractor` только для чисел/моделей/телефонов/единиц.
3. Semantic decisions делать через structured planner и validator retry.

Ожидаемый результат: поведение меняется через agent contract, а не через новый if/else под фразу.

## Phase 4. CardManifest и role-based cards

Цель: cards становятся доказательством ответа.

Действия:

1. В selection result добавить `primary`, `alternatives`, `supporting`, `hidden`.
2. Answer generator получает card roles.
3. Frontend отображает основной вариант и альтернативы отдельно.
4. `enforceAnswerCardContract` проверяет roles.

Ожидаемый результат: покупатель видит не "50 товаров", а менеджерский выбор с расширяемым каталогом.

## Phase 5. FactClaimPlanner и grounding

Цель: не галлюцинировать характеристики.

Действия:

1. Перед answer generation строить список required claims.
2. Для каждого claim требовать source: catalog/web/specialist.
3. Если source missing, answer должен говорить "не вижу точного значения", а не выдумывать.
4. Сохранять verified facts с productId/attribute/sourceUrl/confidence.

Ожидаемый результат: web search используется не "по настроению planner", а когда ответу реально нужен внешний факт.

## Phase 6. LeadStateMachine

Цель: коммерческий handoff без давления и без потери заявок.

Действия:

1. Ввести lead state на turn/session.
2. Отделить `contactPolicy` от `leadCreated`.
3. Auto lead создавать только при валидном контакте.
4. UI lead form показывать по lead state, а не только `leadRequested`.

Ожидаемый результат: бот консультирует до конца, но уверенно собирает заявку, когда это нужно.

## Phase 7. SSE/recovery hardening

Цель: live-cycle не должен зависать.

Действия:

1. Согласовать client/server timeouts.
2. В client `finally` гарантировать re-enable input.
3. Добавить active-turn state и idempotent recovery.
4. Recovery не должен показывать cards без contract.
5. Live script должен всегда сохранять sessionId или диагностировать, почему он недоступен.

Ожидаемый результат: `npm run test:live:production` не падает на disabled input.

## Phase 8. Observability

Цель: любой плохой диалог должен быть объясним.

Действия:

1. Добавить `turn_events`.
2. Логировать stage artifacts compactly.
3. Сохранять OpenAI `response.id` и request id, если доступен SDK.
4. Admin UI показывает timeline: need -> planner -> contract -> selection -> answer -> recovery.

Ожидаемый результат: аудит не требует гадать по финальному тексту.

## Phase 9. Eval suite

Цель: качество проверяется как агент, а не как набор функций.

Действия:

1. Создать 12 canonical scenarios.
2. Проверять answer, cards, lead, facts, metadata.
3. Быстрый local suite в PR.
4. Nightly production suite через `bakautprof.ru`.
5. Manual buyer-view protocol для behavior changes.

Ожидаемый результат: каждый фикс доказывает, что бот стал лучше как менеджер.

## Phase 10. Финальная приемка

Критерии готовности:

- `npm run typecheck` PASS;
- full relevant tests PASS;
- agent eval suite PASS;
- production live-cycle PASS;
- нет `legacy_text_fallback`;
- нет AI fallback diagnostics;
- cards соответствуют `ExecutionContract`;
- no unverified technical claims;
- contact refusal respected;
- delivery/stock/discount never promised as fact;
- buyer can complete 8-10 turn dialogue without disabled input.

---

# Приоритеты

P0:

1. Исправить constraint preservation regression.
2. Исправить production disabled-input/recovery failure.
3. Запретить alternatives, нарушающие strict active constraints.

P1:

4. ExecutionContract.
5. RequirementLedger.
6. LeadStateMachine.

P2:

7. CardManifest.
8. FactClaimPlanner.
9. turn_events observability.
10. eval suite.

---

# Текущий статус после аудита

Сборка:

- `npm run typecheck` - PASS.

Тесты:

- targeted agent suite - FAIL:
  - `tests/agenticCycle876.test.ts:581`;
  - проблема: `visibleProducts` содержит `other-8`, хотя должны остаться TSS gasoline constraints.

Production live:

- `npm run test:live:production` - FAIL:
  - ошибка: `Chat input did not become enabled before timeout`;
  - artifact: `local-live-tests/production-agent-cycle-failure.json`;
  - sessionId: `null`, admin metadata audit не выполнен.

Вывод:

Проект уже движется в правильную сторону: есть LLM planner, strict JSON, metadata, tests и production scripts. Но до надежного AI-менеджера нужно убрать конкурирующие semantic-решения из deterministic-кода, сделать единый execution contract, стабилизировать память требований, привязать карточки к contract и закрыть live recovery. После этих изменений бот станет не набором частных правил, а управляемым агентом: LLM понимает диалог, код проверяет факты и исполняет безопасно.
