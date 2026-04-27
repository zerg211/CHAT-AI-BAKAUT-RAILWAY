# БАКАУТ AI Sales Assistant

AI-виджет для сайта БАКАУТ: консультирует покупателей, подбирает строительное и силовое оборудование, показывает карточки товаров и собирает заявки для профильного специалиста.

## Быстрый старт локально

```bash
cp .env.example .env
docker compose up -d
npm install
npm run migrate
npm run dev
```

Открыть виджет: `http://localhost:3010/widget`

Если Vite dev server работает отдельно, Fastify сам отдаст `/widget` с подключением `http://localhost:5173/main.tsx`.

## Основные команды

```bash
npm run dev              # backend + frontend
npm run migrate          # SQL-миграции
npm run catalog:sync     # ручной crawler сайта bakautprof.ru
npm run catalog:import -- ./catalog.csv
npm run test
npm run typecheck
npm run build
npm run start
```

## Переменные окружения

См. `.env.example`. Минимум для живого AI:

- `DATABASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL=gpt-5.4`
- `EMAIL_HTTP_URL` и связанные email-переменные на Railway

Локально без `OPENAI_API_KEY` чат продолжит работать в fallback-режиме, но это не считается полноценной проверкой AI-поведения.

## Вставка на сайт

```html
<script src="https://your-railway-domain/embed.js" async></script>
```

Скрипт создает iframe с `/widget`.

## API

- `POST /api/chat/sessions`
- `POST /api/chat/sessions/:id/messages`
- `POST /api/chat/sessions/:id/heartbeat`
- `POST /api/chat/sessions/:id/close`
- `POST /api/leads`
- `POST /api/admin/catalog/import-csv`
- `POST /api/admin/catalog/sync-site`
- `GET /api/admin/conversations`
- `GET /api/admin/leads`
- `GET /api/admin/conflicts`

Admin endpoints требуют `Authorization: Bearer <ADMIN_API_KEY>`.

## Quality gate

Все изменения поведения ассистента проверяются локально через браузер и живой диалог в интерфейсе. Протокол сохраняется в `local-live-tests/*.local.md`.
