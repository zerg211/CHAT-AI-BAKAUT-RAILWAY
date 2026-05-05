# Post LLM-first Audit and Fix Plan

> **EXECUTION REQUIRED / ТРЕБУЕТ ИСПОЛНЕНИЯ:** This plan is approved as the next-session implementation entry point. In a new session, start by opening this file, then execute the tasks in order with codebase-grounded-audit-and-remediation + test-driven-development. Do not treat this as a completed audit-only artifact.
>
> **For Hermes:** Use codebase-grounded-audit-and-remediation before implementing. This document is an executable remediation plan. It intentionally did not apply fixes at audit time, but it must be used to begin implementation when requested next.

**Status:** READY_FOR_EXECUTION

**Next-session start command/context:**
- Work only in `/mnt/c/Projects/chatAI` (`C:\Projects\chatAI`).
- Open this plan: `docs/plans/2026-05-02-post-llm-first-audit-and-fix-plan.md`.
- Begin with `Task 1: Add classifier matrix regression tests` and continue through all tasks.
- Keep the LLM planner as the source of buyer meaning; deterministic code is only for catalogue/business safety.

**Goal:** Find risks introduced or exposed by the LLM-first vibroplate remediation and plan broader fixes so the chat remains an AI sales manager, not a keyword-trigger system.

**Architecture:** Keep the LLM planner as the source of buyer meaning. Deterministic code may enforce catalogue/business safety, but classifier/retrieval/trace layers must not silently become another intent router.

**Tech Stack:** TypeScript, Vitest, Vite, Bakaut AI assistant pipeline under `src/ai`.

---

## Baseline checked

Scope: `/mnt/c/Projects/chatAI` only.

Commands run:

- `git diff -- src/ai/assistant.ts src/ai/needState.ts src/ai/productClassifier.ts tests/recommendationRanking.test.ts --check`
  - PASS: no whitespace/check errors in touched diff.
- `npm test -- --run tests/recommendationRanking.test.ts tests/needState.test.ts tests/turnContract.test.ts`
  - PASS: 3 files, 114 tests.
- `npm run build`
  - PASS.

Important: these checks prove compile and current regression safety, not full live behavior.

---

## Finding 1 — preliminary candidate retrieval is still keyword-profile driven before the LLM planner

**Severity:** P1

**Scope decision:** global project issue, not a local vibroplate-only issue.

**Evidence:**

- `src/ai/assistant.ts:3957-3970` builds `baseQuery`, then calls `findProducts(...)` before `planAssistantTurn(...)`.
- `src/ai/assistant.ts:3484-3510` uses `buildProductFitProfile(...)`, `recommendationScore(...)`, and `productFitPenalty(...)` to pre-filter/rank products.
- `src/ai/assistant.ts:755-777` still derives profile intent from `inferProductIntent(latestText)`, `inferProductIntent(queryText)`, and memory before LLM plan exists.

**Problem:**

The previous fix made invalid planner fallback safe, but the first candidate set shown to the planner is still produced by lexical/heuristic profile logic. That means the LLM may receive a biased product context before it gets a chance to semantically decide buyer intent. Final selection now has stronger LLM hard constraints, but the planner context can still be skewed, especially for broad catalog goods where the raw phrase contains shared words between whole machines, accessories, consumables, and spare parts.

**Why this is broader than a point fix:**

This affects every product class, not only виброплиты: generators vs generator accessories, cutters vs service kits, trowels vs blades/discs, oils vs machines, and exact-model questions. Any class where catalogue text shares terms with accessories can bias the planner's initial evidence.

**Fix direction:**

Create a two-tier retrieval model:

1. `plannerContextRetrieval`: broad, semantic, low-authority retrieval for LLM context. It may use text/vector search and exact model tokens, but must not hard-filter by inferred product intent from raw buyer words.
2. `selectionRetrieval`: strict retrieval after `AssistantTurnPlan` exists. This layer may use `requiredProductTraits`, `selectionState`, product role guards, and business constraints.

**Acceptance criteria:**

- A raw buyer phrase mentioning a whole product and related spare/accessory terms must not cause the planner context to contain only accessories.
- The planner receives a mixed but labeled context when ambiguity exists: core products, accessories, and why each is candidate context.
- Final cards remain governed by LLM plan + deterministic safety, not by preliminary keyword profile.

---

## Finding 2 — `spareAccessoryTerms` is too broad and can misclassify real core products as accessories

**Severity:** P1

**Scope decision:** global classifier issue for product-card role safety.

**Evidence:**

- `src/ai/productClassifier.ts:147-170` added global `spareAccessoryTerms` including broad substrings such as `комплект`, `бак`, `крышк`, `свеч`, `авр`.
- `src/ai/productClassifier.ts:620-621` sets `isGenericAccessoryProduct` from `classText` or `category`, then turns any plate product with those terms into `isPlateAccessory`.
- `src/ai/productClassifier.ts:660` excludes `isGenericAccessoryProduct` from `isPlate`.
- Direct probe result:
  - Product name/category: `Виброплита бензиновая ТСС VP80 комплект` / `Виброплиты`
  - Result: `isPlate: false`, `isPlateAccessory: true`, `core: false`.

**Problem:**

The current guard fixed filters/remни but reintroduced a trigger-word risk inside the catalogue classifier. A normal core product can be marked non-core just because its name contains `комплект`. Similar risks exist for other broad terms when they appear in legitimate product names, комплектации, bundles, or category naming.

**Why this is broader than a point fix:**

The defect is not the single word `комплект`; it is the classifier pattern: substring blacklist terms are allowed to demote product role without enough structural evidence. The same class of bug can appear for many catalogue categories and future products.

**Fix direction:**

Replace the flat blacklist role guard with a weighted, evidence-based product-role classifier:

- Strong accessory evidence:
  - category path/name explicitly says `Запчасти`, `Расходники`, `Аксессуары`, `Кожухи`, `Масло`, etc.;
  - product title is of the form `<part/accessory noun> для <machine>`;
  - product title begins with part/accessory noun (`фильтр`, `ремень`, `коврик`, `кожух`, `свеча`, `карбюратор`, etc.).
- Strong core evidence:
  - category is a core machine category (`Виброплиты`, `Генераторы`, `Бензорезы`, etc.);
  - title starts with a core machine noun (`виброплита`, `генератор`, `бензорез`, etc.).
- Ambiguous words such as `комплект`, `бак`, `крышка`, `АВР` must not alone demote a product; they need category/title-form support.
- Use token/word-boundary matching instead of raw `includes` where feasible.

**Acceptance criteria:**

- Core product with `комплект` in a core category remains core.
- `Фильтр/ремень/коврик для виброплиты` remains accessory/spare.
- Generator accessories and oils still stay out of core generator recommendations.
- Add classifier matrix tests across plate/generator/cutter/accessory/oil examples.

---

## Finding 3 — rejected product trace is now mixed with durable selection memory

**Severity:** P1

**Scope decision:** global state/diagnostics issue.

**Evidence:**

- `src/ai/assistant.ts:3691-3718` now builds `rejectedProducts` from both `comparisonProducts` and up to 80 non-matched `sourceProducts`.
- `src/ai/assistant.ts:2667-2669` stores `result.rejectedProducts` into selection-state update.
- `src/ai/needState.ts:252-255` merges and persists rejected products, keeping the last 32 unique records.
- `src/ai/assistant.ts:4309-4315` currently uses rejection reasons only for `comparisonProducts` in answer context, so many extra rejected records are state/debug noise rather than buyer-facing explanation.

**Problem:**

The rejected trace is useful for audits, but the current expansion can persist broad catalogue rejection noise into the conversation state. That makes state heavier and can create stale negative memory across turns. A buyer who later switches to accessories/consumables may be affected by previously persisted “rejected” accessory ids/reasons from a whole-machine turn.

**Why this is broader than a point fix:**

Any full-catalog selection for any class can produce many rejected products. This is a state contract problem: diagnostic traces and durable buyer memory are different data classes and should not be merged blindly.

**Fix direction:**

Split rejection data into two layers:

1. `selectionState.rejectedProducts`: durable, only explicit comparison/current-selection rejects that matter across turns.
2. `selectionDiagnostics.rejectedCandidates`: non-durable, sampled diagnostic evidence for audit/logging/test assertions.

Sampling rules:

- Keep at most N per reason and N total.
- Prefer near-miss products and explicitly retrieved/base candidates over arbitrary full-catalog rows.
- Do not persist full-catalog rejects to `needState`.

**Acceptance criteria:**

- Existing vibroplate test can still assert that filter/belt were excluded, but through diagnostic rejection trace, not durable conversation memory.
- `needState.selectionState.rejectedProducts` does not accumulate unrelated full-catalog rejects after a recommendation turn.
- Follow-up asking for an accessory is not biased by previous core-product rejection noise.

---

## Finding 4 — test coverage proves the latest case but not the broader contract

**Severity:** P2

**Scope decision:** global test-gap issue.

**Evidence:**

- New tests cover:
  - whole vibroplate request excludes filter/belt;
  - invalid planner fallback is text-only.
- Existing tests cover several accessory/oil cases, but there is no direct test for:
  - core machine with ambiguous words like `комплект`;
  - planner-context retrieval not being narrowed before LLM plan;
  - durable rejected-products state staying clean;
  - a buyer switching from core machine need to accessory need after a previous rejection trace.

**Problem:**

The current tests are green, but they do not catch the newly observed false negative for a core plate `комплект`, nor the architectural retrieval/state issues. Without those tests, future “fixes” can again replace one trigger-word defect with another trigger-word defect.

**Fix direction:**

Add contract-level regression tests before code changes:

- `productClassifier` matrix tests for core vs accessory role evidence.
- `selectProductsForTurn` tests where core products contain ambiguous accessory-like words but stay core.
- State persistence tests proving full-catalog diagnostics do not enter durable `rejectedProducts`.
- Planner-context retrieval test or hook-level test proving preliminary context is broad/labeled and not hard-filtered by raw text intent.

---

# Implementation plan

## Task 1: Add classifier matrix regression tests

**Objective:** Freeze the core/accessory role contract before changing classifier logic.

**Files:**

- Modify: `tests/recommendationRanking.test.ts` or create focused `tests/productClassifier.test.ts`.
- Read/modify only as needed: `src/ai/productClassifier.ts`.

**Steps:**

1. Add tests for core products with ambiguous words:
   - `Виброплита бензиновая ТСС VP80 комплект` in `Виброплиты` => core plate.
   - `Генератор бензиновый ТСС комплект` in `Генераторы` => core generator.
2. Add tests for accessory/spare products:
   - `Фильтр воздушный для виброплиты` in `Запчасти для виброплит` => not core.
   - `Ремень привода виброплиты` in `Расходники и запчасти для виброплит` => not core.
   - `Комплект сервиса K 770` in `Расходники` => accessory/non-core.
3. Run targeted test and verify the new core `комплект` case fails before implementation.

Expected initial status: at least the plate `комплект` case fails with current code.

## Task 2: Replace flat spare/accessory blacklist with evidence scoring

**Objective:** Fix product role classification globally without adding another brittle trigger patch.

**Files:**

- Modify: `src/ai/productClassifier.ts`.
- Test: classifier tests from Task 1.

**Steps:**

1. Introduce helper functions:
   - `hasAccessoryCategorySignal(category)`;
   - `hasCoreMachineCategorySignal(category, class)`;
   - `hasAccessoryTitleForm(classText)` for title starts or `noun for machine` form;
   - optionally `tokenIncludes` / regex word-boundary matching.
2. Replace `isGenericAccessoryProduct = containsAny(classText, spareAccessoryTerms) || containsAny(category, spareAccessoryTerms)` with a role-evidence decision.
3. Make ambiguous terms (`комплект`, `бак`, `крышка`, `АВР`) weak evidence only; they must not demote core products alone.
4. Keep strong accessory outcomes for actual spare/accessory categories and titles.
5. Run targeted tests.

Expected final status: classifier matrix passes and current vibroplate filter/belt regression still passes.

## Task 3: Split planner-context retrieval from post-plan selection retrieval

**Objective:** Prevent pre-LLM keyword profile from biasing the LLM planner.

**Files:**

- Modify: `src/ai/assistant.ts`.
- Potential helper extraction in same file or new `src/ai/retrieval.ts` if warranted.
- Test: `tests/recommendationRanking.test.ts` or dedicated assistant retrieval test.

**Steps:**

1. Add `findPlannerContextProducts(...)` or equivalent path used before `planAssistantTurn`.
2. This function should:
   - use raw text/vector/exact-model retrieval;
   - label core/accessory candidates when possible;
   - avoid hard filtering by `inferProductIntent`/`productFitPenalty` from raw user text.
3. Keep strict `findProducts(...)` or equivalent for after-plan selection using LLM traits.
4. In `generateAnswer`, replace preliminary call at `assistant.ts:3957-3959` with planner-context retrieval.
5. Add tests that a broad query with whole-product + accessory terms still gives planner context containing core machines and accessories, not accessories only.

Expected final status: planner receives less biased context; final selection behavior remains governed by LLM plan.

## Task 4: Separate durable rejected memory from diagnostic rejection trace

**Objective:** Keep audit evidence without polluting conversation state.

**Files:**

- Modify: `src/ai/assistantTypes.ts` if a new diagnostics field is needed.
- Modify: `src/ai/assistant.ts` around selection result construction.
- Modify: `src/ai/needState.ts` only if state schema needs explicit durable-vs-diagnostic separation.
- Tests: `tests/recommendationRanking.test.ts`, possibly `tests/needState.test.ts`.

**Steps:**

1. Define durable rejects: only comparison/current-selection products or explicit user-rejected products.
2. Define diagnostic rejects: sampled full-catalog/source-product exclusions.
3. Stop writing diagnostic rejects into `selectionState.rejectedProducts`.
4. Keep diagnostic rejects available in `selectionResult.trace` or new non-durable field for tests/logging.
5. Update the vibroplate test to assert filter/belt exclusion through diagnostics if they are not comparison products.
6. Add a state test proving durable rejected products do not grow with unrelated full-catalog rejects.

Expected final status: state remains small/meaningful; audit diagnostics remain available.

## Task 5: Run verification bundle and save final report

**Objective:** Prove the broader fix did not regress current behavior.

**Commands:**

- `npm test -- --run tests/recommendationRanking.test.ts tests/needState.test.ts tests/turnContract.test.ts`
- `npm run build`
- `npm test -- --run`

**Report:**

Save a follow-up report in `docs/plans/` with:

- exact files changed;
- findings fixed;
- tests run and pass/fail status;
- explicit status for local vs live/Railway verification.

---

## Current recommendation

Fixing should be done globally, not as another local vibroplate patch.

Priority order:

1. P1 classifier evidence scoring, because current code can hide a valid core product (`комплект`) from recommendations.
2. P1 rejected-trace/state split, because current code risks durable state pollution across turns.
3. P1 preliminary planner-context retrieval split, because it is the remaining architectural path where keyword heuristics can bias the LLM before planning.
4. P2 broader tests to prevent recurrence.
