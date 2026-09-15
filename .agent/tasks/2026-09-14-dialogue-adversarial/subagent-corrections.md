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

## Post-deployment dispute: final-answer reserve

The first production dialogue after PR #26 failed because successful web research and an optional observation/read round consumed the writer deadline. Root initially proposed protecting 60 seconds before web and observation. The critic objected that continuation reads also needed the same execution-time reserve and that exactly 60 seconds covered only the nominal 45-second writer plus 15-second review, leaving no checkpoint/evidence overhead. Root accepted the execution-time requirement but challenged an early per-request millisecond allowance as meaningless.

The critic's final position prevailed and was implemented:

- one 65-second finalization reserve: 45 seconds writer, 15 seconds review, 5 seconds operational margin;
- a continuation round is admitted only with a further fixed 10 seconds of useful execution time;
- every continuation read recalculates its timeout against the 65-second downstream reserve;
- initial FAST/NORMAL catalog work retains the old 8-second answer reserve until semantic research expands the turn profile.

The critic re-read the final diff, repeated the focused tests, and returned PASS. The root focused run passed 205/205; typecheck also passed.

## Second post-deployment dispute: calculator aggregate evidence

The second production attempt proved that the finalization reserve worked, but review rejected the writer's `totalRunningKw=2.9` fact because it referenced three `runningKw` component items. Root first implemented a special-case sum of those components. The critic rejected that approach with a concrete counterexample: calculator totals may apply `count`, strongest-scenario selection, operation mode, simultaneous-running groups and rounding, so a validator sum can disagree with the calculator or pass coincidentally.

The critic's final opinion prevailed:

- never reimplement calculator aggregation in the evidence validator;
- accept the remap only for a null-product, confirmed `totalRunningKw` fact with exactly one successful `calculator.generatorLoad` source and only distinct `runningKw` component IDs from that request;
- bind one evidence item, `payload.profile.totalRunningKw`, after exact numeric equality with the fact;
- preserve ordinary fail-closed validation when any condition is absent;
- enumerate `payload.profile` before `payload.loads` so the canonical item cannot be displaced by the per-tool evidence cap;
- admit answer repair only above 47 seconds, preserving 30 seconds for writer, 12 for re-review and 5 for operational work.

Tests cover the exact production draft, a counted/scenario case where naive summation is wrong, malformed bindings, the evidence cap and the 47,000/47,001 millisecond repair boundary.

## Third post-deployment dispute: durable memory evidence

Production dialogue #2188 completed its first turn, then rejected a useful second-turn draft because A-iPower facts loaded from memory had no addressable exact evidence. The critic also identified a nonnumeric bypass: `a_ipower_fuel=бензиновый` had no item ID and escaped the numeric-only missing-binding guard.

Root first proposed remapping matching memory-derived tool sources directly to `verified_fact:<id>`. The critic objected that old SQL/legacy rows do not prove exact excerpts; in the failed payload, some evidence fields contained only a URL. Root accepted a durable database marker but challenged whether coverage needed its own row ID and whether the tool source should be rewritten. Final agreement: the fact projection carries `verifiedFactId`; coverage carries only the exact marker; the source remains the truthful current `web.researchProductFacts` memory-hit tool.

After the first implementation, the critic found that production projects a stored row into both `facts` and `coverage`, making a simple unique match ambiguous. The critic initially preferred any durable candidate. Root objected that this could silently ignore a separate fresh exact fact. The critic narrowed the correction: ignore only a coverage item proven to duplicate the durable fact by request, product, canonical attribute, normalized value, evidence, status and exact marker. A second durable row or a fresh independent exact fact remains ambiguous and fail-closed.

Root also challenged the repository-wide rejection of new web/manual rows without `evidenceVerifiedExact=true`. The critic checked every runtime caller: exact research persistence is the only producer, both direct and queued paths carry `true`, and the worker separately enforces it. SQL legacy rows receive the migration default `false`, remain URL candidates, and cannot supply confirmed values. The repository guard therefore prevents a future unvalidated caller from replacing evidence or refreshing the TTL of an exact row. This is the final shared opinion.

Final verification: root focused 285/285 and final direct 40/40 PASS; critic focused 285/285, direct 27/27, typecheck, no-new-regex and build PASS. The isolated long generated-state file passed 24/24. Real PostgreSQL integration was not run because no isolated test database was configured.
