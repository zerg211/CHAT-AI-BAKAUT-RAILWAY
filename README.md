# БАКАУТ AI Sales Assistant

Продовый AI-менеджер для сайта БАКАУТ. Он ведёт свободный диалог с покупателем, консультирует по строительному и силовому оборудованию, уточняет задачу, проверяет факты, подбирает товары, показывает согласованные с ответом карточки и передаёт заявку профильному специалисту.

Точка входа чата `AssistantService` вызывает `PlatformAgentAssistant`. Он работает с сохранённым агентом OpenAI Platform. В текущем рабочем дереве консультации по известным товарам также используют `ControlledResponsesClient` с полными оригиналами карточек. Модель определяет смысл запроса и пригодность товара; код проверяет идентификаторы, полноту загрузки, согласованность карточек, ограничения и сохранение результата.

Рабочее дерево и production могут отличаться. Проверяйте commit сайта и каталог отдельно перед выпуском. `AgentManagerOrchestrator` остаётся в репозитории, но не является обработчиком `AssistantService`. Его тесты и проверки доказательств не подтверждают поведение активного пути.

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
npm run test:acceptance:live -- --approve-paid --max-agent-turns N --max-judge-calls N --max-http-requests N
npm run lint:no-regex
npm run build
npm run migrate
npm run catalog:sync:sitemap   # полный sitemap-sync с freshness lifecycle
npm run catalog:health
npm run embeddings:coverage
npm run feedback:export-evals -- --output .private/feedback-candidates.json --acknowledge-unverified-residual-pii
```

## Конфигурация

См. `.env.example` и `src/config.ts`. Активный путь требует `DATABASE_URL`, `OPENAI_API_KEY`, `OPENAI_PLATFORM_AGENT_ID`, доступа к MCP-каталогу и настроек публичного адреса. Модель берётся из сохранённого агента. `OPENAI_MODEL` не заменяет эту настройку; текущий `ControlledResponsesClient` допускает только `gpt-6-luna`. Для администрирования нужен `ADMIN_API_KEY`, для отправки заявок используются HTTP email-настройки.

В рабочем дереве внешний поиск через сервер требует обоих флагов `CONTROLLED_WEB_SEARCH_ENABLED` и `CONTROLLED_WEB_SEARCH_FEES_APPROVED`. По умолчанию они выключены; локальный `web_search_facts` возвращает недоступность. Денежная защита opt-in блокирует неподдержанные пути, но это не доказанный денежный лимит работающего автономного агента. Не переносите эти свойства на уже опубликованную версию без проверки.

## Надёжность диалога

- Виджет использует `clientMessageId`; сервер сохраняет turn, владельца исполнения, checkpoints и итоговое сообщение.
- В контролируемом пути неизвестный исход POST не запускает автоматическую повторную генерацию. При известном response ID восстановление читает тот же ответ.
- Полные карточки загружаются по всем страницам одной ревизии. Превышение контекста вызывает ошибку, а не скрытое сокращение набора.
- История известных товаров отличается от истории показанных карточек. Повреждённая запись истории сохраняет корректные ID и передаёт модели отдельное состояние неполноты. Исходные сообщения не изменяются.
- Проверка `selected`, `rejected`, `uncertain` и `comparison_ids` предотвращает неизвестные ID и несогласованную классификацию. Она сама не доказывает истинность текста.
- `answer_review` в рабочем дереве является самооценкой модели. Независимая проверка утверждений и привязка каждого факта к источнику ещё не гарантированы активным путём.
- Виджет получает полный список карточек и раскрывает его порциями по 10 без нового обращения к модели.
- Модель выбирает следующие поисковые шаги. Каждый шаг сохраняет источники, ID ответа и отдельный ключ отправки; восстановление читает тот же ответ. Истечение окна HTTP передаёт виджету статус продолжения, сохраняя исследование. Покупатель может отменить текущий запрос. Постоянные ограничения расходов продолжают действовать.

Аудит состояния и последовательность разработки находятся в `.agent/tasks/2026-11-14-catalog-agent-audit/`. Локальные тесты не заменяют проверку опубликованной версии в виджете `bakautprof.ru`.

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
