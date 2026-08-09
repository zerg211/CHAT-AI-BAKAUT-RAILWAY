# H4 — точная идентификация товарной страницы

Дата: 2026-08-09

## Граница изменения

- owning layer: `src/catalog/productPageIdentity.ts`;
- оба потребителя проверены через экспортируемые `extractProduct` из crawler и sitemap sync;
- production consumer-логика в `crawler.ts` и `sitemapSync.ts` не дублировалась и продолжает использовать общий gate.

## RED

Команда:

`npm.cmd test -- --run tests/catalogProductPageIdentity.test.ts`

Результат до исправления: exit 1, 2 failed / 4 passed.

Воспроизведены два независимых ложноположительных случая:

1. category/listing без product ID/SKU, но с общими `card__main-slider`, `props-list`, `card__current-price`;
2. category/listing с ошибочным `og:type=product`, но без идентичности товара, привязанной к текущей странице.

В обоих случаях старый gate возвращал `true`; crawler и sitemap могли извлечь category `h1` как товар.

## Исправление

- `og:type=product` больше не является самостоятельным доказательством товарной страницы;
- URL-bound Product JSON-LD остаётся точным доказательством;
- fallback для Bakaut detail layout требует один непротиворечивый page-level product ID или SKU;
- несколько разных ID или SKU дают fail-closed;
- ID/SKU внутри Product microdata с `itemprop=url` принимается только при совпадении URL с текущей страницей;
- identity и detail marker должны принадлежать одному Product scope либо быть единственными page-level элементами вне child Product scopes;
- `product-caption__item` учитывается как SKU только при явном префиксе `Артикул`/`SKU`.

## GREEN

Команда:

`npm.cmd test -- --run tests/catalogProductPageIdentity.test.ts tests/catalogCrawlerNoRegex.test.ts tests/sitemapSyncNoRegex.test.ts`

Результат: exit 0, 3 files / 16 tests passed.

Команда:

`npm.cmd run typecheck`

Результат: exit 0.

Команда:

`npm.cmd run lint:no-regex`

Результат: exit 0, новых regex-конструкций нет (legacy baseline: 508).

Команда:

`git diff --check -- src/catalog/productPageIdentity.ts src/catalog/crawler.ts src/catalog/sitemapSync.ts tests/catalogProductPageIdentity.test.ts tests/catalogCrawlerNoRegex.test.ts tests/sitemapSyncNoRegex.test.ts`

Результат: exit 0; только предупреждения Git о будущей нормализации LF/CRLF.

## Оставшийся риск

- Неизвестная будущая товарная разметка без URL-bound Product JSON-LD и без явного ID/SKU теперь будет намеренно пропущена, а не импортирована как сомнительный товар. Это fail-closed компромисс; новую подтверждённую разметку нужно добавлять как отдельный точный identity source.
- Полный suite и live catalog sync входят в общий release gate родительской задачи; в этом изолированном исправлении не выполнялись.

## Root follow-up: sparse one-result listing

Fresh review found one remaining ambiguity: a category with exactly one child card could reuse the complete detail CSS and present one ID/SKU. A new consumer-level RED fixture reproduced `pageEvidence=true`. The fallback now rejects identities inside known listing containers or a child card linking away from the current page. Outside a URL-bound Product scope, the Bakaut fallback requires both one page-level data ID and one SKU; a URL-bound Product scope may use either. Direct crawler/sitemap fixtures now carry their actual page-bound `itemid` instead of relying on unbound Product markup.

GREEN: `npm.cmd test -- --run tests/catalogProductPageIdentity.test.ts tests/catalogCrawlerNoRegex.test.ts tests/sitemapSyncNoRegex.test.ts` — 3 files, 17 tests, PASS.
