# Task specification: commercial selection sanity and evidence continuity

Status: FROZEN
Frozen at: 2026-07-13 12:35 Europe/Moscow
Task ID: `2026-07-13-commercial-selection-sanity`

## Objective

Prevent a formally valid but commercially absurd generator recommendation from passing selection or verification. A preliminary selection must search broadly enough, rank by buyer fit and price, preserve previously validated products across follow-ups, and produce a concrete recommendation without forcing the buyer to repeat the request.

## Production failure being fixed

Session `18a8f799-8325-43d2-a236-c2e0531078a2` on production commit `b92baf7d635ee3a8b93a93ebdce1c3b3010783a4`:

- deterministic load result: minimum nominal power `4.5 kW`;
- assistant's own practical orientation: `5-6 kW`;
- previously visible valid product: EVOline PB 7000, `6.0 kW`, `69,990 RUB`;
- next turn showed only Dinking DK9000iE, `8.5 kW`, `170,000 RUB`;
- structured recovery was not attempted because one formal match survived;
- the final “which should I buy without overpaying?” continuation ended in `agent_manager_recovery_failed`.

## Acceptance criteria

- **AC1 — No first-survivor stopping:** A structured catalog selection does not stop merely because one formally valid candidate survived retrieval. When the requested card count or a useful comparison set is not filled, deterministic canonical recovery scans the catalog and fills the candidate pool when matching products exist.
- **AC2 — Commercial fit ranking:** Generator candidates that satisfy hard constraints are deterministically ordered by closeness to the confirmed/preferred nominal-power target and then by price. A materially oversized expensive option cannot outrank a closer cheaper valid option without an explicit buyer preference that justifies it.
- **AC3 — Derived load target:** When `calculator.generatorLoad` supplies a minimum nominal power and no explicit upper range exists, the selector uses that minimum as the lower bound and favors the nearest adequate powers rather than arbitrary larger powers.
- **AC4 — Requested range ownership:** Explicit buyer power ranges remain deterministic hard/preferred selection evidence and exact in-range products outrank adjacent alternatives.
- **AC5 — Historical product continuity:** Previously rendered and validated same-class products are revalidated against current hard constraints and remain candidates even when absent from the newest retrieval candidate-tier list.
- **AC6 — Historical evidence continuity:** A no-tool comparison/recommendation follow-up may reuse prior immutable catalog facts and compatible calculator evidence from the active dialogue. It must not fail merely because the current turn has no new catalog/calculator call.
- **AC7 — Stale evidence safety:** Historical products or calculator evidence are not reused when the buyer changes product class, load facts, phase, explicit range, budget, or rejects a product in a way that makes the old evidence incompatible.
- **AC8 — Honest scarcity claims:** “Only one/no option” wording is allowed only when the deterministic canonical recovery was attempted and its evidence supports the count. Otherwise the answer must avoid a scarcity claim.
- **AC9 — Useful preliminary recommendation:** Missing a pump nameplate may downgrade certainty to preliminary, but it may not prevent showing and recommending the closest useful catalog options with a clear caveat.
- **AC10 — Answer/card consistency:** Names, nominal powers, prices, selected IDs, tiers, and cards remain mutually consistent.
- **AC11 — Full regression:** Tests reproduce the failed production sequence: 4.5 kW load minimum, prior 6.0 kW/69,990 RUB card, noisy search with one 8.5 kW/170,000 RUB survivor, then a no-tool “which should I buy?” follow-up. The closest valid products must survive and the recommendation turn must complete.
- **AC12 — No phrase-specific patch:** The implementation must not add a regex, canned answer, model-name exception, or hardcoded EVOline/Dinking rule for this dialogue.
- **AC13 — Verification discipline:** No positive live verdict is recorded before the full buyer-view and admin-metadata audit of every turn is complete. Any contradiction, lost suitable product, recovery fallback, or unsupported scarcity claim fails the release.
- **AC14 — Local gate:** Focused tests, typecheck, regex guard, agentic eval, full `npm run verify`, and `git diff --check` pass on the final code.
- **AC15 — Deployment proof:** Changes are committed and pushed to GitHub `main`; Railway `/api/health` reports the exact pushed commit. No manual Railway deployment is used.
- **AC16 — Embedded production proof:** A fresh adaptive dialogue is conducted through the embedded widget on `https://bakautprof.ru/`; each buyer turn follows the actual assistant response.
- **AC17 — Production metadata proof:** The live protocol records buyer-visible transcript, cards/prices, `selectionGoal`, requirements, tool results, canonical recovery, tiers, continuity, warnings, recovery/fallback status, and per-turn verdict.

## Non-goals

- Do not promise stock, discounts, delivery dates, or commercial terms.
- Do not move catalog fact verification or safety checks into free-form LLM text.
- Do not solve the failure by forcing one brand/model or by suppressing all large generators.
- Do not weaken phase, power, price, product-ID, or answer/card parity validation.
