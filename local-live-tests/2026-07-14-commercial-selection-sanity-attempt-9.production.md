# Production live protocol: commercial selection sanity, attempt 9

- Date: 2026-07-14
- Site: embedded widget on `https://bakautprof.ru/policy/?codex_live_attempt9=511de70`
- Production commit: `511de705bb967366d43290ef2cb46dd86c4616d4`
- Session: `61b981c4-a350-454e-94d8-1cb8f498ce34`
- Admin conversation: `1756`
- Verdict: FAIL

## Adaptive buyer transcript and visible audit

### Turn 1

Buyer: `Нужен генератор для дачи: скважинный насос 1,1 кВт и болгарка 1,5 кВт могут работать одновременно. Дом однофазный 220 В, автозапуск не нужен.`

Assistant calculated a preliminary 4.5 kW minimum, recommended the 5-6 kW class, and displayed six priced cards. The visible set included:

- SUMEC SU8800, 6.0 kW, 47,990 RUB;
- BISON BS6250IE, 5.0 kW, 61,100 RUB;
- TSS SGG 5000EI, 5.0 kW, 64,558 RUB;
- FUBAG BS 5500 A ES, 5.0 kW, 71,180 RUB;
- TSS SGG 5000ESI, 5.0 kW, 93,940 RUB;
- ET-POWER ET5500iS, 5.0 kW, 98,200 RUB.

It recommended SUMEC as the practical no-overpayment option and clearly kept the selection preliminary pending the pump start data.

Visible verdict: PASS.

### Turn 2

Buyer, following the actual cards and recommendation: `Шесть вариантов много. Сравните только SUMEC SU8800 за 47 990 ₽ и BISON BS6250IE за 61 100 ₽: что я реально получаю за доплату и что лучше взять для дачи без переплаты?`

Widget response: `Сейчас не смог надежно сформировать ответ. Вопрос сохранен, повторите его через пару минут.`

Visible verdict: FAIL. The assistant lost a direct comparison of two products it had just selected and priced.

## Admin metadata audit

### Turn 1 (`83e9550b-3df0-4d36-b543-1ea038451b4f`)

- Status: `completed`; stage: `assistant_message_saved`; no recovery or error.
- Answer and six cards were delivered consistently to the buyer.

### Turn 2 (`a1ce09b0-f0b1-4169-bc4f-e251e1da5452`)

- Status: `failed`; stage: `recovery_failed`; error code: `agent_manager_recovery_failed`.
- The need state correctly retained only SUMEC SU8800 and BISON BS6250IE as selected products and captured the no-overpayment comparison goal.
- Planner output failed runtime validation because `toolRequests[1].args.comparisonAttributes` contained more than the allowed 12 entries.
- Recovery repeated the same structural contract failure; no answer was saved for turn 2.
- Exact error: Zod `too_big`, `maximum: 12`, path `toolRequests.1.args.comparisonAttributes`.

## Root cause boundary

- LLM responsibility: choose the decision-relevant attributes and comparison policy. It correctly understood which two models and commercial goal were active.
- Contract responsibility: the handwritten OpenAI JSON Schema allowed an unbounded `comparisonAttributes` array, while the runtime Zod schema silently imposed `.max(12)`. The model could satisfy its supplied schema and still be rejected by runtime code.
- General fix: publish the same array and integer limits in the Structured Outputs JSON Schema that runtime Zod enforces, add an explicit prioritization instruction, and add a parity regression. No SUMEC/BISON or buyer-phrase rule is needed.
