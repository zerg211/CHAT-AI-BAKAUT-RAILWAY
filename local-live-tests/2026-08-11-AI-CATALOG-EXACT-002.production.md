# BPS 1550 Aw — post-fix production live verification

## Environment

- Проверка выполнена 11 августа 2026 через встроенный виджет на `https://bakautprof.ru/`, не через localhost и не через прямой API.
- Production marker перед проверкой: commit `91857bc4bce18966e942f9e27f96d512142bc55b`, runtime `agent_manager`, Railway deployment `e31e33c2-5912-4550-b24d-b1b527196161`.
- Публичная карточка: `https://bakautprof.ru/catalog/vibroplity/vibroplita_pryamokhodnaya_benzinovaya_wacker_neuson_bps_1550_aw_89_kg/`.

## Adaptive dialogue

В существующем виджете сначала был зафиксирован исторический ответ до нового deployment: «в каталоге BPS 1550 Aw не нашлась». Следующий ход покупателя вытекал из этой ошибки:

> Проверьте ещё раз именно эту карточку: «Виброплита прямоходная бензиновая Wacker Neuson BPS 1550 Aw (89 кг)», артикул 5100061216. Карточка точно открывается в каталоге. Используйте её для ответа и отдельно проверьте данные Honda GX160 QX2.

После marker `91857bc` виджет ответил:

> Проверил именно эту карточку: Wacker Neuson BPS 1550 Aw, артикул 5100061216. В ней указан двигатель Honda GX160, рабочая масса 89,1 кг и мощность 3,6 кВт.

Покупатель продолжил по незавершённому ответу:

> Проверьте это до конца по официальному руководству Honda GX160 QX2 и каталогу запчастей: масло и объём, свеча, артикулы воздушных фильтров. Не ограничивайтесь сообщением о сбое — сначала попробуйте найти подтверждённые данные и вернитесь с результатом.

Фактический ответ:

> Проверил карточку: это именно Wacker Neuson BPS 1550 Aw, артикул 5100061216, с двигателем Honda GX160. Но тип и объём масла, свечу и артикулы воздушных фильтров карточка не содержит. Внешняя проверка официального руководства Honda GX160 QX2 и каталога запчастей в этом обращении не завершилась, поэтому подтверждённые цифры и артикулы сейчас не назову — подбирать их по аналогии для обслуживания двигателя нельзя.

## Verdict

- **False catalog absence: PASS.** После production deployment ассистент больше не сказал, что BPS 1550 Aw отсутствует; он назвал точную карточку, артикул, двигатель, массу и мощность.
- **Root cause verified.** Страница имела один основной `Product` scope, но связанные товары с другими `data-id` находились внутри него. `hasPageSpecificProductEvidence()` считал все ID и отбрасывал реальную страницу. Исправление учитывает независимую связку slug/H1 модели и не принимает listing без такой связки.
- **Official technical search: NOT MET.** Ассистент не выдумал данные, но web-проверка Honda снова не завершилась. Это отдельный оставшийся gap поиска/тайм-бюджета, не причина ложного отсутствия карточки.
- **Visible card block: NOT PROVEN in this run.** Ответ содержит данные карточки и кнопку «Карточки», но отдельный визуальный блок карточки не был раскрыт в DOM-снимке.

## Local regression evidence

- `tests/catalogProductPageIdentity.test.ts`: 8/8.
- `tests/sitemapSyncNoRegex.test.ts`: 10/10.
- Read-only extractor against the real public page: `pageEvidence=true`, `product=true`, `name=Виброплита прямоходная бензиновая Wacker Neuson BPS 1550 Aw (89 кг) 5100061216`, `price=260000`.
- Typecheck, no-regex lint, and `git diff --check` passed before commit.

## Remaining work

1. Fix/verify bounded official-source fallback for Honda GX160 QX2 so a timeout preserves useful catalog facts and either returns confirmed sources or a complete technical handoff.
2. Run a separate clean embedded-widget session and verify that the `Карточки` control actually renders the product card, not only the textual catalog evidence.
