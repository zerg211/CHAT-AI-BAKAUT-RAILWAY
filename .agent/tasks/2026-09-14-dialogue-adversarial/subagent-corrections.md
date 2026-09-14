# Adversarial corrections

Date: 2026-09-14. Branch: `codex/dialogue-adversarial-correctness`.

## Corrections applied

1. **Exact numeric evidence match**
   - Changed numeric verification from substring search to equality over canonical numeric tokens.
   - Evidence containing `184` can no longer prove the claim `84`.
   - After adversarial challenge, integer tokens preserve leading zeroes and arbitrary precision; decimal separators/trailing zeroes are normalized as text without `Number` conversion.
   - Test: `matches complete numeric tokens rather than substrings`.

2. **Strict product scope**
   - A product-scoped evidence item now requires a non-null, exact normalized product name in `factsUsed`.
   - A missing product name and a related variant such as `Fubag BS 8000 A ES` can no longer bind evidence for `Fubag BS 8000`.
   - This is deterministic identity enforcement; the writer can and should copy the item product name.
   - Test: `does not let a null or related-model name bypass product scope`.

3. **Validated web evidence only**
   - Web facts are exposed as claim evidence only when `evidenceVerifiedExact=true`; merged catalog facts remain eligible through `sourceType=catalog`.
   - Confirmed web coverage without exact verification is excluded. Unconfirmed coverage remains available for an honest `source_label`/gap statement.
   - This closes a direct bypass where an unverified fact was unconditionally promoted to `confirmed`.
   - Test: `excludes unverified web facts...`.
   - After adversarial challenge, a numeric `source_label` from non-confirmed coverage also requires `evidenceVerifiedExact=true`; model-generated gap prose cannot become numeric evidence.

4. **First-party page text cannot prove a semantic confirmed value**
   - Raw `site.readFirstPartyPage` text is split into bounded addressable chunks.
   - A `page_text` item may support `source_label`, but cannot support `confirmed_value`: a number somewhere on a page does not establish that it is net weight, operating noise, or another inferred attribute.
   - Product scope uses `payload.productIdentity.title` first and `payload.title` only as a legacy fallback.
   - Test covers the `93.5 kg` label as source wording while rejecting it as a confirmed net value.

5. **Writer evidence ordering and bounds**
   - Added `answerEvidenceItemsForModel`.
   - Validated research items precede site/generic/catalog items, so a large catalog result cannot evict the decisive web evidence from the 160-item prompt budget.
   - Prompt previews are bounded to 320 characters for value and 640 for evidence; validation still uses the full bounded evidence units.
   - Test: `prioritizes validated research and bounds writer evidence previews`.

6. **Latest valid assistant controls contact panel**
   - `sending` and `error` placeholders no longer revoke the previous valid assistant authorization.
   - Only the latest assistant message with status `done` or legacy persisted status absent controls visibility.
   - Tests cover sending/error placeholders.

7. **AC6 false-positive guard**
   - The unchanged-load calculator rejection now applies only when the current structured decision does not request catalog selection evidence.
   - Argument: an unchanged load still must be recalculated when the buyer requests a new selection/fit decision because current catalog/card eligibility needs a current calculator payload. The original condition rejected that legitimate case solely because the task remained `technical_answer + answer`.
   - Evidence-only technical follow-ups without catalog requirement/request are still rejected.
   - Tests cover both sides.

8. **Required research completion semantics (revised after challenge)**
   - Added `requiredToolResultSatisfied`.
   - Final opinion: `partial` is not successful completion; `exhausted` with a completed search is a successfully executed required tool whose missing fact belongs in `unresolvedFacts`, not `toolFailures`.
   - Reason: `policyGate.requiredActions` tracks tool kinds, so marking an exhausted search as `required:web.researchProductFacts` would falsely report an execution failure to the seller.
   - Test distinguishes `answered=true`, `partial=false`, `exhausted=true`.

## Verification

- `npx vitest run tests/answerEvidenceBindings.test.ts tests/widgetDiagnostics.test.ts tests/taskOutcome.test.ts tests/agentManagerSemanticDecision.test.ts tests/agentManagerComparisonResearch.test.ts tests/manufacturerDomainRegistry.test.ts`
  - PASS: 6 files, 139 tests.
- After the final first-party-title correction:
  - `npx vitest run tests/answerEvidenceBindings.test.ts tests/widgetDiagnostics.test.ts tests/taskOutcome.test.ts tests/agentManagerSemanticDecision.test.ts`
  - PASS: 4 files, 75 tests.
- `npm run typecheck`
  - PASS.
- `git diff --check`
  - PASS; only Git CRLF conversion warnings.

## Remaining objections / risks

- The deterministic binding validator validates structured `factsUsed`; it does not prove that every numeric token in free-form `answerText` has a corresponding fact. The existing semantic factual reviewer remains the coverage for omitted claims. A complete deterministic answer-text-to-fact bijection needs a separate claim extraction contract and is outside this patch.
- First-party raw page evidence is capped at 20 chunks (18,000 characters). Facts outside the read window require the existing continuation read flow.
- Admin warning totals may count the same warning at multiple metadata levels. This is an observability count issue, not a correctness or authorization bypass.
- AC6 depends on the planner setting `catalogRequirement` or issuing a catalog request for a new selection. If the planner semantically misclassifies a selection as a pure technical answer, repair can still remove the calculator. A future explicit structured `selectionDecisionRequested` field would remove that ambiguity.
