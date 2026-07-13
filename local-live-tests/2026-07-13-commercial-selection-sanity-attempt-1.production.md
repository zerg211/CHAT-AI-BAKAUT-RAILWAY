# Production widget audit: commercial selection sanity, attempt 1

Date: 2026-07-13 13:39-13:44 Europe/Moscow
Site: `https://bakautprof.ru/` embedded widget
Railway commit marker: `50ee8a5d8d7b64346933c628844a20842c3ebeb0`
Session: `9ad5a646-0f86-4bf5-8df2-1984dcd84538`
Verdict: **FAIL**

## Turn audit

### Turn 1

Buyer: `Нужен генератор для дачи. Что можете предложить?`

Assistant gave useful preliminary 2.8-5.0 kW orientation, three catalog cards with prices, and asked what would run simultaneously.

- Buyer value: PASS for a broad opening turn.
- Cards: Zongshen PB 3300 E 2.8 kW / 45,990 RUB; Вепрь 5.0 kW / 127,192 RUB; CHAMPION GG2801 2.8 kW / 26,990 RUB.
- Admin: completed; preliminary selection; one catalog search; no structured recovery needed.

### Turn 2

Buyer: `Скважинный насос 1,1 кВт и болгарка 1,5 кВт могут работать одновременно. Дом однофазный 220 В, автозапуск не нужен.`

Assistant calculated 4.5 kW minimum, recommended the 4.7-5.0 kW class, and showed four cards. It gave a concrete first choice: TSS SGG 5000N.

- Buyer value: content and cards were useful.
- Relevant gasoline cards: TSS SGG 5000N 5.0 kW / 49,281 RUB; SUMEC SU8800 6.0 kW / 47,990 RUB.
- Admin: turn status `recovered`, error `agent_manager_generation_failed`; therefore release verdict FAIL even though the visible answer was useful.

### Turn 3

Buyer: `Бензиновый. Покажите 2–3 подходящих однофазных варианта примерно 5–6 кВт с ценами. Шильдика насоса сейчас под рукой нет.`

Assistant said that no gasoline single-phase product could be safely shown, rendered no cards, and asked for the pump nameplate.

- Buyer value: FAIL. This directly contradicted turn 2 and repeated the exact anti-sales behavior under investigation.
- Admin planner: correctly encoded strict `fuel_type=gasoline`, single phase, preliminary fit, and 5-6 kW preference.
- Admin deterministic result: `answer_products_suppressed:unsupported_or_unverifiable_strict_hard_constraint:1` and `catalog_structured_recovery_attempted:1000:0`.
- Historical evidence was reused, but the unsupported strict `fuel_type` blocker suppressed all products.
- Pre-send review incorrectly returned `pass`.

### Turn 4

Buyer objected that TSS and SUMEC had just been shown and requested a comparison without overpaying.

Assistant acknowledged the contradiction and compared the two from dialogue history, but again rendered no cards and incorrectly framed the previous catalog facts as unconfirmed in the current turn.

- Buyer value: partial recovery only; release remains FAIL.
- Admin: strict gasoline requirement again suppressed all answer products; historical selection evidence was present; turn status `recovered`.

## Root cause and ownership

- LLM responsibility: correctly understood the buyer's gasoline preference and represented it structurally.
- Deterministic-code responsibility: validate catalog fuel facts and filter gasoline versus diesel.
- Defect: strict requirement assessment supported phase, power, autostart, budget and several other kinds, but not `fuel_type`; fail-closed behavior therefore erased valid products.
- Fix direction: add a general typed fuel requirement validator and deterministic product filter. Do not add model names, buyer phrases, regex routing or canned answers.

## Release decision

Attempt 1 is rejected. A new commit and full clean embedded-widget dialogue are mandatory.
