# Dialogue Error Remediation Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Fix the observed Bakaut AI consultant failures globally: schema drift, handoff hangs, premature generator recommendations, numeric contradictions, and weak final selection.

**Architecture:** Keep behavior corrections in the agent contract and selection pipeline, not in trigger-word branches. Add explicit state/contract gates for critical buying facts, deterministic numeric sanity checks around generated answers, and robust UI/backend lifecycle handling for lead handoff. Preserve the assistant's universal manager logic: understand need, update state, verify facts, choose the next step, then answer.

**Tech Stack:** Fastify + TypeScript backend, React iframe widget, PostgreSQL/pgvector, Vitest, Playwright local live checks.

---

## Current root-cause findings

1. `conversation_sessions.history_summary` schema drift
   - `src/db/repositories.ts` expects `history_summary` via `mapSession()` and `RETURNING *` / `SELECT s.*`.
   - `sql/004_history_summary.sql` exists, but local dev can run `npm run dev:server` without `npm run migrate`.
   - A drifted DB can have `schema_migrations` claiming `004_history_summary.sql` was applied while the physical column is missing.
   - Fix already applied: fresh schema now includes `history_summary text`; migration runner now runs an idempotent required-schema repair; `dev:server` runs migrations before watch.

2. Handoff/contact hang
   - `/api/leads` itself has bounded email handling through `src/email/httpEmail.ts` timeout/catch.
   - `/api/leads` calls `getSession()` and `listMessages()` first; missing `history_summary` can fail the route before the email branch.
   - The chat SSE request can keep the UI on a status message until the backend sends `done` or `error`. The client already handles `event: error`, but there is no client-side watchdog if the stream stays open too long.

3. Premature generator recommendation
   - `src/ai/assistant.ts` can set `singlePhase220=true` with provenance `inferred_from_load` from household-like load context.
   - `hasReliableGeneratorSelectionBasis()` treats calculated load or power constraint as sufficient, without requiring explicit phase/voltage confirmation.
   - `resolveTurnContract()` does not enforce critical-fact gating; it maps planner intent to cards/lead form but does not downgrade recommendation to clarifying question when a critical fact is inferred or missing.

4. Numeric contradictions such as `4–3,5 кВт` and `5–5 кВт`
   - Power parsing/normalization exists for selection, but answer text is not passed through a numeric sanity layer before streaming/saving.
   - There is no deterministic check that visible answer ranges have `min <= max`, avoid degenerate ranges, and align with selected product facts.

5. Weak final 1–2 model choice
   - Selection can show a broad visible set and ask narrowing questions, but answer guidance does not force a confident final shortlist once critical facts are closed.
   - There is no explicit confidence contract separating: preliminary options, shortlist, final recommendation, and handoff-ready choice.

6. Unknown consumer power causes questionnaire behavior
   - Generator load extraction recognizes only a few named consumers: light, refrigerator, boiler, pump.
   - When a buyer names a real consumer whose exact power is unknown to the buyer and not encoded in backend heuristics, the system often fails to create `loadProfile.requiredNominalKw`.
   - `hasReliableGeneratorSelectionBasis()` then treats the turn as lacking a reliable load/power basis and downgrades to a clarification like “какая нагрузка в кВт/Вт”.
   - This is correct for dangerous/industrial uncertainty, but wrong for common consumer classes where an AI consultant should classify the load, use a cautious average/range, label the result preliminary, and ask only the one risk-changing follow-up if needed.

7. Text/card count contract is missing
   - The final assistant is prompted to name 1–2 models in text, but cards are selected by a separate renderer.
   - There is no normalized field such as `requestedOptionCount` / `maxVisibleCards` when the buyer explicitly asks for “1–2 варианта”.
   - Therefore the text can promise two options while `selectProductsForTurn()` / `selectCardsFromPlan()` still shows up to the default visible limits.
   - Broad cards are acceptable when the buyer did not limit the choice; the bug is only the mismatch between an explicit requested count, the text promise, and visible cards.

8. Browser dogfood evidence from generator consumer-reference run
   - Protocol: `local-live-tests/2026-04-30-generator-consumer-reference-browser.local.md`.
   - Buyer asked for a generator for lamps, chargers/router, freezer, and sometimes an electric chain saw without knowing saw wattage.
   - The assistant correctly used named consumers as generator loads and gave a shortlist instead of stopping at “сколько кВт?”.
   - Follow-up explicitly requested “один основной генератор и один запасной”; prose selected EVOline KB 9000 E as main and Zongshen KB 9000 E as backup.
   - Rendered cards still showed `ПОДХОДЯЩИЕ ВАРИАНТЫ 35 шт.`, 7 visible cards, and `Показать еще 28`.
   - The answer also produced a confusing generator-power sentence: `6,5 кВт номинала и 6,1 кВт по пику`; buyer-facing peak/max should never be lower than nominal/running.

---

## Task 1: Lock required DB schema at migration and dev startup

**Objective:** Ensure both fresh and drifted local DBs always have `conversation_sessions.history_summary` before server code can read/write sessions.

**Files:**
- Modify: `sql/001_init.sql`
- Modify: `src/db/migrate.ts`
- Modify: `package.json`
- Test: `tests/migrate.test.ts`

**Implemented now:**
- Add `history_summary text` to the initial `conversation_sessions` table.
- Export `repairRequiredSchema(client)` from `src/db/migrate.ts`.
- Call repair after normal SQL migrations and before `COMMIT`.
- Change `dev:server` to `npm run migrate && tsx watch src/server.ts`.
- Add tests proving fresh schema and drift repair.

**Verification:**
- Run: `npm test -- --run tests/migrate.test.ts tests/conversationRepository.test.ts`
- Run: `npm run migrate`
- Query `information_schema.columns` for `conversation_sessions.history_summary` without printing credentials.

---

## Task 2: Add critical-facts gating for generator recommendations

**Objective:** Prevent confident generator recommendations until phase/voltage is explicit, or clearly label the output as preliminary and ask the phase question.

**Files:**
- Modify: `src/ai/assistant.ts`
- Modify: `src/ai/assistantTypes.ts` if provenance typing needs extension
- Modify: `src/ai/turnContract.ts`
- Test: add/extend `tests/turnContract.test.ts` and an assistant selection unit test

**Steps:**
1. Add a small helper near selection helpers:
   - `isGeneratorPhaseExplicit(state)` returns true only when `hardConstraints.singlePhase220` is boolean and `provenance.singlePhase220 !== 'inferred_from_load'`.
   - `missingCriticalGeneratorFacts(state)` returns `['phase_voltage']` for generator intent when phase is absent/inferred.
2. In selection override logic, before forcing `recommend_products`, check missing critical facts.
3. If critical facts are missing:
   - keep product cards allowed only as preliminary if useful;
   - set `followUpPolicy='askClarifyingQuestion'`;
   - append guidance: ask whether input is 220 V single-phase or 380 V three-phase before final recommendation;
   - avoid wording like “лучший вариант” or “берите эту модель”.
4. Add tests:
   - household load with inferred `singlePhase220` does not become final recommendation;
   - explicit 220 V allows final recommendation when load/power is sufficient;
   - explicit 380 V does not get 220-only recommendations.

**Expected behavior:** Assistant can still help, but says “предварительно подходят…” and asks one phase question before final choice.

---

## Task 3: Add numeric answer sanity before streaming/saving

**Objective:** Stop visibly impossible ranges and degenerate power claims in buyer-facing text.

**Files:**
- Modify: `src/ai/assistant.ts` or create `src/ai/answerSanity.ts`
- Test: create `tests/answerSanity.test.ts`

**Steps:**
1. Extract a pure function `sanitizeVisibleAnswerNumbers(answer: string, context)`.
2. Detect power ranges with `кВт`, `кВА`, `kw`, `kva`: `a-b`, `a–b`, `a—b`, `от a до b`.
3. If `a > b`, swap and normalize to Russian decimal comma.
4. If `a === b`, collapse `5–5 кВт` to `5 кВт` unless the source explicitly means exact min/max fields.
5. Add an answer-generation guard: after full text is produced and before save/stream final fallback, run sanity and log a diagnostic if it changed text.
6. Add tests for:
   - `4–3,5 кВт` -> `3,5–4 кВт`;
   - `5–5 кВт` -> `5 кВт`;
   - normal `3,5–4 кВт` unchanged.
   - `6,5 кВт номинала и 6,1 кВт по пику` must be rewritten or neutralized so peak/max is not presented below nominal/running.

**Caution:** Do not use this to invent product specs. It only fixes formatting/order of numbers already present in generated text.

---

## Task 4: Strengthen final shortlist confidence contract

**Objective:** Make the assistant confidently narrow to 1–2 models when critical facts are closed and catalog evidence supports it.

**Files:**
- Modify: `src/ai/assistant.ts`
- Modify: `src/ai/prompts.ts`
- Test: add focused prompt/contract tests

**Steps:**
1. Add a selection confidence label: `preliminary`, `shortlist`, `final`.
2. Compute `final` only when:
   - critical facts closed;
   - no hard violations;
   - selected products have enough matching facts;
   - hidden products do not materially change the top choice.
3. Pass the label into answer guidance.
4. For `final`, instruct the answer to name 1 primary and at most 1 alternative, with reasons tied to facts.
5. For `preliminary`, prohibit “лучший/оптимальный” final wording and require one next question.
6. Add tests for guidance/contract output.

---

## Task 5: Add unknown-consumer load classification for generator consultation

**Objective:** Stop questionnaire behavior when the buyer names a connected consumer but does not know its exact power. Convert unknown consumers into cautious load classes when safe, and ask only risk-changing follow-ups.

**Files:**
- Modify: `src/ai/assistant.ts`
- Modify: `src/shared/types.ts` only if load-profile metadata needs a new uncertainty field
- Modify: `src/ai/prompts.ts`
- Test: extend `tests/recommendationRanking.test.ts` or create focused generator load tests
- Test: extend `tests/turnContract.test.ts` for clarification vs preliminary recommendation behavior

**Design:**
1. Add a small generic load classifier, not a one-off trigger-word fix:
   - `resistive_light_load`: lighting, chargers, small electronics; low/no startup.
   - `motor_compressor_load`: fridge, pump, compressor, pressure washer; high startup risk.
   - `handheld_tool_load`: drill, grinder, rotary hammer, circular saw, small tool; medium/high startup risk.
   - `heating_resistive_load`: kettle, heater, welding/heat gun; high running load, low startup but may exceed small generator.
   - `unknown_named_load`: buyer named a consumer, but classifier cannot safely map it.
2. For known safe/common classes, create an estimated range rather than a fake exact number:
   - include `runningKwMin/runningKwMax` and `startingKwMin/startingKwMax` conceptually, or map to conservative `runningKw/startingKw` with `source='estimated_average'` and evidence.
   - mark guidance as preliminary: “если инструмент бытовой; если профессиональный/мощный — нужен запас выше”.
3. For `unknown_named_load`, do not ask “сколько кВт?” as the first/only question. Ask a more answerable risk-class question:
   - “это бытовой ручной инструмент, насос/компрессор или нагреватель?”
   - if product category is high-risk, ask model/type/power.
4. Update `hasReliableGeneratorSelectionBasis()` semantics:
   - explicit load/power => can final-recommend if other critical facts are closed;
   - estimated common load => can show preliminary shortlist/cards with caveat and one narrowing question;
   - unknown/high-risk load => ask clarifying question, no final recommendation.
5. Update answer guidance:
   - Never say “не знаю мощность — не могу подобрать” for common consumer classes.
   - Say “возьму среднюю оценку для бытового X” and expose the assumption.
   - If the assumption can change the generator class, ask exactly one follow-up.
6. Add regression tests:
   - “свет и иногда болгарка/дрель, мощность не знаю” creates a preliminary load basis, not a bare kW question.
   - “какой-то аппарат, мощность не знаю” asks for type/class, not exact kW only.
   - “насос, мощность не знаю” stays cautious because motor startup can dominate.
   - explicit power still overrides estimated averages.

**Acceptance:**
- The assistant behaves like a consultant: estimates common loads, labels uncertainty, and asks only the question that changes the recommendation.
- No broad trigger-word branch that only fixes one phrase.
- Tests prove the behavior for at least handheld tool, pump/motor, and fully unknown named consumer.

---

## Task 6: Add explicit option-count/card-count contract

**Objective:** Keep visible cards synchronized with buyer-requested option count and answer text, while preserving broad choice when the buyer did not limit the number of options.

**Files:**
- Modify: `src/ai/assistantTypes.ts`
- Modify: `src/ai/prompts.ts`
- Modify: `src/ai/assistant.ts`
- Modify: `src/ai/turnContract.ts` if render contract gets the limit
- Test: add/extend card selection and turn contract tests

**Steps:**
1. Add normalized fields to the turn/selection contract, for example:
   - `requestedOptionCount?: number`
   - `maxVisibleCards?: number`
   - provenance: `explicit_user` vs default/broad browsing.
2. Detect explicit requests such as “1 вариант”, “2 варианта”, “пару вариантов”, “только один”, “выбери лучший”.
   - Include paired-shortlist phrasing from browser dogfood: “один основной и один запасной”, “основной + запасной”, “главный и резервный”.
3. If explicit count exists, pass it from planner/heuristic contract into `selectProductsForTurn()` and `selectCardsFromPlan()`.
4. Cap `visibleProducts` and final cards by `maxVisibleCards` only for explicit count requests.
5. Add answer guidance: if card cap is explicit, text must not say “показываю широкий выбор”; if cards are broad by default, text may say “оставил выбор карточками”.
6. Add tests:
   - buyer asks “дай 2 варианта” => at most 2 visible cards and text guidance says two.
   - browser regression: follow-up asks “один основной генератор и один запасной” => at most 2 visible cards and no “Показываю первые 7 карточек” wording.
   - buyer asks general “подбери варианты” => broad cards remain allowed.
   - structured selection cannot overwrite explicit `maxVisibleCards` with default 7/10.

**Acceptance:**
- Broad cards remain available by default.
- Explicit 1–2 option requests cap visible cards and text/card count cannot diverge.

---

## Task 7: Add SSE and lead handoff watchdogs

**Objective:** Avoid indefinite “Собираю короткий ответ...” / stuck handoff states when backend or network stalls.

**Files:**
- Modify: `src/client/main.tsx`
- Modify: `src/routes/chat.ts` if backend timeout/error events need clearer diagnostics
- Test: add client stream parser/unit tests if test harness exists; otherwise cover via Playwright local live protocol

**Steps:**
1. In `streamMessage()`, track last SSE event time.
2. Add an AbortController timeout slightly above backend status cadence or below backend generation timeout, e.g. client watchdog at 190s with user-friendly error.
3. Ensure `finally` always clears busy status and abort refs.
4. For lead submission, set a client-side timeout and show “Заявка не отправилась, попробуйте ещё раз” instead of silent stuck sending.
5. Keep backend `/api/leads` HTTP email timeout/catch; do not add SMTP.
6. Add a local live test that submits contact after a recommendation and verifies either sent or visible error, never endless spinner.

---

## Task 8: Add behavior eval/live regression scenarios

**Objective:** Make the observed failures reproducible and prevent regressions.

**Files:**
- Modify/create: prompt/eval tests under `tests/`
- Create live protocol: `local-live-tests/YYYY-MM-DD-generator-phase-handoff.local.md`

**Scenarios:**
1. Generator for house/pump/refrigerator, phase not stated:
   - expected: asks 220/380 before final choice, may show preliminary cards.
2. Same scenario after user confirms 220 V:
   - expected: confident 1–2 model shortlist.
3. Unknown common consumer power:
   - buyer says “свет и иногда болгарка или дрель, мощность не знаю”;
   - expected: uses cautious average for a household handheld tool, says the assumption, does not ask only for exact kW.
4. Fully unknown named consumer:
   - buyer names an unclassified device and says power is unknown;
   - expected: asks for consumer class/type/model, not a bare exact-kW question.
5. Explicit option count:
   - buyer asks for “2 варианта”;
   - expected: text and visible cards stay capped to two.
6. Broad choice by default:
   - buyer asks generally to “подбери варианты” without limiting count;
   - expected: broad card choice remains allowed.
7. User asks to leave contact:
   - expected: lead form opens/submits, no hang.
8. Numeric output scan:
   - expected: no descending or degenerate kW ranges.

**Commands:**
- `npm test -- --run tests/turnContract.test.ts tests/answerSanity.test.ts tests/prompts.test.ts`
- Start local backend/web with GPT-5.5 models.
- Run Playwright live driver and save transcript to `local-live-tests/*.local.md`.

---

## Acceptance criteria

- No `history_summary`/`historysummary` DB errors in local migration or live dialogue.
- Fresh DB and drifted DB both contain `conversation_sessions.history_summary`.
- Generator recommendations do not become final until 220/380 is explicit.
- Unknown common generator consumers are classified into cautious load classes; the assistant estimates preliminarily instead of asking only for exact kW.
- Fully unknown/high-risk consumers ask for type/model/class before final recommendation.
- Buyer-facing answer has no impossible power ranges like `4–3,5 кВт` or `5–5 кВт`.
- When critical facts are closed, assistant gives a clear 1–2 model recommendation instead of vague hedging.
- If the buyer explicitly asks for 1–2 options, visible cards and text stay capped to that count.
- If the buyer does not limit option count, broad card choice remains allowed.
- Contact handoff never leaves the UI indefinitely busy.
- Targeted unit tests pass.
- Any behavior change is verified through local UI live dialogue and saved in `local-live-tests/*.local.md`.
