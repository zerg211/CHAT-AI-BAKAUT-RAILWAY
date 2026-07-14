# Production live protocol: commercial selection sanity, attempt 11

- Date: 2026-07-14
- Site: embedded widget on `https://bakautprof.ru/policy/?codex_live_attempt11=0a976a2`
- Production commit: `0a976a23bef3fd938bd31c14f3c01c094e79a4ae`
- Session: `1d5116e2-81d7-4a93-b216-f1be2ac60709`
- Admin conversation: `1758`
- Verdict: **FAIL**

## Buyer-visible turn 1

Buyer:

> Нужен генератор для дачи: скважинный насос 1,1 кВт и болгарка 1,5 кВт могут работать одновременно. Дом однофазный 220 В, автозапуск не нужен.

The widget delivered the real assistant answer without a technical transport fallback. The assistant correctly calculated a 4.5 kW nominal minimum and described 5.0 kW as the practical starting class, but then said:

> Сейчас точные карточки не покажу: в этой попытке не нашлось ни одной модели, которую мы можем честно подтвердить под ваши жесткие условия по мощности и фазе.

No product cards were visible. The dialogue was stopped because this repeats the commercially harmful refusal that the task must eliminate.

## Per-turn admin audit

Turn `6c2e8ded-f483-4f83-b9a0-11a9e69b18b5`:

- status: `completed`
- stage: `assistant_message_saved`
- recovered: `false`
- calculator: `ok`, required nominal power 4.5 kW
- catalog search: `ok`, but final products: 0
- structured recovery scanned 1,000 products and retained 0
- suppression warning: `unsupported_or_unverifiable_strict_hard_constraint:1`
- selection readiness: `needs_more_info`, no cards
- pre-send review: `pass`, no issues

The LLM correctly represented the buyer's voltage as strict `kind: voltage_v`, `value: 220`, bound to typed `phase: single_phase`, but emitted `unit: null`. Deterministic validation required a second literal unit string such as `V` and therefore invalidated the whole catalog, although the stable kind `voltage_v` already defines the unit.

## Required general fix

Accept `unit: null` only for the stable `voltage_v` requirement kind when the numeric value is one of the supported generator voltages and agrees with typed phase policy. Continue rejecting a foreign explicit unit, unsupported voltage, phase mismatch, unknown product phase, or wrong product class.
