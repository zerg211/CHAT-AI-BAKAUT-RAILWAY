# Railway Deploy

## Сервисы

- Web service из этого репозитория.
- PostgreSQL service.

## Переменные

Обязательные:

- `DATABASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL=gpt-5.6-luna`
- production runtime принудительно использует `gpt-5.6-luna` для семантического планирования и единственной генерации ответа; preflight отклоняет любой другой фактический model marker;
- `ADMIN_API_KEY`
- `PUBLIC_BASE_URL`

Email через уже настроенный HTTP-механизм:

- `EMAIL_HTTP_URL`
- `EMAIL_HTTP_METHOD`
- `EMAIL_HTTP_AUTH_HEADER`
- `EMAIL_FROM`
- `LEADS_TO_EMAIL`

SMTP не используется.

## Деплой

Railway подключён к GitHub и подтягивает изменения автоматически. Разрешённый production flow:

1. `npm run verify`;
2. осознанный `git commit`;
3. `git push` в GitHub;
4. ожидание Railway deployment из этого commit;
5. проверка `/api/health` и production widget.

Не запускать `railway up`, `railway deploy`, `railway deployment up` и другие ручные upload-команды, если пользователь явно не запросил ручной Railway-деплой.

`railway.json` выполняет миграции отдельной pre-deploy командой, затем запускает сервер:

```bash
node dist/server/db/migrate.js
node dist/server/server.js
```

Dockerfile содержит эквивалентный безопасный fallback `node dist/server/db/migrate.js && node dist/server/server.js`; при Railway deployment authoritative-команды заданы в `railway.json`.

Healthcheck:

```text
/api/health
```

## Перед продом

1. Прогнать `npm run verify` и `npm audit --omit=dev --audit-level=high`.
2. Убедиться, что миграции additive и сохранён rollback commit/ref.
3. После push дождаться, пока публичный `/api/health` покажет новый commit и ожидаемые `runtime.version`, `runtime.contractVersion` и `runtime.productionRuntime`; внутренние artifact names в публичный marker не входят.
4. С admin bearer проверить `/api/admin/health`: полный runtime/policy manifest, freshness каталога, embedding coverage и lead-outbox backlog/failures.
5. Открыть встроенный виджет на `https://bakautprof.ru/` и провести адаптивный живой тест, не localhost/прямой API.
6. Сверить UI каждого turn с `/api/admin/conversations/:id`, agent traces, cards, tool evidence, warnings и recovery state.
7. Сохранить production-протокол и raw evidence в task directory или `local-live-tests/*.production.md`.

## Rollback

Rollback выполняется через GitHub: revert проблемного commit и push. Railway автоматически разворачивает revert. Миграции текущего цикла не удаляют старые данные/колонки, поэтому откат кода не требует destructive SQL. После rollback снова проверить commit marker, health и виджет.
