# Адаптивный покупатель для живого виджета

Скрипт `npm run live:adaptive-buyer` открывает сайт обычным видимым браузером Playwright и общается со встроенным виджетом через его интерфейс. Он нужен для разнообразных диалогов о строительной и силовой технике: простых, с несколькими связанными потребностями и необычных, но правдоподобных.

## Как формируется диалог

В начале сессии Codex CLI создаёт только внутренний профиль покупателя и его цель. Список фраз и порядок ходов заранее не создаются. Перед каждой репликой скрипт читает все сообщения, уже видимые в этом окне виджета, включая приветствие, последний ответ и текущие карточки товаров. Затем модель выдаёт ровно одну следующую реплику. Поэтому следующий вопрос зависит от фактического ответа помощника.

Текст покупателя звучит как обычная переписка. В нём запрещены упоминания теста, проверки, аудита и модели, а также подсказки помощнику о том, как отвечать или что искать. Если помощник просит контакт, симулируемый покупатель вежливо отказывается. Скрипт не придумывает контактные данные и не отправляет заявку.

## Подготовка

Требуются Windows PowerShell, Node.js 22 или новее, установленные зависимости проекта, установленный и авторизованный Codex CLI, а также Chrome/Edge или браузер Chromium для Playwright.

```powershell
Set-Location C:\Projects\chatAI
npm ci
codex --version
```

Если в системе нет Chrome или Edge и Playwright не находит свой Chromium, установите его один раз:

```powershell
npx playwright install chromium
```

Чтобы запускать установленный Chrome/Edge из нестандартной папки, задайте `PLAYWRIGHT_CHROME_PATH` или `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

## Безопасная проверка без запуска браузера

Обычный запуск — сухой: он не открывает браузер, сайт, Codex CLI или виджет.

```powershell
npm run live:adaptive-buyer -- --help
npm run live:adaptive-buyer -- --dry-run --sessions 3 --max-turns 8
```

В сухом отчёте должны появиться три типа ситуаций: `simple`, `compound`, `unusual`. Лимит — от 1 до 6 диалогов и от 1 до 12 ходов на диалог.

## Preview

Запускайте preview только после того, как координатор/исполнитель зафиксировали готовность конкретной сборки и подтвердили тестовое окно. Сам Node-скрипт не опрашивает другие задачи Codex: оператор передаёт в `APPROVED_PREVIEW_BUILD_SHA` полный SHA из этого статуса, а `ALLOW_PREVIEW_LIVE_TESTS=1` включает отдельный запуск. Раннер сверяет этот статус со сборкой и остановится при несовпадении. Preview-диалог расходует использование Codex и вызывает тестируемый виджет; это не приёмка production.

```powershell
$env:ALLOW_PREVIEW_LIVE_TESTS = "1"
$env:APPROVED_PREVIEW_BUILD_SHA = "<полный подтверждённый commit SHA из 40 hex-символов>"
$env:ADMIN_API_KEY = "<токен только для чтения admin API>"

npm run live:adaptive-buyer -- --live --target preview `
  --site-url "<подтверждённая страница виджета preview>" `
  --api-base "<origin API preview>" `
  --sessions 3 --max-turns 8

Remove-Item Env:ALLOW_PREVIEW_LIVE_TESTS, Env:APPROVED_PREVIEW_BUILD_SHA, Env:ADMIN_API_KEY
```

Раннер сверит точный полный preview commit SHA со значением `APPROVED_PREVIEW_BUILD_SHA` по `/api/health` до диалога и после запуска. Подтверждённый и фактический SHA попадут в отчёт. Если SHA не совпадёт или сборка поменяется во время работы, результат будет заблокирован.

## Финальная production-проверка

Production-цель всегда закреплена за `https://bakautprof.ru/`. При изменении поведения ассистента соблюдайте полный порядок из [LOCAL_LIVE_TESTING.md](LOCAL_LIVE_TESTING.md): успешный `npm run verify`, commit/push, подтверждение нового commit/runtime marker и готовности виджета. Запускайте production-тест на финальном release gate.

```powershell
$env:ALLOW_PRODUCTION_LIVE_TESTS = "1"
$env:FINAL_RELEASE_LIVE_GATE = "1"
$env:ADMIN_API_KEY = "<токен только для чтения admin API>"

npm run live:adaptive-buyer -- --live --target production `
  --sessions 3 --max-turns 8

Remove-Item Env:ALLOW_PRODUCTION_LIVE_TESTS, Env:FINAL_RELEASE_LIVE_GATE, Env:ADMIN_API_KEY
```

В production-режиме дополнительно проверяются runtime marker и доступный запас OpenAI usage. Секреты не сохраняются в отчёт. При необходимости origin API можно задать `--api-base "https://<origin API>"`.

Если ответ ассистента обычно готовится дольше семи минут, можно увеличить ожидание переменной `LIVE_BUYER_ASSISTANT_WAIT_MS` (допустимый диапазон 30 000–900 000 миллисекунд; по умолчанию 420 000). Production API origin берётся из `PRODUCTION_API_BASE`, если он задан, иначе определяется по origin виджета.

## Ожидаемые артефакты и разбор

Для каждого запуска создаётся папка `local-live-tests/<время>-adaptive-buyer-<target>/`. В ней будут JSON-отчёт, Markdown-протокол, JSON-данные по диалогам и скриншот каждого завершённого хода. Для текущей сессии также считываются admin conversation metadata и agent traces через read-only API.

После запуска вручную пройдите каждый ход: сравните скриншот и карточки, которые видел покупатель, с admin metadata, предупреждениями, recovery/fallback и trace. Автоматический отчёт всегда оставляет `HUMAN_REVIEW_PENDING`; он не объявляет качество диалога принятым. Если ответ, карточки, скриншот или обязательные agent traces не удалось собрать, результат помечается `BLOCKED`/`INCOMPLETE`.

Сухой режим не тратит usage. Любой `--live` запуск расходует использование Codex CLI для генерации покупателя и вызывает модель в выбранном виджете. Для этого проекта локальный OpenAI API не используется. Этот скрипт не меняет код или базу ассистента, не делает деплой, не создаёт лиды и не заменяет обязательный ручной аудит через production-виджет. Полный release-прогон с проверкой успешной заявки остаётся отдельным тестом с явно разрешённой тестовой заявкой.
