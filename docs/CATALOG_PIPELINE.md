# Catalog Pipeline

## Источники

1. Crawler сайта `bakautprof.ru`.
2. CSV-импорт.

CSV имеет более высокий приоритет, потому что может содержать внутренние уточнения. Но при конфликте значений факт не затирается молча: сохраняются оба значения и создается `data_conflict`.

## Crawler

Запуск:

```bash
npm run catalog:sync
npm run catalog:sync -- --max-pages=50
npm run catalog:sync -- --start-path=/catalog/vibroplity/ --max-pages=160
```

Crawler посещает страницы `/catalog/`, извлекает:

- название;
- категорию;
- цену, если найдена;
- изображение;
- описание;
- таблицы и списки характеристик;
- URL карточки.

Обычный crawler и CSV import считаются частичными запусками: они обновляют `last_seen_at`/`last_synced_at` и реактивируют найденные записи, но никогда не деактивируют отсутствующие товары.

## Полный sitemap sync и freshness

```bash
npm run catalog:sync:sitemap
npm run catalog:health
```

Каждый sync создаёт `catalog_sync_runs`, держит единый advisory lock изменений каталога и во время длительных циклов обновляет heartbeat не чаще одного раза в 20 секунд, а при ошибке heartbeat завершает run как failed. Затем sync пишет coverage и counts. Автоматическая деактивация unseen site products/pages разрешена только полному sitemap-запуску без URL/max-page ограничений, который завершился с полной coverage и нулём ошибок. При partial/failed run каталог остаётся активным fail-safe.

`CATALOG_STALE_AFTER_HOURS` задаёт порог stale (default 48 часов). Состояние доступно в `/api/admin/catalog/freshness` и защищённом `/api/admin/health`; публичный `/api/health` операционные данные не раскрывает. Для production нужен внешний Railway cron/расписание полного sitemap sync; приложение само не создаёт cron job.

Все HTTP-загрузки crawler/sitemap проходят exact-origin, DNS/IP и redirect-проверку, timeout и byte limits. Private/reserved адреса блокируются, DNS-адрес закрепляется на проверенном запросе. Admin CSV import принимает только обычные `.csv` внутри `CATALOG_IMPORT_ROOT`, с лимитами размера, записи и количества строк; локальный CLI может явно импортировать доверенный файл вне этого root.

### Защита целостности полного sync

Все site crawl и CSV import используют один глобальный PostgreSQL advisory lock. Поэтому разные sitemap URL, redirect-алиасы и разные CSV-файлы не могут одновременно изменять каталог.

Перед деактивацией full sitemap sync сравнивает количество найденных товаров и страниц с текущим активным каталогом. Минимум для каждого типа записей вычисляется как `min(active, max(floor, ceil(active * ratio)))`. Значения задаются через `CATALOG_DEACTIVATION_MIN_DISCOVERY_RATIO` (по умолчанию `0.8`) и `CATALOG_DEACTIVATION_MIN_DISCOVERY_FLOOR` (по умолчанию `100`). Если непустой sitemap резко меньше активного каталога, run завершается как failed до записи и ничего не деактивирует. При первоначально пустом каталоге guard разрешает bootstrap; обычные проверки полной coverage и отсутствия ошибок продолжают действовать.

## CSV

Запуск:

```bash
npm run catalog:import -- ./catalog.csv
```

Поддерживаются русские и английские заголовки:

- `name` / `название`
- `external_id` / `артикул` / `sku`
- `source_url` / `url`
- `brand` / `бренд`
- `category` / `категория`
- `price` / `цена`
- `image_url` / `картинка`
- `description` / `описание`

Все остальные колонки становятся характеристиками товара.

## Поиск

Используется гибрид:

- PostgreSQL full-text search;
- pgvector embeddings;
- фильтрация и сортировка по найденным товарам.

Buyer retrieval исключает записи с `is_active=false`. Structured selection дополнительно проверяет typed hard constraints и не считает отсутствующую характеристику доказанным соответствием.

Embeddings создаются через `text-embedding-3-small`, если задан `OPENAI_API_KEY`.
