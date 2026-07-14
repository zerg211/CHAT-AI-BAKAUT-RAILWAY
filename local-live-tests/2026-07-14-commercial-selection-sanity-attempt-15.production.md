# Production live dialogue attempt 15 — FAIL

- Date: 2026-07-14 (Europe/Moscow)
- Production commit marker: `ecc18064948547f7f50855bc5af319d8bac0c789`
- Site: `https://bakautprof.ru/`
- Test path: embedded production widget opened through the site UI
- Session: `9df29bae-34a3-489a-8b4a-46fc947542e4`
- Admin conversation: `1762`
- Buyer-view verdict: **FAIL**
- Admin/technical verdict: **FAIL**

## Turn 1

Buyer:

> Нужен генератор для дачи: скважинный насос 1,1 кВт и болгарка 1,5 кВт могут работать одновременно. Дом однофазный 220 В, автозапуск не нужен.

What the buyer saw:

- a preliminary recommendation from 5 kW, explicitly tied to the pump-start assumption;
- four gasoline, single-phase, priced cards: TSS SGG 5000N / 49,281 RUB; FIRMAN RD7910 / 57,200 RUB; BISON BS6250IE / 61,100 RUB; EVOline PB 6000 / 64,990 RUB;
- a request for the pump nameplate only for final confirmation, not as a condition for showing preliminary options.

Buyer-view audit: **PASS**.

Admin audit:

- turn `6a54920e-afd3-4c37-bf30-09e5001dfd2b`;
- `completed`, `assistant_message_saved`, `recovered=false`;
- `calculator.generatorLoad:ok`, `catalog.search:ok`;
- four selected product IDs and four matching cards;
- readiness `ready_for_cards` with decision `ready_for_preliminary_cards`;
- pre-send review `pass`.

## Turn 2

Adaptive buyer reply based on the visible cards:

> Сравните тогда только ТСС SGG 5000N за 49 281 ₽ и инверторный BISON BS6250IE за 61 100 ₽: что я реально получаю за доплату и что лучше взять для дачи без переплаты?

What the buyer saw:

> Не буду сейчас уверенно утверждать точный факт по ТСС SGG 5000N: внешняя проверка не завершилась. Могу опираться только на уже подтвержденные данные, а спорный параметр нужно добрать по источникам.

Buyer-view audit: **FAIL**. The response did not compare the two products, did not use their known prices or catalog properties, did not recommend either option, and displayed no cards.

Admin audit:

- turn `460085ca-8697-4dea-9921-acb5bbe3f7c2`;
- `recovered`, `assistant_message_saved`, `errorCode=agent_manager_recovery_failed`;
- `catalog.getProductDetails:ok` returned both exact products;
- the catalog payload contained the facts needed for a useful preliminary comparison, including price, 5 kW nominal / 5.5 kW maximum power, voltage, single phase, conventional vs inverter category, tank and other available specs;
- the orchestrator nevertheless injected `auto:exact-model:5000n-bs6250ie` / `web.researchProductFacts`, which failed with `catalog_product_fact_extraction did not return a JSON object`;
- strict `comparison_scope` was treated as an unsupported product attribute, causing `answer_products_suppressed:unsupported_or_unverifiable_strict_hard_constraint:1`;
- selection readiness became blocked, selected IDs and cards became empty;
- pre-send review rewrote the answer to the generic external-verification refusal instead of preserving successful catalog evidence.

## Root cause and design boundary

1. Semantic ownership was correct at the planner level: it understood that the buyer wanted only two named products, a price/value comparison, and a no-overpayment recommendation.
2. Deterministic code incorrectly overrode that understanding twice: it did not recognize exact catalog details as same-turn exact-model evidence, and it interpreted a comparison-scope control as an unverifiable product characteristic.
3. A failed optional/redundant web check was allowed to erase a successful authoritative catalog result.
4. Correct general behavior is to compare every fact already confirmed by successful tools, explicitly isolate only the still-unverified attribute, and still make a preliminary recommendation when the available facts support one.

This attempt is not release proof. It remains a recorded production regression that the next deployment must re-test through a fresh embedded-widget dialogue and per-turn admin audit.
