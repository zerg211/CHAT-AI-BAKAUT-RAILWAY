# Production dialogue #2194 — failed checkpoint

- Date: 2026-09-15 (Europe/Moscow)
- Surface: embedded widget on `https://bakautprof.ru/`
- Backend marker: `5c616d44172e4a5472fdc93b74dcc4d7fed00a3c`
- Session: `a94e8dc7-cc7f-4065-9c2e-679906e501ec`
- Result: FAIL; this dialogue is evidence for the corrective patch and is not final acceptance.

## Buyer-visible dialogue

Buyer:

> Нужен бензиновый генератор для мастерской: одновременно холодильник 300 Вт, циркуляционный насос 1,1 кВт и инструмент около 1,5 кВт. Всё однофазное 220 В, инструмент включаю после запуска насоса. Подберите 2–3 варианта из каталога, но пусковой ток насоса мне неизвестен.

Assistant:

> Рабочая нагрузка у вас — 2,9 кВт: холодильник 0,3 кВт, насос 1,1 кВт и инструмент 1,5 кВт работают одновременно. Поэтому 3 кВт — только ориентир по уже работающей нагрузке, а не гарантированно достаточная мощность для запуска.
>
> Конкретные 2–3 модели сейчас не подтверждены, поэтому не буду выдавать случайные генераторы за подходящие. Для бензинового однофазного варианта нужно проверить не только номинал, но и способность пережить пуск холодильника, насоса и инструмента; особенно важен пуск насоса.
>
> Следующий вопрос: какое точное значение тока или пусковой мощности насоса указано на его шильдике?

Buyer:

> Шильдик насоса сейчас недоступен. Инструмент — угловая шлифмашина 1,5 кВт, холодильник обычный компрессорный. Без окончательной гарантии всё равно покажите предварительно 2–3 модели из вашего каталога и объясните запас по мощности.

The widget showed `Не удалось завершить ответ. Текст вашего вопроса остался в чате.` The saved question was retried in the same session and produced the same buyer-visible error.

## Internal audit

- Turn 1 `681a0b76-f09f-4693-a7d8-4b5bc7bb380c`: completed. The 2.9 kW total and 3 kW running-only floor were correct. `catalog.search` timed out after 10 seconds, so no requested model reached the buyer.
- Turn 2 `936fae1b-1237-4dbb-ba36-b3c2e73143f1`: failed with `research_guidance_uncertainty_mismatch`. Catalog read timed out; web received only 6.342 seconds and was skipped by its answer reserve. Reviewer also lost prior fuel/phase facts because it received only the current user message.
- Turn 3 `9b15ec93-ffc7-42c4-bc2c-e12373be8139`: failed with one semantic and six evidence-binding issues. The fallback carried unfiltered 2.8 kW and three-phase reference cards; reviewer treated them as recommendation candidates. Calculator scalar evidence had no product scope for named loads.
- No lead action occurred. No contact data was supplied. Only the first assistant answer was committed.

## Corrective contract

The agreed root/critic correction optimizes catalog lexical fallback, uses a 15-second catalog ceiling, applies the primary selection contract inside web recovery, strips nested web product objects from model context, passes the ledger and exhaustive product roles to the reviewer, and resolves named calculator consumers from canonical load items. Local proof must pass before publication; final acceptance requires a new clean adaptive production dialogue.
