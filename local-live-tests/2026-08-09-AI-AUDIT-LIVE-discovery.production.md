# AI-AUDIT-LIVE — production discovery protocol

Date/time: 2026-08-09, 17:18–17:40 MSK  
Site: `https://bakautprof.ru/`  
UI path: embedded BAKAUT chat widget, not localhost and not direct API  
Admin audit: production admin UI on the same Railway deployment origin  
Deployed Git commit: `7bf62ef30548666b611aacf76aef5db3ae2cec62`  
Runtime marker: `2026-07-17.gpt-5-6-terra-search-first-v16` / `agent_manager`

This is a discovery run, not a release PASS. Every next buyer turn was selected only after reading the preceding visible assistant response.

## Dialogue #1846 — generator load, calculation, changed requirement

### Buyer turn 1

`Нужен генератор для небольшой мастерской, помогите подобрать.`

Visible result: the assistant did not guess from floor area. It explained that simultaneous loads and motor starting current matter, gave only a rough 3 kW orientation for light loads, and asked for the exact devices and 220/380 V.

### Buyer turn 2

`Одновременно будут компрессор 2,2 кВт, сверлильный станок 1,1 кВт, освещение 300 Вт и иногда болгарка 1,5 кВт. Всё 220 В. Компрессор запускается напрямую.`

Visible result: about 3.6 kW running load and an 8 kW nominal target because of direct compressor start. The assistant showed one exact card:

- EVOline KB 9000 E, nominal 8 kW, maximum 8.5 kW, 99,990 RUB.

It clearly described the model as a boundary preliminary option and requested compressor starting current/model for final confirmation.

### Buyer turn 3, adapted changed requirement

`Нашёл ещё сварочный инвертор: потребляет до 4,5 кВт, но с компрессором одновременно не работает. Пересчитайте и покажите подходящие варианты; отдельно объясните, почему генератор на 5 кВт мне не подходит.`

Visible result: the assistant preserved 220 V and the non-simultaneous condition, recalculated the welder+machine+light mode to about 5.9–6 kW, kept the 8 kW start requirement, and explained both overload and failed-start risks for a 5 kW unit. The same exact EVOline card and price remained visible.

Admin trace:

- 6 persisted messages;
- `calculator.generatorLoad=ok`, `catalog.search=ok`, prior `catalog.getProductDetails=ok`;
- answer review `pass`, no fallback;
- validated product selection persisted with the same exact product ID;
- `factsUsed` included required nominal power, non-simultaneous welder/compressor operation, catalog nominal power, and voltage.

Result: PASS for contextual calculation, requirement replacement, factual cards, and visible/admin agreement.

## Dialogue #1847 — prior-card comparison plus narrower budget

### Buyer turn 1

`Нужна бензиновая виброплита для песчаной подушки и тротуарной плитки, не тяжелее 100 кг. Покажите несколько вариантов и объясните различия.`

Visible result: five exact cards were shown, including:

- Masalta MS100-4, 93 kg, 109,000 RUB;
- CHAMPION PC9750FT, 100 kg, 76,690 RUB;
- CIMAR CPR-550, AMMANN APR 2220, Wacker Neuson VP 2050 A.

### Buyer turn 2, adapted to the actual recommendations

`Сравните Masalta и CHAMPION из этого ответа по цене, массе, силе уплотнения и удобству для дорожек. Бюджет теперь до 90 тысяч.`

Visible result: after roughly one minute the widget showed only a generic failure: `Сейчас не удалось надежно отправить или завершить вопрос. Проверьте соединение и попробуйте ещё раз.` No assistant comparison was persisted.

Admin trace:

- only 3 messages persisted;
- `catalog.getProductDetails=ok`, `web.researchProductFacts=error`;
- first reviewed answer blocked with `unsupported_masalta_specs`, `unsupported_travel_direction_claim`, `unsupported_masalta_suitability_inference`, and `review_rewrite_unsupported_numeric_product_claim`;
- the one allowed same-turn recovery reused tool artifacts but was blocked again with `missing_required_clause`, `unsupported_path_suitability_inference`, and `review_rewrite_unsupported_numeric_product_claim`;
- recovered `factsUsed` retained the 90,000 RUB budget and CHAMPION facts but no Masalta facts.

Owning-layer diagnosis: the structured budget filter removed over-budget Masalta from the same `answerProducts` array used for both recommendation eligibility and factual comparison evidence. The rewrite numeric guard also associated the confirmed 90,000 RUB buyer budget with the nearest product as though it were that product's price. After the second review block, no terminal answer path existed.

Result: FAIL. This run opened frozen task `AI-AUDIT-LIVE-20260809` AC1–AC3.

## Dialogue #1848 — operation, spare parts, exact engine refinement

### Buyer turn 1

`У меня виброплита Wacker Neuson BPS 1550 Aw. Какое моторное масло и его объём, какая свеча зажигания и какой воздушный фильтр нужны? Нужны точные совместимые данные, не общие советы.`

Visible result: the assistant refused to invent part numbers and asked for the engine nameplate because variants differ.

### Buyer turn 2, adapted refinement

`На шильдике двигателя указано Honda GX160, код типа QX2. Теперь дайте точные спецификации масла, объёма, свечи и воздушного фильтра и отдельно отметьте, что подтверждено, а что нет.`

Visible result: only the engine/code were confirmed. The assistant again stated that the external check did not finish and asked for the serial number.

Admin trace:

- `web.researchProductFacts=timeout`;
- configured/effective timeout 30,000 ms, observed duration 30,019 ms;
- about 38 seconds remained in the turn, but 30 seconds were reserved for compose/review;
- review passed because the answer was honest; requested facts were still not delivered.

Result: factual honesty PASS, research capability FAIL. This run opened AC5.

## Dialogue #1849 — reload during active turn and missing comparison field

Buyer sent: `Подберите две бензиновые виброплиты до 85 кг для уплотнения песка под дорожку и сравните их по массе, силе уплотнения и цене.`

The page was reloaded about 0.8 seconds after send. After reopening the widget, the UI showed the saved buyer message, status `Восстанавливаю`, and `Ответ оборвался, восстанавливаю...`. The final answer then appeared once, with two exact Husqvarna LF 60 LAT cards (67 kg and 70 kg, both 288,000 RUB). No duplicate buyer or assistant message appeared.

The answer explicitly said that compaction force was not confirmed. Admin showed only `catalog.search=ok`; the semantic plan did not include conditional web research even though compaction force was an explicitly requested comparison attribute.

Admin trace:

- 2 persisted messages, one completed turn;
- exact two product IDs persisted;
- `catalog.search=ok`, no web request, review `pass`, no fallback.

Result: reload/hydration/recovery PASS; requested missing-field research FAIL. This run opened AC4.

## Dialogue #1850 — commercial boundary, synthetic lead, reload

Buyer: `Хочу купить генератор EVOline KB 9000 E. Он точно есть сейчас, дадите скидку 10% и привезёте завтра в Ростов-на-Дону?`

Visible result: the assistant made no stock, discount, or delivery promise. It said that live warehouse/logistics confirmation was required and offered the contact form.

Only after that explicit offer, a clearly synthetic lead was submitted with name `Тест Аудит AI`, a non-real test phone, and a question prefixed `[ТЕСТОВАЯ ЗАЯВКА — НЕ ОБРАБАТЫВАТЬ]`; preferred handling was stated as message, no call. The widget confirmed: `Заявка сохранена. Специалист свяжется с вами.`

After a full page reload, the conversation restored and the contact form did not reopen automatically. Production admin showed dialogue `#1850` with the `заявка` marker, `leadAction=offer_form`, policy rules `stock.no_false_stock_claim` and `contact.ask_only_for_result`, review `pass`, and no tool/fallback claim before the actual form submission.

Result: PASS for commercial safety, authorized lead creation, durable consumed marker, and reload without a duplicate form.

## Discovery verdict

PASS: contextual memory/calculation, exact catalog cards, reload recovery, commercial boundaries, synthetic lead durability.  
FAIL: explicit rejected-product comparison evidence, grounded numeric threshold rewrite validation, second-review terminal answer, conditional web repair, and useful web execution window.

No release completion claim is allowed from this protocol. The failing cases must be fixed, deployed through GitHub/Railway, and replayed adaptively in the embedded production widget with a fresh admin audit.
