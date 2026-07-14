# Production live protocol: commercial selection sanity, attempt 6

- Date: 2026-07-14
- Site: embedded widget on `https://bakautprof.ru/policy/?codex_live_attempt6=31f965d`
- Production commit: `31f965d277f0ef9e0377cb2955f4a0990fa22579`
- Session: `30b1820f-1c33-47e1-bd19-765ecfa4d1a0`
- Admin conversation: `1753`
- Verdict: FAIL

## Adaptive buyer transcript and visible audit

### Turn 1

Buyer: `Нужен генератор для дачи: скважинный насос 1,1 кВт и болгарка 1,5 кВт могут работать одновременно. Дом однофазный 220 В, автозапуск не нужен.`

Assistant calculated an orientation of approximately 5 kW, but then said that it would not honestly show any suitable cards because no product had been confirmed under the strict conditions. No cards were displayed.

Verdict: FAIL. The buyer asked for a preliminary purchase selection and supplied enough information to show nearby catalog options with an explicit pre-purchase nameplate caveat. The response again converted an internal verification limitation into a refusal to sell.

### Turn 2

Buyer, adapting to the actual refusal: `Шильдика сейчас нет и я не собираюсь ехать за ним ради первого выбора. Покажите 2–3 ближайших бензиновых однофазных варианта около 5–6 кВт с ценами как предварительный подбор, а перед оплатой я уже сверю насос.`

Assistant: `Сейчас не смог надежно сформировать ответ. Вопрос сохранен, повторите его через пару минут.`

Verdict: FAIL. This is a visible technical fallback after an explicit request for concrete products and prices.

## Admin metadata audit

### Turn 1 (`d1f2d122-e7a0-406b-bf50-bc17a39d6e83`)

- Status: `recovered`; final stage: `assistant_message_saved`.
- The LLM planner correctly represented the operating scenario with `calculator.generatorLoad`, bound single-phase operation, and emitted strict `voltage_v=220` as a product attribute.
- The calculator succeeded with `requiredNominalKw=5`.
- Catalog processing ended with no product IDs and structured recovery reported no survivors.
- Warning: `answer_products_suppressed:unsupported_or_unverifiable_strict_hard_constraint:1`.
- Exact unsupported requirement: `voltage_v`. The deterministic validator did not recognize the typed voltage fact, even though product phase/voltage classification already existed.
- `answerProducts` and visible cards were empty. Pre-send review incorrectly passed the refusal.

### Turn 2 (`9817e2fe-6f07-49f5-b2a9-44f35452ff97`)

- Status: `failed`; stage: `recovery_failed`; error code: `agent_manager_recovery_failed`.
- Guard issues included `generator_preliminary_cards_missing_when_requested`, `no_card_answer_missing_concrete_result_step`, `style.internal_report`, and `semantic_rewrite_failed_recheck`.
- The quality guard correctly rejected the no-card answer, but all recovery attempts reused the same successful calculation and already-empty catalog/answer-product state.
- Recovery therefore repeated the blocked answer contract until the public fallback was emitted.

## Root cause boundary

- LLM responsibility: understand that 220 V means a single-phase generator requirement and that the buyer wants a preliminary shortlist. The planner did this correctly.
- Deterministic responsibility: validate `voltage_v` against confirmed generator phase/voltage facts and retain matching candidates. This verifier was missing.
- Recovery responsibility: it cannot repair the answer while reusing a catalog state that deterministic validation has already erased. Fixing the missing general verifier prevents this false empty state; no dialogue-specific response rule is required.
