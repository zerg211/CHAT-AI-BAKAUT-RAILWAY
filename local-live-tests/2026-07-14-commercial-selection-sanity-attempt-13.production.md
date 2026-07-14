# Production live protocol: commercial selection sanity, attempt 13

- Date: 2026-07-14
- Site: embedded widget on `https://bakautprof.ru/policy/?codex_live_attempt13=7785f05`
- Production commit: `7785f051f99c384410024f643047fda29b210295`
- Session: `3b3a0351-36c9-4690-ad34-3f9c1dce1794`
- Admin conversation: `1760`
- Verdict: **FAIL**

Attempt 12 on the same production commit was not judged because the test controller accidentally removed the widget container while closing an unrelated callback popup. Admin conversation `1759` contained a good four-card answer, but it was not available for a buyer-view audit. Attempt 13 used a new session and did not manipulate the callback popup.

## Buyer-visible turn 1

Buyer:

> Нужен генератор для дачи: скважинный насос 1,1 кВт и болгарка 1,5 кВт могут работать одновременно. Дом однофазный 220 В, автозапуск не нужен.

Widget answer:

> Сейчас не смог надежно сформировать ответ. Вопрос сохранен, повторите его через пару минут.

No cards were visible, so the dialogue was stopped.

## Per-turn admin audit

Turn `f913f4df-3535-41fc-bd1c-da205554ad10`:

- final status: `recovered`
- stage: `assistant_message_saved`
- error: none
- final answer contract: saved
- recovery trace: `assistant_message_saved_from_answer_contract`, `recovered=true`
- saved answer: a preliminary 5 kW recommendation with five named models
- saved cards: five priced products from 49,281 to 74,990 RUB
- selection readiness: `ready_for_preliminary_cards`
- pre-send review: `pass`, no issues

This proves that recovery successfully waited for the original execution lease, resumed the same durable turn from the final answer contract, and saved the correct response. The remaining failure is the second transport boundary: the recovery SSE itself ended before its `done` payload reached the iframe, and the client did not try the idempotent recovery endpoint again.

## Required general fix

Retry only the transport of the same recovery `turnId` after a response body closes without `done` or another recoverable network failure. A repeated recovery call is idempotent and returns the already-saved answer immediately. Do not retry an explicit SSE error with `recoverable:false`, and never create a new turn or planner run.
