# Production live-test spend guard, 2026-05-17

## Что найдено

`tests/remediationPostdeploy.mjs` после проверки production marker автоматически запускал два длинных production live-цикла:

- `npm run test:live:production`
- `npm run test:live:production:876`

Это опасно для текущего проекта, потому что Railway подтягивает GitHub, а production live-циклы работают через реальный iframe на `https://bakautprof.ru/` и реальный OpenAI API. После каждого деплоя такой сценарий мог снова создавать много дорогих диалогов, даже когда требовалась только проверка факта деплоя.

Дополнительно в runtime не было durable ledger по расходу OpenAI: `DEBUG_OPENAI_USAGE` мог печатать usage в лог, но не сохранял его в базу с привязкой к session/turn/source. Из-за этого после аномалии приходилось восстанавливать расход косвенно по диалогам и admin metadata.

## Где проблема была скрыта

- `tests/remediationPostdeploy.mjs`: автоматический запуск production live gates после marker.
- `tests/liveAgentCycle.production.mjs`, `tests/liveAgentCycle.876.production.mjs`, `tests/liveAgentCycle.diverse.production.mjs`: production-скрипты можно было запустить без явного подтверждения, что это финальный gate.
- `src/ai/assistant.ts` и `src/ai/openaiClient.ts`: OpenAI usage не сохранялся как структурированное событие.
- `src/routes/chat.ts`: OpenAI-вызовы не получали runtime-контекст `sessionId`, `turnId`, `pageUrl`, `userAgent`, поэтому нельзя было надежно отделить production buyer traffic от HeadlessChrome тестов.

## Что изменено

- Добавлена таблица `openai_usage_events` в `sql/007_openai_usage_events.sql`.
- Добавлен `src/ai/openaiUsageGuard.ts`:
  - хранит OpenAI context через `AsyncLocalStorage`;
  - классифицирует источники: `production_live_test`, `production_widget`, `local_widget`, `automated_browser`, `unknown`;
  - сохраняет usage по stage/model/session/turn/source;
  - блокирует OpenAI-вызовы при превышении дневного budget.
- `src/routes/chat.ts` оборачивает генерацию и recovery в OpenAI usage context.
- `src/ai/openaiClient.ts` проверяет budget перед `responses.create` и embedding-вызовами.
- `src/ai/assistant.ts` теперь пишет usage в ledger даже при выключенном `DEBUG_OPENAI_USAGE`.
- Добавлен admin endpoint `GET /api/admin/openai-usage?hours=24&source=production_live_test`.
- Production live-скрипты заблокированы по умолчанию через `tests/productionLiveGate.mjs`.
- `tests/remediationPostdeploy.mjs` теперь по умолчанию проверяет production marker и пропускает live-диалоги; live запускается только при явном `RUN_REMEDIATION_POSTDEPLOY_LIVE=1`.

## Новое поведение

Обычный postdeploy больше не запускает дорогие диалоги сам.

Финальный production live gate теперь требует явного набора env:

```bash
RUN_REMEDIATION_POSTDEPLOY_LIVE=1
ALLOW_PRODUCTION_LIVE_TESTS=1
FINAL_RELEASE_LIVE_GATE=1
ALLOW_FIXED_PRODUCTION_REPLAY=1
```

Для HeadlessChrome-трафика на `bakautprof.ru` включен отдельный дневной лимит:

- `OPENAI_HEADLESS_DAILY_TOKEN_BUDGET=600000` по умолчанию;
- `OPENAI_BUDGET_GUARD_RESERVE_TOKENS=16000`;
- общий buyer-budget выключен по умолчанию: `OPENAI_DAILY_TOKEN_BUDGET=0`, чтобы случайно не заблокировать реальных покупателей.

Пример эффекта: если production live-тесты за последние 24 часа уже потратили около 150k токенов, следующий OpenAI-вызов из HeadlessChrome production widget будет остановлен до API-запроса.

## Проверка

Локально выполнено:

- `npm.cmd run typecheck`
- `npm.cmd test -- tests\openaiUsageGuard.test.ts tests\productionLiveGate.test.ts tests\migrate.test.ts tests\openaiClient.test.ts`
- `npm.cmd test`

Результат полного suite: 29 test files passed, 316 tests passed.

Production live-диалоги не запускались, потому что по новой политике они должны выполняться только один раз перед финальным запуском/пушем с неповторяющимися формулировками и ручным аудитом ответов плюс metadata.

## Остаточные риски

- Ledger начинает считать токены только после деплоя этой версии и применения migration; прошлые расходы он не восстановит.
- Budget guard блокирует по уже записанным событиям, поэтому один очень дорогой отдельный вызов может пройти, если до него лимит еще не был почти исчерпан.
- Для реальных покупателей общий `OPENAI_DAILY_TOKEN_BUDGET` по умолчанию выключен. Если нужно жестко ограничивать весь OpenAI spend, его надо выставить явно на Railway.

## Следующий правильный шаг

Продолжать исправления локально без production live-диалогов. Перед финальным запуском подготовить один новый varied production audit script или ручной live-протокол с неповторяющимися репликами, затем один раз запустить final gate и сверить:

- фактический текст в widget;
- карточки товаров;
- admin metadata;
- `turnContract`;
- `cardManifest`;
- `openai_usage_events`.
