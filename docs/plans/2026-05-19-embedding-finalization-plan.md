# Embedding Retrieval Finalization Plan

Дата: 2026-05-19

## Короткий статус

Текущий результат не финальный.

Кодовая инфраструктура embeddings уже подготовлена и защищена от главных минусов, но production-ready результат еще не достигнут, потому что:

1. embeddings в локальной базе пока не заполнены: `products=3955 embedded=0`, `catalog_pages=102 embedded=0`, `troubleshooting_cases=1 embedded=0`;
2. нет admin endpoint/report для постоянного контроля coverage;
3. backfill не запускался на production PostgreSQL;
4. изменения не закоммичены и не запушены;
5. не проведена обязательная live-проверка через production widget на `https://bakautprof.ru/`.

## Что уже внедрено

1. Schema metadata:
   - `embedding_model`;
   - `embedding_source_hash`;
   - `embedding_updated_at`.

2. Миграция:
   - `sql/008_embedding_metadata.sql`;
   - repair-логика в `src/db/migrate.ts`.

3. Runtime protection:
   - перед query embedding ассистент проверяет coverage;
   - при нулевом или низком coverage OpenAI embedding не вызывается;
   - пустой vector search не выполняется.

4. Backfill:
   - добавлен `npm run embeddings:backfill`;
   - есть `--dry-run`;
   - есть `--limit`;
   - есть раздельные режимы `--products-only` и `--content-only`.

5. Retrieval safety:
   - vector similarity используется только как retrieval-сигнал;
   - hard filters по типу товара, мощности, топливу, роли товара и другим ограничениям остаются решающими;
   - semantically similar, но неподходящий товар не должен попадать в видимые карточки.

6. Tests:
   - coverage guard;
   - metadata SQL;
   - vector hard-filter safety;
   - общий regression набор.

## Что значит финальный результат

Финальным результатом считается не просто наличие кода, а рабочий production retrieval слой:

1. код закоммичен и запушен в GitHub;
2. Railway применил миграции автоматически;
3. embeddings заполнены в production PostgreSQL для основной части каталога;
4. coverage виден через admin endpoint/report;
5. runtime не тратит OpenAI embedding-вызовы при низком coverage;
6. vector search реально участвует в подборе кандидатов;
7. неподходящие товары не проходят в карточки только из-за semantic similarity;
8. проведена live-проверка через встроенный виджет на `https://bakautprof.ru/`;
9. live-протокол сохранен в `local-live-tests/*.production.md`;
10. evidence показывает PASS по всем критериям.

## Acceptance Criteria

AC1. `npm run typecheck` проходит.

AC2. `npm test` проходит полностью.

AC3. `npm run migrate` проходит локально и migration file готов для Railway.

AC4. Добавлен admin endpoint или script/report, который показывает:

```json
{
  "products": { "total": 3955, "embedded": 0, "usable": 0, "coverage": 0 },
  "catalog_pages": { "total": 102, "embedded": 0, "usable": 0, "coverage": 0 },
  "troubleshooting_cases": { "total": 1, "embedded": 0, "usable": 0, "coverage": 0 }
}
```

AC5. Production backfill выполнен батчами без превышения OpenAI budget.

AC6. Coverage после backfill:
   - `products`: не ниже 80%, целевой уровень 90%+;
   - `catalog_pages`: не ниже 80%, целевой уровень 90%+;
   - `troubleshooting_cases`: заполнять по мере появления кейсов, для малой таблицы допустимо 100% или явное объяснение отсутствия данных.

AC7. Runtime metadata подтверждает, что при достаточном coverage vector candidates появляются в candidate pool.

AC8. Vector candidates не нарушают hard constraints и не становятся видимыми карточками, если не подходят по фактам.

AC9. Production live dialog через `bakautprof.ru` подтверждает:
   - бот лучше находит релевантные товары по естественной формулировке;
   - не обещает наличие/доставку/скидки как финальный факт;
   - карточки соответствуют ответу;
   - нет fallback/recovery текста;
   - нет галлюцинаций по характеристикам.

AC10. В `.agent/tasks/.../evidence.md` или новом task artifact зафиксирован PASS по всем AC.

## План доведения до финала

### Этап 1. Добавить мониторинг coverage

Реализовать один из вариантов:

1. предпочтительно: admin endpoint `GET /api/admin/embedding-coverage`;
2. дополнительно или временно: script `npm run embeddings:coverage`.

Endpoint должен использовать уже добавленный `ProductRepository.getEmbeddingCoverage(...)`.

Результат этапа:

```text
Можно открыть admin endpoint/report и увидеть total, embedded, usable, coverage по каждой таблице.
```

Статус финальности после этапа: не финальный. Это только наблюдаемость.

### Этап 2. Commit + push

После прохождения тестов:

```bash
npm run typecheck
npm test
git status --short
git add ...
git commit -m "Harden embedding retrieval pipeline"
git push
```

Railway сам применит миграции через `preDeployCommand`; ручной Railway deploy не нужен.

Результат этапа:

```text
Production schema готова принимать embedding metadata.
```

Статус финальности после этапа: не финальный. Код в production есть, но vectors еще могут быть пустыми.

### Этап 3. Production backfill

Сначала dry-run на production DB:

```bash
npm run embeddings:backfill -- --dry-run --limit=50
```

Затем реальные батчи:

```bash
npm run embeddings:backfill -- --limit=200
```

Повторять до достижения coverage.

Важные условия:

1. запускать с production `DATABASE_URL`;
2. не запускать без лимита;
3. контролировать OpenAI budget;
4. после каждого батча смотреть coverage;
5. при ошибках не продолжать вслепую.

Результат этапа:

```text
В production PostgreSQL заполнены embeddings для основной части товаров и страниц каталога.
```

Статус финальности после этапа: почти финальный, но без live-проверки еще не финальный.

### Этап 4. Проверить retrieval качество

Проверить несколько классов запросов:

1. бытовой запрос без точного названия товара;
2. точная модель;
3. подбор генератора по нагрузке;
4. подбор виброплиты по задаче/весу;
5. запрос, где похожий товар должен быть отвергнут hard constraints;
6. запрос по странице/инструкции/обслуживанию.

Нужно смотреть:

1. какие кандидаты пришли из text search;
2. какие пришли из vector search;
3. какие были отфильтрованы;
4. какие карточки реально показаны;
5. совпадает ли текст ответа с карточками.

Результат этапа:

```text
Vector search расширяет candidate pool, но не ломает фактическую пригодность карточек.
```

Статус финальности после этапа: не финальный без production widget live-протокола.

### Этап 5. Production live-проверка

Проверка только через встроенный виджет на `https://bakautprof.ru/`.

Минимальный сценарий:

1. покупатель описывает задачу естественным языком, без точного названия товара;
2. бот уточняет или предлагает товары;
3. покупатель меняет/уточняет требование;
4. бот обновляет подбор без смешивания старых и новых требований;
5. покупатель спрашивает про наличие/доставку;
6. бот не обещает финальные условия, предлагает оставить контакт только когда это уместно.

Сохранить протокол:

```text
local-live-tests/YYYY-MM-DD-embedding-retrieval.production.md
```

Результат этапа:

```text
Есть live evidence, что embeddings улучшили retrieval, но бот остался управляемым агентом, а не keyword/rule системой.
```

Статус финальности после этапа: финальный только если все AC PASS.

## Риски и решения

### Риск 1. Стоимость OpenAI embeddings

Решение:

- использовать `--dry-run`;
- запускать батчами `--limit=200`;
- не делать runtime embedding calls при низком coverage;
- контролировать usage ledger.

### Риск 2. Задержка ответа

Решение:

- coverage guard;
- query embedding cache;
- vector search только когда есть usable vectors.

### Риск 3. Устаревшие vectors

Решение:

- `embedding_source_hash`;
- `embedding_updated_at`;
- backfill обновляет stale rows;
- если текст не изменился, metadata можно touch без повторной оплаты embedding.

### Риск 4. Похожие, но неподходящие товары

Решение:

- vector score только добавляет кандидатов;
- hard filters остаются обязательными;
- тест покрывает случай, где vector-похожая виброплита не проходит в запрос генератора.

### Риск 5. Смена embedding model

Решение:

- `embedding_model`;
- `vector(1536)` сейчас соответствует `text-embedding-3-small`;
- при смене модели с другой размерностью нужна отдельная миграция, а не простая замена env.

## Финальная оценка текущего состояния

Сейчас: не финальный результат.

Причина: кодовая часть готова, но фактическая ценность embeddings появится только после backfill production базы, мониторинга coverage и live-проверки через production widget.

Что нужно сделать следующим действием:

1. добавить `GET /api/admin/embedding-coverage` или `npm run embeddings:coverage`;
2. пройти `typecheck` и `test`;
3. commit + push;
4. после Railway deploy выполнить production backfill батчами;
5. провести production live-проверку;
6. только после PASS по live evidence считать результат финальным.
