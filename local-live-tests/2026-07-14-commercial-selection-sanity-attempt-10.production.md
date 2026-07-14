# Production live protocol: commercial selection sanity, attempt 10

- Date: 2026-07-14
- Site: embedded widget on `https://bakautprof.ru/policy/?codex_live_attempt10=599378f`
- Production commit: `599378fe8b1461d83052781da851c1ebb6b5bb06`
- Session: `a5253565-aab7-4bbc-b37b-31669a6db423`
- Admin conversation: `1757`
- Verdict: **FAIL**

## Buyer-visible turn 1

Buyer:

> Нужен генератор для дачи: скважинный насос 1,1 кВт и болгарка 1,5 кВт могут работать одновременно. Дом однофазный 220 В, автозапуск не нужен.

Widget answer:

> Сейчас не смог надежно сформировать ответ. Вопрос сохранен, повторите его через пару минут.

No product cards were visible. The dialogue was stopped immediately because continuing after a public technical fallback would not be a valid adaptive buyer journey.

## Per-turn admin audit

Turn `d57f167c-6567-4cd5-9f7e-468007ba16fd` contradicts the buyer-visible result:

- status: `completed`
- stage: `assistant_message_saved`
- error: none
- recovered: `false`
- calculator and catalog tools: successful
- selection readiness: `ready_for_preliminary_cards`
- pre-send review: `pass`, no issues
- saved answer: a concrete 4.5 kW minimum, four named preliminary products, and a gasoline/fuel-preference question
- saved cards: four products with prices, including SUMEC SU7700 at 42,490 RUB and SUMEC SU7700E at 46,590 RUB

The backend completed in about 42.5 seconds and durably saved the correct response, but the iframe displayed the final public fallback instead.

## Technical cause

The durable response header fixed the missing-turn-ID case, but exposed a second transport race. When the primary SSE transport closes while the original runner still owns the execution lease, client recovery immediately calls the recovery endpoint. `AgentManagerOrchestrator` sees the active lease and returns `turn_execution_in_progress`; the recovery stream then fails even if the original runner saves the answer moments later.

The required general fix is to keep the recovery request attached to the same durable turn: wait while the first runner owns the lease, re-read the saved answer/checkpoint, and only resume execution after the lease is released. It must never start a concurrent second planner.
