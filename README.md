# БАКАУТ AI Sales Assistant

Продовый AI-менеджер для сайта БАКАУТ. Он ведёт свободный диалог с покупателем, консультирует по строительному и силовому оборудованию, уточняет задачу, проверяет факты, подбирает товары, показывает согласованные с ответом карточки и передаёт заявку профильному специалисту.

Активный production runtime один: `AgentManagerOrchestrator` + GPT-5.6 Luna (`gpt-5.6-luna`) через OpenAI Responses API. LLM отвечает за понимание смысла и стратегию разговора; код — за каталог, схемы, доказательства, жёсткие ограничения, безопасность, побочные эффекты и восстановление.

## Локальный запуск

```bash
cp .env.example .env
docker compose up -d
npm install
npm run migrate
npm run dev
```

Локальный виджет доступен на `http://localhost:3010/widget`. Он подходит для UI-разработки и проверок с моками. Локальные вызовы OpenAI в этой среде не являются валидной проверкой поведения; release-проверка AI проводится только после GitHub/Railway-деплоя через встроенный виджет на `https://bakautprof.ru/`.

## Основные команды

```bash
npm run verify                 # полный локальный release gate
npm run typecheck
npm test
npm run test:eval:agentic
npm run lint:no-regex
npm run build
npm run migrate
npm run catalog:sync:sitemap   # полный sitemap-sync с freshness lifecycle
npm run catalog:health
npm run embeddings:coverage
npm run feedback:export-evals -- --output .private/feedback-candidates.json --acknowledge-unverified-residual-pii
```

## Конфигурация

См. `.env.example`. Для production обязательны `DATABASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-5.6-luna`, `ADMIN_API_KEY`, `PUBLIC_BASE_URL` и HTTP email-настройки. SMTP не используется. Активный production AgentManager закрепляет семантическое решение и единственную генерацию ответа на `gpt-5.6-luna`; отдельного LLM-review и альтернативного fallback-ответа нет. После генерации код только детерминированно проверяет контракт и либо сохраняет исходный ответ, либо отклоняет весь ход. `CATALOG_STALE_AFTER_HOURS` по умолчанию равен `48`.

## Надёжность диалога

- Виджет генерирует стабильный `clientMessageId`; повтор того же HTTP-запроса восстанавливает тот же turn, а два одинаковых сообщения пользователя остаются двумя отдельными turn.
- Один session не исполняет два turn одновременно; lease, checkpoints и tool artifacts позволяют продолжить прерванный turn без повторных инструментов и заявок.
- Финальный response payload сохраняется до доставки клиенту и восстанавливается вместе с текстом, карточками и metadata.
- Память хранится как semantic dialogue ledger: активные/приостановленные потребности, факты, исправления, вопросы и выбранные/отклонённые товары. Snapshot + новый tail сохраняют актуальное состояние длинного диалога.

## Admin и наблюдаемость

Admin endpoints требуют `Authorization: Bearer <ADMIN_API_KEY>`.

- `/api/admin/conversations`, `/:id`, `/:id/agent-traces`
- `/api/admin/leads`, `/api/admin/conflicts`, `/api/admin/products`
- `/api/admin/feedback` и `/api/admin/feedback/:id/export-candidate`
- `/api/admin/catalog/freshness`, `/api/admin/embedding-coverage`
- `/api/admin/health` — модели, полный runtime manifest, catalog/embedding/outbox health
- `/api/admin/runtime/openai`, `/api/admin/openai-usage`

Публичный `GET /api/health` содержит только deployment marker: commit и минимальные runtime/contract версии. Модели, полный список runtime artifacts, policy hash и операционные сигналы доступны только в защищённом `/api/admin/health`.

## Документация

Актуальные источники истины и их приоритет перечислены в `docs/RULES_INDEX.md`. Целевая архитектура доменного агента и граница между retrieval и обучением зафиксированы в `docs/DOMAIN_AGENT_BLUEPRINT.md`. Старые планы и отчёты удалены из рабочего дерева и доступны только через Git history, чтобы завершённые задания не воспринимались как действующие инструкции.

## Деплой и проверка

Изменения уходят только через `git commit` + `git push`; Railway автоматически собирает GitHub-ветку. Ручной `railway up/deploy` не используется. После появления нового commit marker в `/api/health` проводится адаптивный диалог через виджет на `bakautprof.ru`, затем каждый turn сверяется с карточками, trace/metadata и кодом. См. `docs/RAILWAY_DEPLOY.md` и `docs/LOCAL_LIVE_TESTING.md`.
