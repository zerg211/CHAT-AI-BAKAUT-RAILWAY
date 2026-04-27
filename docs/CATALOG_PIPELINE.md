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

Embeddings создаются через `text-embedding-3-small`, если задан `OPENAI_API_KEY`.
