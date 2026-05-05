# Final cards authority and Live UI remediation plan

Date: 2026-05-05
Repo: `C:\Projects\chatAI`
Status: EXECUTED_WITH_FOLLOW_UP_FINDINGS

## Execution update 2026-05-05

Implemented:

- `FinalCardsDecision` is built before answer generation and drives answer context, visible/hidden metadata, and rendered cards.
- `enforceAnswerCardContract(...)` no longer mutates cards after the answer; it only returns diagnostics.
- `repairAnswerForFinalCards(...)` repairs answer text or fails closed without adding/reordering cards.
- `previousSelectionOnly` now preserves selected final cards instead of dropping them because of fresh optional traits.
- `deterministicLeadCollectionAnswer(...)` now handles contact context instead of repeating a generic handoff when the buyer already provided a phone/email and asks whether the form is still needed.

Verified:

- Unit/regression tests passed for recommendation ranking and turn contract after fixes.
- Full Live UI exploratory run completed through the widget with PostgreSQL running.
- Focused post-fix Live UI run confirmed the two live-found fixes.
- Full protocol: `local-live-tests/2026-05-05-final-cards-live-ui.local.md`.

Follow-up findings left open:

- Initial vibroplate selection can over-broaden to heavy industrial reversible plates before the buyer gives explicit weight/width.
- Final generator pair can still choose models above the stated budget even though cards now remain visible.
- Long technical/service answers need a chat-friendly length/format cap.
- Hidden slice wording like "50 suitable models" is too prominent in final-choice turns.

## Why this plan exists

The LLM-first plan fixed several hidden keyword/selection routes, but one P0 architecture risk remains:

`enforceAnswerCardContract(...)` can still change/reorder visible product cards after the answer text has already been generated.

That is backwards for an AI sales manager. The buyer sees one turn, so the turn needs one authoritative decision:

`need/history -> LLM turn plan -> selection decision -> final cards -> answer grounded on final cards -> metadata/persistence`

The system must not do:

`answer text -> detect mentioned product -> mutate cards -> metadata`

Also, the last Live UI verification was blocked because local PostgreSQL was not running. Future behavior work is not complete until local Live UI is actually executed through the widget and saved.

## Problems to fix

### P0-1. Post-answer card mutation still exists

Current risk:

- `enforceAnswerCardContract(...)` can add/reorder cards based on products mentioned in the generated answer.
- This makes the LLM answer indirectly authoritative over UI cards after the final selection phase.
- It can create drift: answer, cards, metadata, and durable selection state may not describe the same decision.

Target behavior:

- Final cards are fixed before answer generation.
- Answer context contains exactly the final cards.
- After answer generation, code may only repair text, retry answer generation, or fail closed.
- Post-answer code must never add/reorder visible cards.

### P0-2. Metadata can still be derived after card mutation

Current risk:

- `finalSelectionMetadata` is computed after `enforceAnswerCardContract(...)`.
- If cards were mutated by answer text, metadata can silently follow the mutation instead of the original selection decision.

Target behavior:

- Metadata uses the same `finalCards` used to build answer context.
- `visibleProductIds`, `hiddenProductIds`, and answer grounding are one object, not rebuilt from later mutable arrays.

### P0-3. Live UI verification is not a reliable gate yet

Current blocker:

- `npm run dev` starts Vite, but API migration fails if PostgreSQL is unavailable:
  - `connect ECONNREFUSED ::1:5432`
  - `connect ECONNREFUSED 127.0.0.1:5432`
- `docker compose ps` currently fails because Docker Desktop daemon is not running:
  - `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`

Target behavior:

- Live UI verification starts from a clean infrastructure preflight.
- If PostgreSQL cannot be started, the task is blocked and not marked done.
- Passing unit tests without Live UI is not enough for behavior changes.

## Implementation plan

### Stage 1. Add failing tests for post-answer card immutability

Files:

- Modify: `tests/recommendationRanking.test.ts`
- Possibly create: `tests/authoritativeCards.test.ts`

Tests:

1. Given final cards `[A, B]`, answer mentions valid product `C` from broader candidates.
   - Expected: post-answer contract reports violation diagnostics but returns cards `[A, B]`.
   - No `addedCardIds`.
2. Given final cards `[A, B]`, answer mentions `B` first.
   - Expected: cards remain `[A, B]`; text repair may add/adjust first-card wording.
3. Given text-only plan, answer mentions a product.
   - Expected: no cards are added.
4. Given lead/previousSelection flow, answer cannot reopen broad alternatives.

Expected initial status:

- At least the non-authoritative `C` mention case should fail with current code.

### Stage 2. Split card-contract detection from mutation

Files:

- Modify: `src/ai/assistant.ts`

Replace `enforceAnswerCardContract(...)` with two explicit concepts:

1. `detectAnswerCardContractViolation(answer, finalCards, candidateProducts, plan)`
   - Detects mentioned products outside final cards.
   - Detects first-card mismatch.
   - Returns diagnostics only.
2. `repairAnswerForFinalCards(answer, finalCards, diagnostics, plan)`
   - Changes text only.
   - May remove/soften non-final product mentions.
   - May prepend a first-card grounding sentence.

Forbidden:

- No post-answer `productCards(...)` call.
- No post-answer `mergeProductsById(...)` to build new cards.
- No answer-driven `addedCardIds` behavior.

### Stage 3. Introduce a final cards object before answer generation

Files:

- Modify: `src/ai/assistant.ts`
- Optional if useful: create `src/ai/finalCards.ts`

Create a small internal object, not a big refactor:

```ts
type FinalCardsDecision = {
  visibleProducts: Product[];
  hiddenProducts: Product[];
  cards: ProductCard[];
  visibleProductIds: string[];
  hiddenProductIds: string[];
  source: 'selection' | 'turnContract' | 'leadSelection' | 'textOnly';
};
```

Rules:

- Build this before answer context.
- `answerContextProductsForCards(...)`, `cards`, and `finalSelectionMetadata` all read from it.
- If answer violates it, repair text or retry, but keep `FinalCardsDecision` unchanged.

### Stage 4. Add retry/fail-closed behavior

Files:

- Modify: `src/ai/assistant.ts`

Rules:

- If answer mentions product outside final cards:
  - First attempt: text repair.
  - If still violated and this is product recommendation: one retry with strict final-card-only instruction.
  - If still violated: fail closed with a concise answer grounded only in final cards.
- Text-only plans remain text-only.

### Stage 5. Verification tests

Run:

```powershell
npm test -- --run tests/recommendationRanking.test.ts tests/turnContract.test.ts tests/prompts.test.ts
npm test -- --run
npm run typecheck
npm run build
git diff --check
```

All must pass before Live UI.

## Mandatory Live UI plan

### Stage 6. Local infrastructure preflight

Do not start `npm run dev` until PostgreSQL is ready.

Commands:

```powershell
docker compose ps
docker compose up -d postgres
docker inspect -f "{{.State.Health.Status}}" chat_ai_postgres
npm run migrate
```

If Docker daemon is not running:

1. Start Docker Desktop manually or with `Start-Process` if installed.
2. Re-run `docker compose ps`.
3. If Docker is unavailable, do not mark Live UI done. Record blocker with exact error.

Health checks:

```powershell
npm run dev
Invoke-WebRequest http://127.0.0.1:3010/api/health
Invoke-WebRequest http://127.0.0.1:5173/
```

Expected:

- API health returns OK.
- UI loads.
- No lingering duplicate servers on `3010`/`5173`.

### Stage 7. Live UI scenario rules

The live check must be through the widget UI, not only API/unit tests.

Rules:

- Start with scenario goals, not a fixed script.
- After every buyer turn, read the actual assistant answer and visible cards before writing the next buyer turn.
- If the assistant asks a clarification, answer that clarification.
- If the assistant makes a mistake, the next buyer turn should naturally object or clarify.
- Save full transcript and screenshots/JSON under `local-live-tests/`.
- A blocked infrastructure run is not a pass.
- The live run must also include exploratory bug hunting, not only confirmation of known fixes.

### Stage 7.1. Code-grounded exploratory bug hunting

Before running Live UI, inspect the changed and adjacent code paths and write 3-6 concrete hypotheses about where the chat may still behave badly.

Hypotheses must be grounded in code, not guessed from documents. Look especially at:

- post-answer text/card contract code;
- turn plan normalization and `turnContract`;
- `purchasePlanIfNeeded(...)` and lead handoff overrides;
- `explicitCriteriaFromTurn(...)` and regex-derived constraints;
- previous-selection vs broaden-alternatives handling;
- text-only factual/service flows;
- memory persistence in `selectionState`;
- web-search forcing and timeout-prone paths.

For each hypothesis, define:

- what code path may cause the issue;
- what bad user-visible behavior would appear;
- which natural buyer turn can test it inside the same dialogue;
- what evidence counts as pass/fail.

During the same Live UI dialogue that checks fresh fixes, deliberately steer the buyer naturally into these risk areas. This should not be a random stress test or a scripted checklist detached from the assistant's actual answers. Each probe must follow from what the assistant just said, or from a reasonable buyer objection/question.

Examples of exploratory probes:

- If assistant shows two cards, ask about "the first one" and verify it does not silently switch the referenced product.
- If assistant answers text-only service/technical content, ask a follow-up that mentions a product and verify cards are not injected unexpectedly.
- If assistant offers a lead handoff, ask a technical clarification first and verify it can return to consultation instead of forcing contact collection.
- If assistant uses inferred generator load, challenge a non-simultaneous load and verify it does not inflate to an excessive kW class.
- If assistant has rejected accessories during a core-product turn, later ask for the accessory and verify memory is not poisoned.

The final live report must include a section:

```text
## Exploratory hypotheses checked

1. Hypothesis:
   Code path:
   Probe turn:
   Observed behavior:
   Status: PASS/FAIL
```

If a new defect is found, do not hide it behind an overall GREEN result. Mark the known-fix checks separately from exploratory findings and create a follow-up fix plan or implement the fix if it is in scope.

### Stage 8. Required Live UI scenarios

#### Scenario A: fixed LLM-first classifier/retrieval bugs

Goal:

- Verify the recent fixes.

Buyer start:

- Ask for a whole vibroplate and mention related spare/accessory words such as `ремень`, `комплект`, or `фильтр`.

Expected:

- Assistant does not collapse to accessory-only selection.
- Core vibroplate remains available as core equipment.
- If accessories are relevant, they are treated as separate accessory context.
- Text and first card agree.

Follow-up:

- Ask for the related accessory after the whole-product answer.

Expected:

- Previous diagnostic rejects do not poison memory.
- Assistant can switch to accessory need naturally.

#### Scenario B: final cards authority

Goal:

- Verify the new P0 fix.

Flow:

1. Ask for one main option and one backup.
2. Verify exactly those visible cards are discussed.
3. Ask: `Из этих двух какой брать первым?`
4. Then ask: `А есть дешевле при тех же требованиях?`

Expected:

- Step 2: prose and cards both show the same final pair.
- Step 3: assistant does not reopen the catalog.
- Step 4: assistant may broaden intentionally because buyer asked for cheaper alternatives.
- No answer-driven card expansion.

#### Scenario C: text-only technical/service question

Goal:

- Verify deterministic card forcing no longer overrides planner text-only intent.

Buyer asks:

- Service/ownership-cost comparison for concrete models or consumables.

Expected:

- No product cards unless buyer asks to buy/select a product.
- Answer gives practical technical/commercial comparison.
- No automatic handoff unless exact availability/delivery/discount/order is asked.

#### Scenario D: business handoff boundary

Goal:

- Verify commercial constraints.

Buyer asks after selection:

- availability, delivery cost/date, discount, or asks to order.

Expected:

- Assistant does not promise exact stock/delivery/discount.
- Assistant asks for name/phone or opens lead flow.
- It summarizes selected items only, not broad alternatives.

### Stage 9. Live pass/fail criteria

Live UI is GREEN only if:

- Full UI dialogue completed.
- Every next buyer turn was based on the actual visible assistant answer.
- Transcript saved in `local-live-tests/*.local.md`.
- JSON/screenshot artifacts saved when using Playwright.
- No console/page errors.
- No stuck busy text.
- Text, cards, and metadata are aligned for product recommendation turns.
- Text-only turns stay text-only.
- Lead handoff does not claim an order/lead already exists.

## Deliverables

After implementation:

1. Code changes for final-card immutability.
2. Regression tests.
3. Updated report in `docs/plans/`.
4. Live UI protocol in `local-live-tests/*.local.md`.
5. If PostgreSQL/Docker blocks the run, record it as BLOCKED, fix infrastructure, and rerun. Do not close the task on a blocked Live UI attempt.
