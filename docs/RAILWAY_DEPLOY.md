# Railway Deploy

## Сервисы

- Web service из этого репозитория.
- PostgreSQL service.

## Переменные

Обязательные:

- `DATABASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL=gpt-5.4`
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

`railway.json` запускает:

```bash
npm run migrate && npm run start
```

Healthcheck:

```text
/api/health
```

## Перед продом

1. Прогнать `npm run test`.
2. Прогнать `npm run build`.
3. После деплоя открыть встроенный виджет на `https://bakautprof.ru/`.
4. Провести живой тест поведения только через сайтовый виджет, не через localhost, локальный iframe или прямой API.
5. Сохранить протокол в `local-live-tests/*.production.md` или другой `.md` файл с явной пометкой, что проверка была через `bakautprof.ru`.
