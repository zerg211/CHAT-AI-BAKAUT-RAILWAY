# Architecture

## Активный runtime

Production-ответ создаёт только `AgentManagerOrchestrator`. Runtime manifest находится в `src/ai/aiManagerRuntimeManifest.ts`. Публичный `/api/health` отдаёт минимальный commit/runtime marker, а полный manifest и policy pack доступны через защищённый `/api/admin/health`. Старые deterministic writers не участвуют в активном пути.

Основные компоненты:

- `src/server.ts`, `src/app.ts` — Fastify, маршруты, health и фоновые операции;
- `src/client/*` — React iframe-виджет и стабильная идентификация действий пользователя;
- `src/ai/agentManager*` — planner, строгие контракты, tools, budget, writer, risk review и card validation;
- `src/ai/dialogueLedgerReducer.ts` — semantic memory snapshot + tail;
- `src/catalog/*` — crawler, sitemap/CSV sync, freshness и hybrid retrieval;
- `src/db/*`, `sql/*` — PostgreSQL, pgvector, turns/checkpoints/artifacts/feedback/outbox;
- `src/email/*` — HTTP email transport и durable lead outbox.

## Граница LLM и кода

LLM возвращает строгий структурированный план: смысл реплики, действие с потребностью, свободный `targetProductClass`, известный canonical class при уверенности, роль/строгость каждого требования, политику альтернатив, вопросы и tool requests. Writer отдельно возвращает естественный ответ и `selectedProductIds`.

Код не угадывает намерение по словам. Он:

- валидирует JSON Schema/Zod contracts и tool arguments;
- исполняет catalog/web/calculator/lead tools с лимитами;
- проверяет текущие факты, provenance и hard constraints;
- запрещает карточки, противоречащие бюджету, мощности, весу, питанию, фазе и выбранной LLM политике альтернатив;
- проверяет, что видимые карточки названы в ответе и разрешены evidence set;
- применяет запреты на неподтверждённые наличие, скидку, доставку, сроки и спецусловия;
- обеспечивает idempotency, persistence, recovery и audit trace.

## Поток turn

1. Виджет создаёт `clientMessageId` и отправляет сообщение.
2. Backend атомарно claims/reuses turn по `(sessionId, clientMessageId)`, сохраняет user message и берёт execution lease.
3. Snapshot + tail восстанавливают semantic ledger; planner получает текущее состояние и canonical policy.
4. Строгие tool requests проходят локальную валидацию, risk/side-effect policy, timeout/retry/result limits и общий turn budget.
5. Tool results сохраняются как artifacts и передаются модели только как недоверенные evidence data.
6. Writer формирует ответ и выбирает IDs. Deterministic verifier проверяет claims, hard fit и card/text consistency; risk-review запускается по `AI_MANAGER_REVIEW_MODE`.
7. Полный response payload и финальный checkpoint сохраняются до отправки покупателю; assistant message сохраняется один раз.
8. При retry/recovery уже завершённые stages/tools не запускаются повторно, а сохранённый payload возвращается без изменений.

## Память

Dialogue ledger хранит события с монотонной последовательностью и reduced snapshot: активную и приостановленные потребности, подтверждённые/отменённые факты, requirements с evidence, открытые вопросы, selected/rejected products, contact/approval state и source references. После compaction replay `snapshot + newest tail` эквивалентен полному replay, поэтому позднее исправление не теряется из-за лимита истории.

## Ограничители и side effects

Каждый tool имеет отдельную strict schema, risk class, timeout, размер результата и retries. Общий turn budget ограничивает model/tool/web calls, bytes, wall time, output tokens и оценочную стоимость. `lead.capture` разрешается только при текущем намерении и наличии контакта; уникальный origin turn/tool request и durable outbox не допускают двойной заявки или повторной отправки.

## Операционная готовность

Публичный `/api/health` показывает только deployment marker. Защищённый `/api/admin/health` показывает active runtime/policy, catalog freshness, embedding coverage и lead-outbox backlog/failures. Полный sitemap sync может деактивировать пропавшие позиции только после coverage-complete запуска без ошибок; частичный crawler/CSV sync этого не делает. Негативный feedback и `wrong_cards` попадают в review queue; их PII-reduced экспорт требует явного подтверждения риска остаточных персональных данных и обязательной ручной проверки до commit/use.
