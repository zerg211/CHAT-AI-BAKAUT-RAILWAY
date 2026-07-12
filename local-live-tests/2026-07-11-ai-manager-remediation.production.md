# Production live audit — AI manager remediation

Date: 2026-07-11 (Europe/Moscow)

Environment: embedded production widget opened on `https://bakautprof.ru/` and `https://bakautprof.ru/policy/`.

Deployed runtime under test:

- Git commit: `3a06ce408347c3f8906e7e18edca068f9ea107cc`
- Runtime: `2026-07-10.manager-runtime-v1`
- Contract: `2026-07-10.manager-contract-v1`
- Production runtime owner: `agent_manager`
- Answer/planner/reviewer models: `gpt-5.4`

## Adaptive dialogue A — generator sizing

Production session: `678e31eb-6899-4092-83b0-8350fd6a47b7`

### Turn 1

Buyer:

> Нужен генератор для загородного дома: холодильник, насос, котёл и иногда электроинструмент. Какой подойдёт?

Assistant shown in the widget:

> Для такого набора обычно смотрят генератор примерно от 5–7 кВт как ориентир, но у вас есть насос и электроинструмент — именно они сильнее всего влияют на выбор из-за пусковых токов. Поэтому 3–4 кВт тут уже рискованно, а точнее без данных по насосу и инструменту не подтвержу.
>
> Если дом обычный 220 В и без мощных станков, чаще всего нужен однофазный генератор с запасом по пуску.
>
> Главный вопрос: какой у вас насос и какой самый мощный инструмент планируете включать — хотя бы мощность с шильдика или модель?

Buyer-view audit:

- PASS: useful preliminary range, explicitly marked as preliminary.
- PASS: asks one decisive clarification rather than a long form.
- PASS: no unsupported exact product, price, availability, delivery, or discount claim.
- PASS: no random product cards while the decisive load data is missing.

Internal audit:

- Turn: `cf8332e4-d17c-4f71-9e95-85aebcdbabeb`
- Planner/answer/reviewer: `gpt-5.4`.
- Catalog grounding: `ok`.
- Review: `pass`, no issues.
- Cards suppressed by `selection_readiness_contract`.

### Turn 2

The next buyer message directly answered the actual clarification shown by the assistant.

Buyer:

> Насос скважинный 1,1 кВт, болгарка 1,5 кВт, дом однофазный 220 В. Они могут работать одновременно. Автозапуск не нужен.

Assistant shown in the widget:

> Не буду рекомендовать конкретную модель наугад: одно из ваших строгих требований сейчас нельзя надёжно проверить по доступным характеристикам товаров. Нужны подтверждённые данные по этому параметру; после этого я продолжу подбор и покажу только подходящие карточки.

Buyer-view audit:

- FAIL: the answer does not name the allegedly unverifiable requirement.
- FAIL: it discards a completed load calculation and gives the buyer no useful next step.
- FAIL: it behaves like a defensive rules engine rather than a competent manager.

Internal audit:

- Turn: `188153c4-59de-4088-833b-4077c08f83de`.
- `calculator.generatorLoad`: `ok`, `requiredNominalKw = 5.5`.
- `catalog.search`: `ok`.
- Deterministic load filter removed two weak products and retained single-phase 9 kW and 15 kW generators without autostart.
- Pre-send review incorrectly raised `unverifiable_strict_hard_constraint` for `r5:simultaneous_operation_pump_and_angle_grinder:unsupported_strict_requirement_kind`.
- Answer products and visible cards were then suppressed.
- Root cause: a scenario input already consumed by a typed calculator was checked a second time as if it had to be a product-card attribute.

## Current verdict

`FAIL_REQUIRES_SECOND_FIX`

This protocol is intentionally not marked PASS. The original failure was remediated under `.agent/tasks/2026-07-11-live-derived-constraint-fix/spec.md`, but the first post-deploy replay exposed a separate clarification-path regression documented below.

## Post-deploy replay attempt 1 — clarification path regression

Date: 2026-07-12 (Europe/Moscow)

Deployed commit and marker: `bebf07fd6e23f868fcb8b0ee8dc31845c626c00a`.

Production session: `b7d72da7-2b6e-4a3f-aa53-cd3f9d03b706`

Turn: `e103014e-8920-4d07-bf24-062179fba510`

Buyer:

> Нужен генератор для загородного дома: холодильник, насос, котёл и иногда электроинструмент. Какой подойдёт?

Assistant shown in the embedded widget:

> Не буду рекомендовать конкретную модель наугад: сейчас не удалось надёжно завершить и применить расчёт для требования ««Нужен генератор»»; «Нужно питать «холодильник, насос, котёл и иногда электроинструмент», но без типа/мощности насоса и инструмента точный расчёт пока невалиден.». Я не стану подменять расчёт предположением; повторите сообщение или уточните исходные данные, и я продолжу подбор.

Buyer-view audit:

- FAIL: the assistant should have given the planner's useful preliminary orientation and asked the decisive pump question.
- FAIL: the response describes a calculation failure even though calculation was intentionally deferred until the buyer supplied the missing pump fact.
- FAIL: already quoted evidence was wrapped again, producing `««... »»`.
- PASS: no premature products or cards were shown.

Internal audit:

- The planner explicitly chose the correct next step: explain an approximate 5–7 kW orientation and ask for pump type/power and 220/380 V.
- `selectionReadiness.status=needs_more_info`, `canShowProductCards=false`, `selectedProductIds=[]` and the answer contract contained the decisive pump question.
- Product evidence and cards were correctly suppressed.
- Mechanical review nevertheless emitted `unverifiable_strict_hard_constraint` because `generator_load_scenario` referenced the intentionally future request `calc_pending_after_clarification`.
- `product_type=generator` was also treated as unsupported despite matching `canonicalProductClass=generator`.
- Root cause: the strict requirement guard correctly protects recommendations, but it was applied to a non-recommendation clarification answer as though the answer were attempting product selection.

Remediation task: `.agent/tasks/2026-07-12-unresolved-constraint-clarification/spec.md`.
