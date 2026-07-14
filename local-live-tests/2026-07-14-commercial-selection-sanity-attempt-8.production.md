# Production live protocol: commercial selection sanity, attempt 8

- Date: 2026-07-14
- Site: embedded widget on `https://bakautprof.ru/policy/?codex_live_attempt8=45892db`
- Production commit: `45892db7a11417892ae0867fe00aedc4e4856431`
- Session: `696f837d-0082-48ab-856a-50f8f4314fc7`
- Admin conversation: `1755`
- Turn: `881dc369-aadf-4c12-ad7d-40b20a5468dc`
- Verdict: FAIL

## Preceding browser run

Attempt 7 completed one clean production turn and displayed four correct priced 5.0 kW cards, but browser control failed while submitting turn 2. The message was confirmed absent from admin data. A page reload reset the iframe session, so attempt 7 was stopped as an incomplete browser run and was not assigned a behavior PASS.

## Buyer-visible transcript

Buyer: `Нужен генератор для дачи: скважинный насос 1,1 кВт и болгарка 1,5 кВт могут работать одновременно. Дом однофазный 220 В, автозапуск не нужен.`

Widget response: `Сейчас не смог надежно сформировать ответ. Вопрос сохранен, повторите его через пару минут.`

The fallback remained visible after the backend turn had completed. No product cards or the saved answer were delivered to the buyer.

Buyer-view verdict: FAIL.

## Admin metadata audit

- Turn duration: `2026-07-14T10:02:14.020Z` to `2026-07-14T10:03:00.603Z` (about 46.6 seconds).
- Turn status: `completed`; stage: `assistant_message_saved`; no error code; `recovered=false`.
- The planner correctly emitted:
  - `generator_load_scenario` as a strict typed calculator requirement;
  - strict `phase=single_phase`;
  - strict `voltage_v=220 V`;
  - informational `auto_start_required=false` with `not_required` semantics.
- Calculator status: `ok`.
- Catalog status: `ok`; six preliminary matches survived deterministic constraints.
- Selection readiness: `ready_for_cards` / `ready_for_preliminary_cards`.
- Four cards were selected for the saved answer: TSS SGG 5000N, FIRMAN RD7910, SUMEC SU8800, and BISON BS6250IE.
- The answer writer saved a concrete 5-6 kW preliminary recommendation. Pre-send review rewrote two unsupported comparative claims before save.
- The saved assistant message and cards never replaced the buyer-visible fallback.

## Root cause boundary

- Semantic planning, deterministic voltage validation, calculation, catalog filtering, answer composition, review, and persistence all succeeded.
- The primary SSE connection ended without a `done` payload reaching the widget.
- Client recovery depended on receiving the SSE `turn` event first. If the stream closed before that event was parsed, the client had no `turnId`, could not request the already-saved answer, and displayed the generic fallback.
- General transport fix: expose the durable turn ID in the initial HTTP response header and let the client use it for same-turn recovery even when no SSE event survives. This is not a dialogue-specific rule.
