# Evidence: commercial selection sanity and evidence continuity

Status: IN PROGRESS — production attempt 9 exposed Structured Outputs/runtime schema divergence; schema parity is locally verified and awaiting deployment

The specification is frozen before implementation. Production session `18a8f799-8325-43d2-a236-c2e0531078a2` is the authoritative failing baseline.

No acceptance criterion is marked PASS until current-code verification and the fresh embedded production audit are complete.

## Current-code local verification

- Focused selection suites: PASS, 147/147 tests.
- Full release gate: PASS after rerunning with registry access.
- Full test suite: PASS, 968/968 tests.
- Agentic eval suite: PASS, 251/251 tests.
- TypeScript typecheck: PASS.
- Production dependency audit: PASS, 0 vulnerabilities.
- Production build: PASS.
- New-regex guard: PASS; no phrase-specific regex was added.
- `git diff --check`: PASS.

The new regressions prove both failure modes locally:

1. one oversized 8.5 kW / 170,000 RUB survivor triggers canonical recovery and does not outrank closer 5.5-6.0 kW products;
2. a follow-up asking what to buy without overpaying reuses the prior safe calculator and catalog evidence, retains the close products, and completes without fallback.
3. when the buyer changes the load facts, the previous calculator result is rejected as stale and no product is presented as a validated fit from that old calculation.

## Production attempt 1

- Commit marker: PASS for `50ee8a5d8d7b64346933c628844a20842c3ebeb0`.
- Embedded session: `9ad5a646-0f86-4bf5-8df2-1984dcd84538`.
- Buyer-view audit: FAIL on turn 3 because the assistant contradicted its immediately previous gasoline cards and claimed that no model could be shown.
- Admin audit: FAIL. The planner correctly produced strict `fuel_type=gasoline`; deterministic strict validation did not support that requirement kind and suppressed all products. Turns 2-4 were recovered, and pre-send review did not catch the cross-turn contradiction.
- Protocol: `local-live-tests/2026-07-13-commercial-selection-sanity-attempt-1.production.md`.

The release remains unaccepted. The fuel-type validator fix and its exact regression are local-only until a new commit is pushed and a fresh embedded production audit passes.

## Local verification after attempt 1

- Strict `fuel_type=gasoline` is now accepted only when bound to typed `selectionPolicy.powerSource=fuel`.
- Gasoline/diesel remains a deterministic catalog fact check; LLM still owns interpretation of the buyer's request.
- Exact regression keeps SUMEC SU8800 and TSS SGG 5000N while removing FIRMAN diesel.
- Focused suites: PASS, 149/149.
- Full suite: PASS, 970/970.
- Agentic eval: PASS, 251/251.
- Typecheck, production build, no-new-regex guard, diff check: PASS.
- Production dependency audit: PASS, 0 vulnerabilities.

## Production attempts 2 and 3

- Attempt 2 / session `710f559f-a5cb-415e-9b43-194ea500afd5`: buyer-visible selection and recommendation were correct, but turn 3 used same-turn recovery. Verdict: NOT CLEAN under AC13.
- Attempt 3 / session `9ea0d9b6-2cd3-44e3-8d49-f684f3ffb3a2`: turn 1 showed four correct priced 5.0 kW products; turn 2 falsely suppressed them after the buyer required visible prices. Verdict: FAIL.
- Admin root cause: strict `price_visibility=true` was correctly emitted by the planner but was not implemented in deterministic strict-requirement validation. Historical cards and tool evidence existed; the unsupported-kind blocker erased them.
- Protocols: `local-live-tests/2026-07-13-commercial-selection-sanity-attempt-2.production.md` and `local-live-tests/2026-07-13-commercial-selection-sanity-attempt-3.production.md`.

## Current local verification after attempt 3

- Strict `price_visibility=true` is accepted only in the supported boolean shape and remains a deterministic catalog fact check.
- Products without a finite positive catalog price are removed individually; priced products are retained.
- Historical continuity regression now includes strict price visibility and preserves the prior priced products.
- Focused selection suites: PASS, 150/150.
- Full suite: PASS, 971/971.
- Agentic eval: PASS, 251/251.
- Typecheck and production build: PASS.
- `git diff --check`: PASS.
- Release status remains FAIL pending commit, Railway marker, and fresh embedded production proof.

## Production attempt 6

- Commit marker: PASS for `31f965d277f0ef9e0377cb2955f4a0990fa22579`.
- Embedded session: `30b1820f-1c33-47e1-bd19-765ecfa4d1a0`; admin conversation `1753`.
- Buyer-view audit: FAIL. Turn 1 calculated approximately 5 kW but refused to show cards; turn 2 ended in the public technical fallback after the buyer explicitly requested 2-3 nearby gasoline, single-phase, priced products.
- Admin audit: FAIL. The LLM correctly emitted strict `voltage_v=220`; deterministic strict validation did not support that requirement kind and suppressed the catalog. Turn 1 recovered; turn 2 exhausted recovery while reusing the same empty product state.
- Protocol: `local-live-tests/2026-07-14-commercial-selection-sanity-attempt-6.production.md`.

## Current local verification after attempt 6

- Strict generator `voltage_v` is accepted only for supported voltage values and units when it agrees with typed `selectionPolicy.phase`.
- 220/230 V retains products deterministically classified as single-phase (or mixed-voltage where applicable); 380/400 V retains three-phase or mixed-voltage products; unknown phase remains fail-closed.
- The orchestrator applies the same voltage verifier to answer products, so response text and visible cards cannot bypass the fact check.
- Focused selection suites: PASS, 151/151.
- Full suite: PASS, 972/972.
- Agentic eval: PASS, 251/251.
- Typecheck, no-new-regex guard, production dependency audit, build, release gate, and `git diff --check`: PASS.
- Release status remains FAIL pending commit, exact Railway marker, and a fresh clean embedded-widget dialogue plus admin audit.

## Deployment and production attempts 7-8

- Voltage verifier commit `45892db7a11417892ae0867fe00aedc4e4856431` was pushed to GitHub `main`; Railway health reported the exact commit.
- Attempt 7 produced one clean completed turn with four correct priced cards. Browser control failed before turn 2 was submitted; admin data confirmed that the second message was absent. Reloading reset the iframe session, so this run is recorded as incomplete and not accepted as proof.
- Attempt 8 / session `696f837d-0082-48ab-856a-50f8f4314fc7` visibly returned the generic technical fallback on turn 1. Verdict: FAIL.
- Admin conversation `1755` showed that the same turn actually completed normally in about 46.6 seconds: planner, calculator, catalog, voltage validation, preliminary selection, review, answer save, and four card selection all succeeded with `recovered=false`.
- The persisted answer was not delivered to the buyer. The client had no recovery key when the primary SSE body ended before a parsable `turn` event/done payload.
- Protocol: `local-live-tests/2026-07-14-commercial-selection-sanity-attempt-8.production.md`.
- Raw admin summary: `.agent/tasks/2026-07-13-commercial-selection-sanity/raw/attempt-8-admin-summary.json`.

## Current local verification after attempt 8

- The initial SSE response now exposes `x-chat-turn-id` immediately after durable turn creation; the recovery route exposes the same header.
- The client reads the response header before consuming the body, so it can recover the already-saved answer when the primary SSE body closes before any event is delivered.
- Exact regression: an empty primary stream plus the durable header triggers the same-turn recovery endpoint and returns the saved answer and card payload.
- Focused transport suites: PASS, 22/22.
- Full suite: PASS, 974/974.
- Agentic eval: PASS, 251/251.
- Typecheck, no-new-regex guard, production dependency audit, production build, release gate, and `git diff --check`: PASS.
- Release status remains FAIL pending commit, exact Railway marker, and a fresh clean multi-turn embedded-widget dialogue plus per-turn admin audit.

## Deployment and production attempt 9

- Transport recovery commit `511de705bb967366d43290ef2cb46dd86c4616d4` was pushed to GitHub `main`; Railway health reported the exact commit.
- Attempt 9 / session `61b981c4-a350-454e-94d8-1cb8f498ce34` completed turn 1 normally and displayed six consistent priced 5-6 kW cards.
- The adaptive turn 2 asked to compare only the visible SUMEC SU8800 / 47,990 RUB and BISON BS6250IE / 61,100 RUB and choose without overpayment.
- Buyer view: generic technical fallback and no comparison. Verdict: FAIL.
- Admin turn `a1ce09b0-f0b1-4169-bc4f-e251e1da5452`: `failed`, `recovery_failed`, `agent_manager_recovery_failed`.
- Need state correctly retained the two selected models and buyer goal, but the planner contract failed on `toolRequests[1].args.comparisonAttributes`: output length exceeded runtime Zod maximum 12.
- Root cause: handwritten OpenAI JSON Schema had no `maxItems`, while runtime Zod did. Recovery repeated the same hidden-contract failure.
- Protocol: `local-live-tests/2026-07-14-commercial-selection-sanity-attempt-9.production.md`.
- Raw admin summary: `.agent/tasks/2026-07-13-commercial-selection-sanity/raw/attempt-9-admin-summary.json`.

## Current local verification after attempt 9

- Structured Outputs now publishes the runtime limits for catalog/web comparison attributes, product IDs/names, generator loads, basis signals, simultaneous-start kinds, requirement coverage, selection requirements, ledger events, selected answer products, card count, and bounded integer tool limits.
- Planner prompt explicitly limits `comparisonAttributes` to 12 distinct decision-relevant attributes and asks the LLM to prioritize buyer criteria rather than emit synonyms.
- Schema parity regression inspects all affected exported response formats and prevents the specific hidden-limit class from returning.
- Focused contract suite: PASS, 11/11.
- Full suite: PASS, 975/975.
- Agentic eval: PASS, 251/251.
- Typecheck, no-new-regex guard, production dependency audit, production build, release gate, and `git diff --check`: PASS.
- Release status remains FAIL pending commit, exact Railway marker, and a fresh clean multi-turn embedded-widget dialogue plus per-turn admin audit.
