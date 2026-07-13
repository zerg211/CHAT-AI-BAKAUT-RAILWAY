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

## Post-deploy replay attempt 2 — useful clarification preserved, recovery defect exposed

Date: 2026-07-12 (Europe/Moscow)

Deployed commit and exact health marker: `7ba775f6d5966074cebfef7c10aae3359d858cf9`.

Embedded-widget session: `f69a04c0-e6e6-4ccd-9781-5135be9cca98` on `https://bakautprof.ru/`.

### Turn 1 — broad request

Buyer:

> Нужен генератор для загородного дома: холодильник, насос, котёл и иногда электроинструмент. Какой подойдёт?

Assistant shown in the embedded widget:

> Для такого набора обычно смотрят однофазный генератор 220 В с запасом по пуску, ориентиром примерно от 3–5 кВт. Но тут самое важное — какой именно насос: поверхностный или скважинный, и какая у него мощность на шильдике. Именно насос чаще всего решает, хватит генератора или нет.
>
> Если скажешь мощность насоса, я уже нормально сориентирую по нужной мощности генератора без лишних гаданий.

Audit:

- PASS: useful preliminary orientation survived the strict-constraint guard.
- PASS: one decisive question, no random product cards.
- PASS: the next buyer turn can naturally answer the question.

### Turn 2 — explicit load, phase, simultaneity, and no autostart need

Buyer:

> Насос скважинный 1,1 кВт, болгарка 1,5 кВт, дом однофазный 220 В. Они могут работать одновременно. Автозапуск не нужен.

Assistant shown in the embedded widget:

> По вашему набору ориентир такой: нужен однофазный генератор 220 В с расчетной номинальной мощностью примерно от 5,5 кВт. Это предварительный расчет по вашим данным и допущениям по холодильнику и котлу, не финальный размер под покупку.
>
> Если без болгарки, только дом + насос, ориентир получается около 4 кВт. Но раз насос и болгарка у вас могут работать одновременно, смотреть лучше класс 5,5–6,5 кВт, чтобы не брать впритык.
>
> Сейчас точные модели не покажу: в этом подборе не хватило подходящих карточек из нашего каталога после фильтра по расчетной мощности. Для точного добора остался один важный момент — шильдик насоса: модель или его пусковой ток/пусковая мощность. У скважинных насосов это сильно влияет на финальный выбор.

Internal audit:

- Turn: `88422583-6476-4ce7-9e9d-0e946c289a34`.
- `calculator.generatorLoad`: `ok`; `requiredNominalKw=5.5`, `requiredStartingKw=5.2`, base scenario `4.0`; bounded-assumption confidence `0.82`.
- Catalog returned three rows, but strict selection exposed no cards because their phase fields contradicted their descriptions/voltage facts.
- The planner emitted two requirements bound to the same calculator profile. The scenario id was covered by the calculator, while the derived `nominal_power_min_kw` id was incorrectly placed in catalog search coverage. This one-sided proof graph suppressed otherwise useful answer evidence.

Buyer-view verdict:

- PASS: calculation and explanation are useful and materially better than the previous generic refusal.
- PASS: no unsafe phase-conflicting card was shown.
- PARTIAL: asking for the pump plate is technically justified, but the explicit preliminary range was already sufficient to continue a bounded preliminary selection request.

### Turn 3 — natural request for preliminary cards

Buyer:

> Шильдик сейчас посмотреть не могу. Покажите хотя бы предварительно 2–3 подходящих однофазных варианта 5,5–6,5 кВт без автозапуска.

Assistant shown in the embedded widget after the failed turn:

> Сейчас не смог надежно сформировать ответ. Вопрос сохранен, повторите его через пару минут.

Internal audit:

- Turn: `e773cb28-5f6a-49f7-b75c-51a37186a4f6`.
- Final status/stage: `failed` / `recovery_failed`.
- Error code: `agent_manager_recovery_failed`.
- The review correctly refused unvalidated cards, but the strict kind `autostart_required` was not mechanically supported.
- Initial execution, server recovery, and client recovery all reused the same succeeded `answer_contract_created` checkpoint. No fresh answer was composed after review blocked the draft.
- The same blocked draft was reviewed three times and the widget finally received the generic technical fallback.
- Raw catalog rows were not safe recommendations: their specs/descriptions contained phase conflicts, and explicit installed/no-autostart facts were incomplete.

Verdict for deployed commit `7ba775f...`: `FAIL_REQUIRES_THIRD_FIX`.

Remediation task: `.agent/tasks/2026-07-12-recovery-and-validated-selection/spec.md`.
