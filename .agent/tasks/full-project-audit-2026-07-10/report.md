# Полный аудит проекта chatAI: AI-менеджер БАКАУТ

Дата статического аудита: 2026-07-10
Ревизия: `2ce1ce43b3804b72e723d403fc355a66331b3358` (`main`)
Режим: анализ без изменения исходного кода и без деплоя.

## 1. Итог

Проект уже реализует значительную часть полноценного AI-менеджера: production-виджет, LLM-планирование, typed intent/answer contracts, каталог с full-text и pgvector, web research, durable dialogue ledger, карточки, локальное сохранение лидов, email outbox, tracing, recovery route и большой набор тестов.

Но текущая реализация еще не готова считаться завершенным универсальным менеджером компании. Главная причина — незавершенная архитектурная миграция. В репозитории одновременно существуют:

1. старый runtime в `AssistantService` с `CustomerNeedState`, `AgentTurnContractV2`, policy gate, requirement ledger, post-answer verification и множеством repairs;
2. новый production runtime в `AgentManagerOrchestrator` с другим ledger, другим intent contract, другим answer contract, другим reviewer и отдельным card selection;
3. документация и health marker, которые смешивают артефакты этих двух контуров и создают впечатление, что весь старый remediation stack работает внутри нового runtime.

Фактически production по умолчанию идет через новый `AgentManagerOrchestrator`, а значительная часть старой продуманной инфраструктуры поведения и проверок не участвует в этом пути. Вместо единого источника политики новый orchestrator содержит растущий набор частных правил для генераторов, виброплит, аккумуляторных станций, алмазных дисков и бюджета.

### Оценка готовности

| Область | Оценка | Комментарий |
|---|---:|---|
| Виджет и базовый диалог | 8/10 | Production iframe, SSE, heartbeat, feedback UI и recovery UX реализованы. |
| LLM как менеджер | 6/10 | LLM планирует и пишет ответ, но semantic policy частично подменяется кодом и category-specific prompt rules. |
| Память и контекст | 5/10 | Durable ledger есть, но session state не синхронизируется, compaction отсутствует, история обрезается. |
| Каталог и карточки | 7/10 | Сильный гибридный поиск и проверки карточек, но много частных семантических фильтров и нет встроенной гарантии свежести. |
| Проверка фактов/web | 7/10 | Web research и verified fact memory реально используются; tool contracts недостаточно узкие. |
| Лиды и передача менеджеру | 6/10 | Outbox и retries есть, но checkpoint recovery способен повторить side effect. |
| Recovery/idempotency | 4/10 | Есть durable artifacts и atomic assistant save, но восстановление не resume-based; найдены два серьезных дефекта. |
| Наблюдаемость/evals | 6/10 | Метаданные и traces богаты, но health marker частично недостоверен, feedback не замыкает цикл. |
| Эксплуатационная готовность | 5/10 | Build проходит, но guard и полный test gate не полностью зеленые; есть уязвимые зависимости. |

Итоговая оценка: **6/10 — сильный работающий прототип с реальным agentic core, но с критическим долгом в idempotency/recovery и с незавершенным объединением архитектуры.**

## 2. Изначальный замысел

Первоначальный замысел проекта последовательно читается из README, product docs и истории Git:

- встроенный AI-виджет для `bakautprof.ru`;
- консультация по строительному и силовому оборудованию;
- понимание задачи покупателя и контекста нескольких ходов;
- подбор товаров из реального каталога и показ карточек;
- проверка отсутствующих или конфликтных технических фактов через web search;
- безопасные ответы по наличию, доставке, скидкам и срокам;
- ведение к заявке без преждевременного давления на контакт;
- работа как живой менеджер, а не как сценарный бот.

В мае замысел был расширен до полноценного harness:

```text
user message
-> durable turn
-> LLM state delta
-> dialogue ledger
-> LLM intent contract
-> typed tools
-> tool artifacts
-> LLM answer contract
-> pre-send review
-> idempotent assistant message
-> widget
```

Это правильное направление: LLM должна понимать смысл, выбирать следующий шаг и формулировать ответ; код должен хранить состояние, выполнять инструменты, проверять факты и ограничения, обеспечивать idempotency и не допускать ложных обещаний.

## 3. Фактическая архитектура

### 3.1 Активный end-to-end поток

1. `src/routes/widget.ts` отдает iframe и embed launcher.
2. React-виджет создает/возобновляет session, хранит `sessionId` в `sessionStorage`, отправляет heartbeat и `sendBeacon` при закрытии вкладки.
3. `POST /api/chat/sessions/:id/messages` создает `conversation_turn` и начинает SSE.
4. `AssistantService.generateAnswer()` проверяет runtime mode.
5. При production-default `AGENT_MANAGER_HARNESS_ENABLED=true` вызов сразу передается в `AgentManagerOrchestrator.generateAnswer()`.
6. Новый orchestrator:
   - сохраняет user message;
   - генерирует LLM ledger delta;
   - применяет append-only ledger events;
   - генерирует LLM intent contract;
   - deterministic repair добавляет обязательный catalog/web tool, если planner нарушил grounding;
   - выполняет catalog/calculator/web/lead tools;
   - дополнительно фильтрует/заменяет товары;
   - генерирует LLM answer contract;
   - выполняет mechanical review и опциональный LLM review;
   - отдельно выбирает buyer-visible cards;
   - сохраняет final answer contract, metadata и assistant message.
7. Виджет получает один финальный `delta` и `done`, показывает ответ, карточки и при необходимости lead form.
8. Lead outbox worker отправляет сохраненные заявки через HTTP email endpoint.

### 3.2 Два параллельных runtime

`src/ai/assistant.ts` вырос до 12 477 строк и остается контейнером старого runtime. Новый production путь вызывается ранним return на строках около 9930, поэтому большая часть оставшегося кода не участвует в production-ответе при включенном harness.

Новый `agentManagerOrchestrator.ts` сам вырос до 4 191 строки и повторно реализует планирование, поиск, research, lead capture, review, карточки и recovery. В результате проект не завершил декомпозицию: один god-runtime сменился вторым, а первый не удален.

## 4. Матрица функций

| Функция | Статус | Фактическое состояние |
|---|---|---|
| Production iframe widget | Используется | Embed script, iframe, mobile layout, session lifecycle работают. |
| SSE progress/answer | Используется | Есть status events и recovery; token-by-token stream в новом runtime отсутствует, финальный текст приходит одним delta. |
| Session heartbeat/expiry | Используется | Heartbeat и 30-минутный expiry реализованы. |
| LLM state extraction | Используется | Новый ledger delta создается LLM на каждом ходе. |
| Durable dialogue ledger | Используется частично | Events сохраняются, но derived state не пишется в `conversation_sessions.need_state`; нет compaction/snapshot strategy. |
| LLM intent planner | Используется | Возвращает intent, grounding и tool requests. |
| Typed tool registry | Частично | Имена и outer contract типизированы, но `args` — произвольный JSON object без per-tool schema. |
| Catalog full-text search | Используется | PostgreSQL search работает как основной retrieval. |
| pgvector | Условно используется | Включается только при достаточном embedding coverage; текущее production coverage статически не подтверждено. |
| Catalog/site knowledge pages | Есть, но active-path coverage ограничен | Старый runtime явно искал `catalog_pages`; новый в основном ищет products и web facts. |
| Web search | Используется | `web.researchProductFacts` вызывает Responses web search через comparison research. |
| Verified web fact memory | Используется | Проверенные факты сохраняются и повторно читаются. |
| Data quality issues | Используется частично | Web/catalog conflicts записываются автоматически; planner tool `dataQuality.createIssue` из spec не реализован. |
| Product card readiness | Используется | LLM readiness + deterministic filter/suppression. |
| Lead capture in chat | Используется | LLM tool создает local lead и outbox при наличии контакта/имени. |
| Lead form | Используется | Отдельный `/api/leads`; заявка сохраняется даже при outbox failure. |
| Email outbox/retry | Используется | Worker стартует при active harness, retries с backoff. |
| Checkpoint recovery | Частично | Checkpoints пишутся, но recovery не возобновляется с последнего checkpoint — pipeline запускается заново. |
| Atomic assistant save | Используется | Turn row lock не дает сохранить второй assistant message. |
| Pre-send mechanical review | Используется | Факты, lead confirmation и часть catalog policies проверяются кодом. |
| Pre-send LLM reviewer | Реализован, default-off | Включается только `AGENT_MANAGER_PRE_SEND_REVIEW_ENABLED`; переменная отсутствует в `.env.example`. |
| Canonical sales behavior policy | Не используется active runtime | Dynamic policy подключена к legacy prompts, но не к `AgentManagerOrchestrator`. |
| AgentContractV2/executionContract/policyGate stack | Legacy-only | Health marker заявляет их как runtime artifacts, но новый production orchestrator их не создает. |
| Feedback loop | Не завершен | 👍/👎/wrong cards записываются в message metadata, но не конвертируются в очередь review/eval/regression. |
| Catalog refresh schedule | Не найден | Есть manual/admin sync, но runtime/Railway cron не настроен в репозитории. |
| Context compaction | Не реализован | Последние 80 messages + до 500 ledger events; structured compaction/rehydration отсутствует. |

## 5. Критические и существенные находки

### P0. Повтор одинаковой реплики возвращает старый turn

Доказательство:

- `src/routes/chat.ts:32-34` строит request hash только из `sessionId + message text`;
- `src/db/repositories.ts:528-545` ищет любой прежний active/completed turn с тем же hash;
- новый random `requestedTurnId` в таком случае игнорируется;
- `AgentManagerOrchestrator.executeTurn()` сначала возвращает completed payload найденного turn.

Практический эффект: обычные повторяющиеся реплики покупателя — «да», «покажите», «а дешевле?», повторный номер/город — могут вернуть ответ от более раннего места диалога. Это ломает контекст и делает менеджера непредсказуемым.

Правильная граница: idempotency — deterministic code, но ключ должен быть уникальным client request/turn id, а не содержимым реплики. Повтор текста в другое время является новым бизнес-событием.

Рекомендация: принимать `clientMessageId`/`idempotencyKey`, делать unique `(session_id, client_message_id)`, не дедуплицировать по тексту.

### P0. Recovery повторно исполняет side effects и может создать дубли лидов

Доказательство:

- `recoverTurn()` на `agentManagerOrchestrator.ts:2390-2403` снова вызывает весь `executeTurn()`;
- checkpoints и saved tool artifacts не читаются для resume;
- `lead.capture` на `agentManagerOrchestrator.ts:3322-3378` повторно создает lead, если текущая сохраненная user message снова содержит contact;
- existing lead reuse применяется только когда `currentTurnHasContact=false`.

Если первый запуск создал lead/outbox и упал до final answer, recovery снова выполнит planner/tools и способен создать второй lead. Web calls и другие дорогие операции также повторяются.

Рекомендация: recovery должен читать checkpoint/tool artifacts; completed tools возвращать как observations без повторного исполнения. Side-effect tool обязан иметь idempotency key `(sessionId, turnId, toolRequestId)` на уровне бизнес-записи, а не только artifact row.

### P1. Новый production runtime не использует каноническую policy поведения

`salesManagerBehaviorPolicy.ts` подключен только в legacy `assistant.ts/prompts.ts`. `AgentManagerOrchestrator` не импортирует его и содержит отдельный большой hardcoded system prompt.

Эффект:

- `docs/SALES_MANAGER_BEHAVIOR_POLICY.md` не является фактическим source of truth для active runtime;
- изменения business behavior могут исправлять legacy path, не затрагивая production;
- правила расходятся и дублируются;
- owner feedback не имеет одного надежного места применения.

Рекомендация: один versioned policy pack, который получает planner, writer и reviewer нового runtime; кодовые invariants отдельно.

### P1. Feature flags не соответствуют фактическому поведению

В `src/config.ts:84-91` объявлены флаги ledger, LLM answer, checkpoint recovery, comparison research, lead outbox и reviewer. В active orchestrator только reviewer реально проверяется как capability gate. Ledger, LLM answer, recovery и comparison выполняются независимо от своих флагов; outbox worker стартует при включенном global harness даже при своем флаге false.

Эффект: rollout/rollback план из spec не работает по заявленным capability boundaries. Оператор не может безопасно отключить одну неисправную подсистему.

Рекомендация: либо удалить устаревшие флаги после полного cutover и документировать atomic runtime, либо реально оградить capability paths и протестировать матрицу конфигураций.

### P1. Session memory не синхронизирована и не масштабируется на длинный диалог

Новый runtime формирует `needStateSnapshot` из ledger, но не вызывает `updateNeedState`, `updateSessionTopic` или `updateHistorySummary`. История ограничена 80 сообщениями, ledger — 500 events; compaction/snapshot/rehydration нет.

Дополнительно `deriveNeedStateSnapshotFromLedger()` определяет product class regex-правилами только для generator/plate/rammer/cutter/commercial. Остальные категории получают `unknown`.

Эффект:

- session/admin state может оставаться пустым или устаревшим;
- legacy helpers и lead summaries получают не тот state;
- после длинного диалога ранние buyer constraints исчезнут из message context;
- product classes вне ограниченного списка хуже представлены в derived state.

Рекомендация: ledger остается source of truth, но нужен durable reduced snapshot с typed needs/scopes, periodic compaction и rehydration. Product class должен приходить из LLM events/typed ontology, а не выводиться regex reducer-ом.

### P1. Recovery из final answer contract теряет карточки и tool metadata

Если final answer contract сохранен, а assistant message еще нет, `completedFromFinalAnswerContract()` восстанавливает только текст и возвращает `productCards: []`, `usedWebSearch: false`.

Эффект: текст может ссылаться на варианты, но UI не покажет карточки; restored metadata не отражает фактически выполненные tools.

Рекомендация: final turn artifact должен атомарно содержать answer + render/card manifest + tool/result refs + lead state. Recovery воспроизводит тот же user-visible payload.

### P1. Семантические решения снова накапливаются в deterministic слоях

Обязательный `lint:no-regex` обнаруживает 91 новый regex construct поверх baseline. Особенно важны не форматные regex, а semantic ветки:

- category inference в `dialogueLedgerReducer.ts`;
- product/material/task classification;
- plate weight/task replacement;
- battery station intent/power source;
- generator phase/load/budget interpretation;
- fixed weight ranges and replacement queries.

Часть deterministic кода правильна:

- числовая нормализация Вт/кВт;
- проверка 220/380 В;
- budget/weight/spec comparisons;
- запрет карточки, нарушающей hard constraint;
- existence in catalog;
- source/evidence ID validation;
- commercial promises and lead confirmation invariants.

Но понимание «что покупатель имеет в виду», смена товарного класса, допустимость альтернативы, важность ограничения и роль упомянутой модели должны возвращаться planner-ом структурированно.

### P1. Tool contracts недостаточно узкие и нет per-turn execution budgets

`ToolRequestSchema.args` — `Record<string, unknown>`, а `toolRequests` не имеет max length. Runtime последовательно выполняет все requests. Есть общий route timeout и daily token guard, но buyer token budget по умолчанию равен 0, то есть выключен.

Рекомендация:

- discriminated union с отдельной strict schema для каждого tool;
- max tool calls/model turns/web calls;
- per-turn token/cost budget;
- deterministic ordering и duplicate request collapse;
- timeout/retry policy per tool.

### P1. Health marker сообщает артефакты legacy runtime как активные

`src/app.ts:14-29` публикует `agentContractV2`, `executionContract`, `requirementLedger`, `policyGate`, `cardManifest`, `factClaimPlanner`, `leadStateMachine`, `postAnswerVerification` как runtime artifacts. Новый orchestrator их не создает; он использует другой набор contracts.

Эффект: deployment marker и диагностика могут подтверждать несуществующую защиту.

Рекомендация: marker должен генерироваться из реального active runtime contract version и содержать только фактически emitted artifacts.

### P2. LLM pre-send reviewer выключен по умолчанию

Mechanical reviewer полезен, но не заменяет semantic review для противоречивых консультаций. `AGENT_MANAGER_PRE_SEND_REVIEW_ENABLED` default false и не описан в `.env.example`.

Нужно принять явное продуктовое решение: либо включить reviewer для high-risk turns по risk-tier policy, либо удалить иллюзию полного review. Оптимальный вариант — selective reviewer для technical conflict, web disagreement, commercial promise и complex comparison, а не для каждого простого ответа.

### P2. Feedback не становится улучшением системы

UI и endpoint сохраняют rating, admin показывает его, но нет:

- review queue;
- связи negative/wrong_cards с turn contracts/tool results;
- экспорта в eval fixtures;
- метрики regression rate по policy/model/version.

Рекомендация: nightly/manual feedback triage и автоматическое создание candidate eval cases без автоматического изменения prompt.

### P2. Каталог не имеет репозиторного freshness loop

Есть crawler, sitemap sync, CSV import и embedding backfill, но нет cron/scheduler в Railway config или server runtime. Возможно, refresh запускается внешне — это не подтверждено.

Рекомендация: явный source freshness record, last successful sync, stale threshold, admin alert и отдельный scheduled job. Не запускать тяжелый crawl внутри web process.

### P2. Тестовый gate не полностью зеленый

- `npm run typecheck` — PASS;
- `npm run build` — PASS;
- `npm test` — 768 PASS, 1 FAIL из-за 5s timeout в `productionLiveGate.test.ts`;
- isolated test с `--testTimeout=15000` — PASS;
- `npm run lint:no-regex` — FAIL, 91 constructs;
- `git diff --check` — PASS с line-ending warnings в уже измененных пользователем evidence files.

Таймаутный тест сам по себе похож на нестабильность под параллельной нагрузкой, но completion gate формально не зеленый.

### P2. Уязвимые production dependencies

`npm audit --omit=dev` нашел 4 vulnerabilities: 2 high и 2 moderate. Прямые зависимости:

- `undici@7.25.0` — high/moderate advisories, fix available;
- `js-yaml@4.1.1` — moderate advisory, fix available.

Также уязвимы transitive `ws` и `brace-expansion`. Нужен controlled dependency update с regression tests для crawler, web research, email и OpenAI SDK.

### P3. Документация описывает разные поколения системы

- README все еще говорит, что behavior quality gate — локальный диалог, что противоречит текущему `AGENTS.md`;
- `ARCHITECTURE.md` описывает `CustomerNeedState` как активный шаг, но production использует ledger-derived snapshot;
- feature flags и runtime artifacts документированы как при поэтапной миграции, хотя active runtime уже переключен целиком.

## 6. Где код ограничивает или подменяет LLM

| Решение | Сейчас | Должно быть |
|---|---|---|
| Определить текущий товарный класс | LLM + regex/product classifiers + repairs | LLM typed intent/product mentions; код валидирует ontology. |
| Понять смену темы | LLM ledger delta + deterministic continuity heuristics | LLM scope delta: open/pause/resume/close need; reducer применяет события. |
| Решить, допустима ли альтернатива | Частично hardcoded filters/nearest alternatives | LLM `alternativePolicy` с причиной; код исключает hard violations. |
| Понять роль числа | Много regex around kW/weight/budget | LLM typed requirement `{kind, value, unit, role, strictness, evidence}`; код парсит/нормализует число и проверяет. |
| Выбрать следующий вопрос | LLM, затем repairs/required clauses | LLM `questions[{slot, whyNeeded, changesDecision}]`; код запрещает closed/redundant question. |
| Выбрать карточки | LLM readiness + крупный deterministic selector | LLM shortlist intent/ranking rationale; код применяет hard filters и stable sort. |
| Проверить 220/380, мощность, бюджет, вес | Deterministic | Оставить deterministic. |
| Проверить наличие товара в каталоге | Deterministic repository | Оставить deterministic. |
| Точное наличие/доставка/скидка | Prompt + reviewer | Оставить business invariant в коде; LLM выбирает безопасную формулировку/lead next step. |
| Проверить evidence refs | Deterministic reviewer | Оставить deterministic. |
| Сформулировать живой ответ | LLM + deterministic rewrites | LLM; код не должен переписывать смысл, только block/retry при доказанном нарушении. |

### Рекомендуемый структурированный planner result

```ts
type ManagerTurnPlan = {
  currentNeed: {
    needId: string;
    operation: 'open' | 'update' | 'resume' | 'pause' | 'close';
    productClass: ProductClass | 'unknown';
    buyerGoal: string;
  };
  requirements: Array<{
    id: string;
    kind: 'task' | 'power' | 'phase' | 'fuel' | 'weight' | 'budget' | 'material' | 'compatibility' | 'commercial' | 'other';
    value: unknown;
    unit?: string;
    role: 'hard' | 'soft' | 'context' | 'rejected';
    strictness: 'exact' | 'range' | 'preference' | 'alternative_allowed';
    evidence: string;
  }>;
  mentionedProducts: Array<{
    name: string;
    role: 'target' | 'comparison' | 'context_device' | 'previous_option' | 'rejected';
  }>;
  nextAction: 'answer' | 'catalog_search' | 'fact_research' | 'calculate' | 'clarify' | 'lead_capture';
  tools: TypedToolRequest[];
  alternativePolicy: {
    allowed: boolean;
    relaxableRequirementIds: string[];
    rationale: string;
  };
  cardPolicy: {
    readiness: 'none' | 'preliminary' | 'exact';
    rankingPriorities: string[];
    maxCards: number;
  };
  questions: Array<{
    questionId: string;
    asksForRequirementId: string;
    whyNeeded: string;
    changesDecision: boolean;
  }>;
  riskFlags: string[];
};
```

## 7. Неиспользуемое, дублирующее и недозавершенное

1. Большая legacy-ветка `AssistantService` не используется при production-default harness, но продолжает компилироваться и поддерживаться.
2. `AgentTurnContractV2`, execution contract, requirement ledger, policy gate, card manifest, fact-claim planner/audit, lead state machine и post-answer verification относятся в основном к legacy pipeline.
3. Dynamic sales behavior policy также относится к legacy prompts и не включена в новый orchestrator.
4. Пять capability flags фактически стали configuration fossils.
5. `history_summary` и `updateHistorySummary()` не участвуют в новом runtime.
6. `conversation_sessions.need_state/topic` обновляются legacy path, но не новым runtime.
7. Checkpoint tables существуют, но полноценного checkpoint resume нет.
8. Feedback capture существует, feedback-driven eval pipeline отсутствует.
9. Data-quality tool из frozen spec отсутствует как planner-callable tool; часть функции заменена side effect внутри web research.
10. Health remediation marker остался от предыдущего поколения контрактов.

## 8. Что сделано хорошо и должно быть сохранено

- Responses API используется с JSON schema formats и Zod validation.
- У каждого выполненного tool request создается structured result, включая error/denied/not_found.
- User message и assistant message привязаны к durable turn.
- Assistant persistence использует row lock и idempotent writer.
- Web facts имеют source URLs/evidence и могут сохраняться как verified memory.
- Catalog results проходят factual filters, а карточки могут быть заблокированы отдельно от текста.
- Lead сохраняется локально до email delivery; outbox retry отделяет buyer UX от транспорта.
- Admin UI показывает contracts, warnings, traces и product cards.
- Production widget verification реально выполнялась для последних scoped fixes 2026-07-08 и привязана к commit marker.
- Большой regression suite покрывает многие реальные инциденты.

## 9. Целевая архитектура

```text
Widget message + clientMessageId
  -> one active turn policy / durable turn
  -> context builder
       stable behavior policy
       compacted ledger snapshot
       recent exact messages
       relevant verified facts/catalog state
  -> LLM DialogueStateDelta
  -> deterministic ledger reducer
  -> LLM ManagerTurnPlan (single semantic authority)
  -> typed tool registry
       catalog.search
       catalog.details
       generator.calculate
       web.researchFacts
       lead.prepare/capture
  -> deterministic factual/policy validators
  -> LLM AnswerContract + RenderContract
  -> selective semantic reviewer by risk tier
  -> atomic FinalTurnArtifact
       answer
       cards/render manifest
       tool refs
       lead state
       review
  -> idempotent assistant save / exact recovery replay
```

Основные принципы:

1. Один active runtime и один contract vocabulary.
2. Один versioned source of truth для поведения менеджера.
3. LLM решает смысл и next step; код проверяет факты, ограничения и side effects.
4. Recovery не рассуждает заново, если уже есть валидный artifact.
5. Все side effects имеют бизнес-idempotency key.
6. Session memory переживает длинный диалог через snapshot + compaction.
7. Каждая production ошибка становится eval case или validator, а не новой фразой в giant prompt.

## 10. План исправлений

### Этап 0. Исправить P0 idempotency/recovery

- Ввести `clientMessageId` и перестать дедуплицировать по тексту.
- Ввести one-active-turn/queue policy.
- Реализовать checkpoint resume и чтение tool artifacts.
- Сделать lead capture уникальным по `(sessionId, turnId, toolRequestId)`.
- Сохранять final render/card payload вместе с answer contract.

Критерии:

- две одинаковые реплики подряд создают два turn и получают контекстно разные ответы;
- retry одного HTTP request не создает второй turn;
- crash после lead capture не создает второй lead/email;
- recovery возвращает те же cards/metadata.

### Этап 1. Объединить runtime и policy

- Зафиксировать новый canonical contract set.
- Подключить versioned behavior policy к planner/writer/reviewer.
- Перенести только реально полезные invariants из legacy modules.
- Удалить или изолировать legacy runtime после parity evals.
- Исправить health marker и feature flags.

Критерии:

- production call graph имеет один answer writer;
- behavior policy hash/version виден в trace;
- нет ложных runtime artifacts;
- отключение capability либо реально работает, либо флаг удален.

### Этап 2. Вернуть semantic authority LLM

- Ввести единый `ManagerTurnPlan`.
- Удалить semantic regex/keyword routing из reducer/card selection.
- Оставить numeric/factual/business validators.
- Разложить giant prompts на stable policy + focused contracts.

Критерии:

- `lint:no-regex` PASS;
- новые товарные классы не требуют нового if-else в orchestrator;
- смена требований/темы проходит через typed delta;
- hard violations механически блокируются.

### Этап 3. Память и compaction

- Сохранять reduced ledger snapshot и current needs.
- Добавить bounded compaction с rehydration.
- Разделить current need, paused needs, commercial/contact facts и verified product facts.
- Убрать ограниченную regex-классификацию product class.

Критерии:

- диалог >80 сообщений сохраняет ранние active constraints;
- correction supersedes old fact;
- возврат к paused need восстанавливает только его требования;
- admin session state совпадает с answer metadata.

### Этап 4. Tool safety, cost и operations

- Per-tool strict schemas и budgets.
- Selective reviewer по risk tier.
- Catalog freshness scheduler/monitor.
- Feedback review queue -> eval candidates.
- Обновить dependencies.
- Актуализировать README/architecture/runbooks.

Критерии:

- typecheck/build/tests/no-regex/audit gates green;
- catalog freshness видна в admin/health;
- negative feedback можно трассировать до policy/model/tool versions;
- production live audit покрывает не один fixed сценарий, а адаптивные диалоги по нескольким классам товара.

## 11. Проверки

| Проверка | Результат |
|---|---|
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm test -- --run` | FAIL: 768/769; один timeout test |
| isolated `productionLiveGate.test.ts` с 15s | PASS: 5/5 |
| `npm run lint:no-regex` | FAIL: 91 new constructs |
| `npm audit --omit=dev` | FAIL: 4 vulnerabilities, 2 high |
| `git diff --check` | PASS; только CRLF warnings в существующих user-modified evidence files |
| Production widget scoped evidence 2026-07-08 | PASS по сохраненному протоколу; полный аудит всех функций не проводился в этом turn |

## 12. Требует уточнения или доработки

- Не подтверждены текущие значения Railway environment: capability flags, buyer token budget, CORS allowlist, email recipients.
- Не запрашивалось и не выполнялось чтение production PostgreSQL, поэтому фактическая свежесть каталога, embedding coverage, outbox backlog, feedback rate и open data-quality issues неизвестны.
- Сохраненный production протокол 2026-07-08 подтверждает последние scoped fixes, но не является полным адаптивным аудитом менеджера по всем товарным классам и длинной памяти.
- Для финального product-quality verdict нужен отдельный живой аудит через `bakautprof.ru`: несколько естественных диалогов, каждый следующий ход — по фактическому ответу, с одновременной проверкой admin traces/contracts.
