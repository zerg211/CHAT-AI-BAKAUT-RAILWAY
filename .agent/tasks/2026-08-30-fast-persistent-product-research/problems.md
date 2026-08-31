# Verification Problems

## Pass 1

- Verdict: FAIL
- Command: `npm run verify`
- Failure: `tests/productComparisonResearch.test.ts` still expected the previous environment-derived `{ effort: 'none' }` for the full catalog extractor after research calls were intentionally moved to the bounded `{ effort: 'low' }` profile.
- Scope: one stale deterministic assertion; implementation, 909 other tests, typecheck, no-regex guard, dependency audit, agentic suite, and production build passed.
- Fix: update both stale catalog and web request assertions to the frozen task's low-latency research profile, rerun the focused test, then rerun the complete release gate.

## Fresh Verifier 1

- Verdict: FAIL (`AC1`, `AC4`, `AC5`, `AC6`, `AC7`, `AC9`, `AC10`). `AC11` remains pending authorization.
- High: source-tier order and early cancellation were delegated to one hosted web-search response instead of deterministic tier orchestration.
- High: a generic brand-like domain could be promoted to manufacturer without trusted provenance.
- High: the customer vocabulary guard did not cover every explicitly prohibited process term.
- Medium: multi-target persistence could bind an absent model's fact to another selected product.
- Medium: partial memory gaps were represented only by attribute, not exact product+attribute slot.
- Medium: tests did not prove source-tier concurrency/cancellation or verified-fact idempotency.
- Required fix: implement the smallest safe deterministic source staging, trusted authority classification, exact identity persistence, slot-level gaps, comprehensive process-language repair, and focused proof; then rerun release gate and a new fresh verifier.

## Release Gate After Fresh-Verifier Fixes

- Initial rerun: FAIL, 914/915 unit tests and 202/203 agentic tests passed; typecheck, build, dependency audit, and no-regex guard passed.
- Cause: one existing mocked answer still exposed `web-поиск завершился ошибкой`; the expanded last-mile guard correctly rejected it.
- Fix: changed only that test fixture to customer-facing unresolved-fact wording and retained the production guard.

## Fresh Verifier 2

- Verdict: FAIL (`AC1`, `AC4`, `AC5`, `AC6`, `AC7`, `AC8`, `AC10`); `AC11` pending authorization. All current local commands passed.
- High: a staged official attempt retained facts classified to another tier, allowing unsafe early cancellation.
- High: multi-target source validation could accept evidence for one requested model as a fact labeled with another requested model.
- High: persistence did not independently require title, same-product evidence binding, or absence of an unresolved product+attribute conflict.
- Medium: mixed catalog-bound/absent-target memory discarded valid name-only facts for the absent target.
- Medium: a resolved request without an actual web-search call was traced as completed rather than failed.
- Medium: regression coverage did not exercise these boundaries or repeated identical writes.

## Fresh Verifier 2 Remediation

- Isolated each staged attempt to facts and confirmed coverage classified to that attempt's actual tier, so secondary evidence cannot cancel or replace official/manual work.
- Bound source validation to each fact's exact product identity and propagated an exact-evidence verification marker into persistence policy.
- Required title, URL, tier, authority, exact product/value evidence, and no product+attribute conflict before persistence.
- Included safe name-only facts when a request mixes catalog-bound and absent exact targets.
- Reported a staged attempt without an actual web-search call as failed rather than completed.
- Moved semantic catalog extraction ahead of memory lookup in the orchestrator; complete catalog coverage now short-circuits both memory and web, while only exact catalog gaps proceed to memory.
- Added focused regressions for every boundary above and repeated identical writes.
- Current verification: focused 238/238 PASS; full release gate 918/918 unit and 203/203 agentic PASS; typecheck, no-regex, dependency audit, and build PASS. Fresh Verifier 3 pending.

## Fresh Verifier 3

- Verdict: FAIL (`AC4`, `AC5`, `AC6`, `AC9`, `AC10`); `AC11` pending authorization. All local commands passed.
- High: off-tier conflict objects were retained after off-tier facts were removed.
- High: multi-target persistence did not reject non-confirmed coverage when no explicit conflict object was present.
- High: absent/unknown-brand targets could not establish manufacturer authority outside the small deterministic domain allowlist.
- Medium: additional generic search/research execution phrases passed the customer output guard.
- Medium: focused tests did not exercise these boundaries or persistence count traces.

## Fresh Verifier 3 Remediation

- Tier conflicts now survive only when validated facts from the current tier prove the corresponding conflicting values; contradicted/ambiguous coverage follows the same isolated conflict set.
- Persistence rejects any fact attribute with non-confirmed coverage, including multi-target requests, and tests assert persistable/saved trace counts.
- Unknown official domains remain secondary by default. An official-stage source is promoted only when the semantic validator identifies manufacturer publisher ownership and returns an exact publisher excerpt that deterministic code finds in fetched source text; brand-like domains alone remain insufficient.
- Added generic English and Russian search/research execution phrases to the last-mile guard without blocking ordinary product use of `инструмент`.
- Current verification: focused 239/239 PASS; full release gate 919/919 unit and 203/203 agentic PASS; typecheck, no-regex, dependency audit, and build PASS. Fresh Verifier 4 pending.

## Fresh Verifier 4

- Verdict: FAIL (`AC4`, `AC9`, `AC10`); `AC11` pending authorization. All local commands passed.
- Medium: official work started concurrently but awaited page-first, so complete manual-first evidence could not cancel a slow product-page attempt.
- High: a finite substring guard still allowed paraphrased English/Russian descriptions of internal searching or failed checking.
- Required proof: manual-first cancellation and semantic process-disclosure review/repair.

## Fresh Verifier 4 Remediation

- Official page/manual execution now races for the first completed result. Complete exact evidence from either tier cancels and awaits the other branch; incomplete first results still merge deterministically in page/manual order before secondary fallback.
- Added a dedicated structured semantic customer-language reviewer to the production OpenAI model. It classifies process disclosure by meaning, triggers answer repair, and fails closed when review is unavailable; the substring guard remains defense in depth for explicit variants.
- Expanded the bounded model-call allowance from four to six for decision, answer, semantic review, and one reviewed repair while preserving the shared wall/provider budgets.
- A staged attempt can no longer retain a model-reported `confirmed` outcome after fact/conflict validation removes all support.
- Current verification: focused 241/241 PASS; full release gate 921/921 unit and 203/203 agentic PASS; typecheck, no-regex, dependency audit, and build PASS. Fresh Verifier 5 pending.

## Fresh Verifier 5

- Verdict: FAIL (`AC6`, `AC7`, `AC8`, `AC10`); `AC11` pending authorization. All existing local commands passed.
- High: merged coverage retained an earlier `not_confirmed` item beside a later exact confirmation, causing the persistence guard to reject the valid confirmed fact.
- High: verified-fact persistence did not independently reject research with failed, timed-out, or aborted execution disposition.
- Medium: generic research could retain a model-reported `confirmed` source attempt after validation rejected every supporting fact.
- Medium: focused proof did not directly cover outer retry deadline freshness, unavailable semantic-review fail-closed behavior, later confirmation persistence, or failed/timed-out persistence rejection.

## Fresh Verifier 5 Remediation

- Confirmed coverage now supersedes only `not_confirmed`/`not_found` coverage for the same attribute and product evidence; unresolved coverage for another compared model remains intact.
- Persistence now requires `usedWebSearch=true` and `searchDisposition=completed`; every skipped write emits a typed disposition and reason with zero persistable/saved counts.
- Each response's confirmed source attempts are reconciled with accepted facts before pass merging. Unsupported confirmations become `unreadable`, block source exhaustion, and emit `source_attempt_confirmation_rejected`.
- Retry validation no longer receives prior-pass attempts, preventing valid earlier attempts from being downgraded against a later response's fact set.
- Added regressions for same-model coverage precedence, generic rejected confirmations, timed-out persistence, fresh outer retry signal/deadline, and unavailable semantic review.
- Current verification: focused 242/242 PASS; full release gate 922/922 unit and 203/203 agentic PASS; typecheck, no-regex, dependency audit, and build PASS. Fresh Verifier 6 pending.

## Fresh Verifier 6

### AC6 - Per-product coverage and persistence safety

- Criterion: AC6. Every newly confirmed reusable product fact is persisted idempotently with complete provenance, while failed, ambiguous, contradicted, timed-out, and source-less claims are not persisted.
- Status: FAIL.
- Why it is not proven: `ProductComparisonResearchAnswerGuidance.coverage` has no typed `productName`. `uniqueCoverage()` treats a missing `sourceTitle` as enough to let any same-attribute confirmation suppress an earlier `not_confirmed`/`not_found` item, even when that item belongs to another compared product. If the other product's unresolved coverage is retained with a title, `persistVerifiedResearchFacts()` checks only the attribute and blocks the valid confirmed fact for the first product.
- Minimal reproduction: Research the same attribute for products A and B. Return a valid exact-source confirmed fact/coverage for A and `not_confirmed` coverage for B with `sourceTitle=null`; merging drops B's unresolved item at `src/ai/productComparisonResearch.ts:347-356`. Repeat with B named in `sourceTitle`; the item remains, but a valid fact for A is rejected by the attribute-only persistence check at `src/ai/agentManagerOrchestrator.ts:5485-5489`.
- Expected: A's later exact confirmation supersedes only unresolved A coverage, B remains explicitly unresolved, and A's reusable confirmed fact is persisted while B is not.
- Actual: B can be hidden, or B's retained unresolved item can prevent A's valid persistence.
- Affected files: `src/ai/productComparisonResearch.ts`, `src/ai/agentManagerOrchestrator.ts`, `tests/productComparisonResearch.test.ts`, `tests/agentManagerComparisonResearch.test.ts`.
- Smallest safe fix: Add exact typed `productName` to every coverage item and JSON schema, preserve it through catalog/web normalization and merging, and compare both exact product identity and canonical attribute in supersession and persistence guards. Add one two-product regression proving A persists while B remains unresolved.
- Corrective hint: Do not infer coverage ownership from nullable titles or evidence text. Make product identity part of the structured LLM result and keep deterministic code responsible for exact matching.

### AC9 - Semantic language review unavailable path

- Criterion: AC9. Buyer-facing text never discloses research execution, customer-language review/repair is enforced, and unresolved facts remain concrete.
- Status: FAIL.
- Why it is not proven: The semantic reviewer call fails closed when it throws, but `AgentManagerModel.reviewCustomerLanguage` is optional and `review()` silently skips the semantic boundary when the method is absent. The finite fragment guard does not catch all paraphrases, so an injected or replacement model can emit process language without any semantic decision.
- Minimal reproduction: Construct `AgentManagerOrchestrator` with an `AgentManagerModel` that omits `reviewCustomerLanguage` and composes `Я обращался к доступным источникам, но они не дали результата.` The deterministic fragment guard does not contain this paraphrase, the branch at `src/ai/agentManagerOrchestrator.ts:8237` is skipped, and no `customer_output_semantic_review_unavailable` issue is added.
- Expected: Absence, failure, timeout, or malformed output from the semantic reviewer blocks delivery after the bounded repair path.
- Actual: A missing reviewer method bypasses semantic review entirely.
- Affected files: `src/ai/agentManagerOrchestrator.ts`, `tests/agentManagerOrchestrator.test.ts`.
- Smallest safe fix: Make `reviewCustomerLanguage` required for the active model contract, or add an explicit high-severity unavailable issue in the `else` branch. Add a regression where the method is absent, not only one where it throws.
- Corrective hint: Keep the substring guard as defense in depth, but never use reviewer capability detection as permission to skip the semantic safety boundary.

### AC10 - Missing focused proof and failed fresh verification

- Criterion: AC10. Focused tests cover the specified research, persistence, retry, and customer-language boundaries, and a fresh verifier pass succeeds.
- Status: FAIL.
- Why it is not proven: The canonical 242-test focused command and the complete release gate pass, but neither suite exercises the two failing cases above. The later-confirmed test is single-product, the persistence test uses an unscoped ambiguous item, and the unavailable-review test covers a thrown method rather than an absent reviewer.
- Minimal reproduction: Run the canonical focused command and inspect `tests/productComparisonResearch.test.ts:3123-3200`, `tests/agentManagerComparisonResearch.test.ts:2232-2410`, and `tests/agentManagerOrchestrator.test.ts:7312-7579`; all pass without testing cross-product coverage ownership or missing reviewer capability.
- Expected: Focused regressions fail before the production fixes and pass after them; Fresh Verifier 6 reports PASS for AC1-AC10.
- Actual: Commands pass while AC6 and AC9 remain contradicted by current source.
- Affected files: `tests/productComparisonResearch.test.ts`, `tests/agentManagerComparisonResearch.test.ts`, `tests/agentManagerOrchestrator.test.ts`.
- Smallest safe fix: Add only the two boundary regressions described above after implementing the production fixes, then rerun the canonical focused command and `npm run verify`.
- Corrective hint: Preserve the existing exact-identity, evidence, conflict, source-exhaustion, tier-order, and strict completed-web persistence assertions while adding these cases.

## Fresh Verifier 6 Remediation

- Added required product ownership to research coverage and both structured JSON schemas. Exact-target coverage uses the typed target name; generic research uses `null` only when no product target exists.
- Normalization expands unscoped targeted coverage per exact target before evidence validation, so one model's confirmation cannot erase another model's unresolved status.
- Coverage merge and persistence now compare exact product identity plus canonical attribute. A regression proves product A persists while product B remains unresolved on the same attribute.
- Product-bound unresolved facts are carried into the tool result and writer clauses, preserving the exact customer-facing gap.
- Missing `reviewCustomerLanguage` capability now emits the same high-severity unavailable issue as a failed reviewer; the bounded repair is attempted and delivery remains blocked. Tests cover both thrown and absent reviewer paths.
- Test fixtures explicitly provide a safe semantic reviewer except where absence is the behavior under test; model-call assertions include the required review call.
- Current verification: focused 243/243 PASS; full release gate 923/923 unit and 203/203 agentic PASS; typecheck, no-regex, dependency audit, and build PASS. Fresh Verifier 7 pending.

## Fresh Verifier 7

### AC6 - Malformed targeted ownership and cross-product merge safety

- Criterion: AC6. Every newly confirmed reusable product fact is persisted idempotently with complete product/source provenance, while failed, timed-out, ambiguous, contradicted, and source-less claims are not persisted.
- Status: FAIL.
- Why it is not proven: Properly scoped A/B coverage now behaves correctly, but targeted coverage still permits an arbitrary non-null `productName`. `normalizeAnswerGuidance()` preserves it, `validateSourceBackedResult()` expands only null ownership, and non-confirmed coverage skips evidence validation. The persistence guard then ignores the malformed unresolved item when it does not match the fact product. In addition, `mergeVerifiedMemoryWithResearch()` omits `productName` from its coverage key, so same-shaped unresolved A/B items can collapse.
- Minimal reproduction: Request the same attribute for typed products A and B. Return a valid confirmed fact for A and `not_confirmed` coverage with `productName="UNKNOWN MODEL"`; it survives normalization but does not block A at `src/ai/agentManagerOrchestrator.ts:5487-5492`. Separately, merge unresolved A and B items with the same attribute/status/value/source URL through `mergeVerifiedMemoryWithResearch()`; only one map entry survives at `src/ai/agentManagerOrchestrator.ts:3251-3259`.
- Expected: Every targeted coverage item is canonicalized to an exact typed product, or malformed ownership fails closed for the affected typed slots; unresolved B remains visible, and only A's genuinely resolved fact persists.
- Actual: Unknown scoped ownership can bypass the product-scoped unresolved guard, and same-shaped cross-product coverage can lose one product during memory/research merging.
- Affected files: `src/ai/productComparisonResearch.ts`, `src/ai/agentManagerOrchestrator.ts`, `tests/productComparisonResearch.test.ts`, `tests/agentManagerComparisonResearch.test.ts`.
- Smallest safe fix: Canonicalize targeted coverage ownership against `targetProductNames`; turn unknown/malformed ownership into conservative typed unresolved slots rather than retaining it. Include canonical product identity in every coverage merge/dedup key and add one end-to-end multi-product normalization/merge regression.
- Corrective hint: Keep generic research nullable, but once exact targets exist, no coverage item may leave normalization with null or a non-target product identity. Persistence and writer grounding should consume only that canonicalized structure.

### AC9 - Exact unresolved product grounding

- Criterion: AC9. Buyer-facing text never exposes internal research execution and names concrete products, confirmed facts, and the exact unresolved customer fact; handoff requires proven source exhaustion.
- Status: FAIL.
- Why it is not proven: The semantic reviewer correctly fails closed when absent or throwing, reruns after repair, and blocks assistant saves. Valid coverage product identity reaches `unconfirmedFacts` and writer clauses. However, malformed targeted ownership is forwarded as the unknown name, while product-blind coverage merging can remove another product's unresolved item, so exact per-product writer grounding is not guaranteed.
- Minimal reproduction: Produce targeted unresolved coverage for products A/B where B is labeled `UNKNOWN MODEL`, or merge same-shaped unresolved A/B coverage before tool payload creation. Inspect `payload.unconfirmedFacts` at `src/ai/agentManagerOrchestrator.ts:7515-7523` and the writer clause at `src/ai/agentManagerOrchestrator.ts:3409-3414`; the requested B identity is wrong or absent.
- Expected: The writer always receives the exact typed requested product plus canonical unresolved attribute for every unresolved slot, while semantic review remains mandatory.
- Actual: Semantic review is mandatory, but malformed/product-collapsed coverage can still deprive it and the writer of exact unresolved product grounding.
- Affected files: `src/ai/productComparisonResearch.ts`, `src/ai/agentManagerOrchestrator.ts`, `tests/agentManagerComparisonResearch.test.ts`, `tests/agentManagerOrchestrator.test.ts`.
- Smallest safe fix: Enforce exact typed ownership before building the tool result and preserve product identity in all coverage merges; assert the resulting `unconfirmedFacts` and writer clauses in a two-product regression.
- Corrective hint: Do not infer ownership from evidence or nullable titles. Canonicalize against planner-typed targets deterministically and fail closed when ownership cannot be established.

### AC10 - Missing malformed/cross-product focused proof

- Criterion: AC10. Focused tests cover the specified research, persistence, retry, and customer-language boundaries, and a fresh verifier pass succeeds.
- Status: FAIL.
- Why it is not proven: The canonical 243-test focused command and full release gate pass, but the new A/B persistence test invokes persistence directly with already-correct coverage and only checks that its local input array still contains B. No test drives an unknown non-null targeted owner or same-shaped A/B coverage through normalization, memory/research merging, `unconfirmedFacts`, and writer grounding.
- Minimal reproduction: Run the canonical focused command, then inspect `tests/agentManagerComparisonResearch.test.ts:2415-2480`; it bypasses the failing normalization and merge boundaries. Search the focused files for malformed/unknown targeted coverage ownership; no regression exists.
- Expected: Focused regressions prove malformed/unscoped targeted coverage fails safe, A confirmation supersedes only unresolved A, B remains visible through final writer grounding, and A persistence is isolated from B.
- Actual: Existing commands pass while the current source still permits malformed ownership and product-blind coverage deduplication.
- Affected files: `tests/productComparisonResearch.test.ts`, `tests/agentManagerComparisonResearch.test.ts`, `src/ai/productComparisonResearch.ts`, `src/ai/agentManagerOrchestrator.ts`.
- Smallest safe fix: Add focused tests for unknown non-null ownership and a complete two-product merge-to-writer path after the production fix, preserving all existing exact identity, evidence, source-tier, source-exhaustion, and persistence-disposition assertions.
- Corrective hint: The regression must exercise the public research/orchestrator path, not only call `persistVerifiedResearchFacts()` with pre-normalized data.

## Fresh Verifier 7 Remediation

- Targeted coverage ownership is now canonicalized against the typed exact target list. Unknown, null in a multi-target request, or ambiguously matching ownership is replaced by conservative `not_confirmed` slots for every typed target and emits `source_coverage_target_mismatch`.
- `source_coverage_target_mismatch` blocks source exhaustion, so malformed model output cannot authorize handoff or verified-fact persistence.
- `mergeVerifiedMemoryWithResearch()` now deduplicates with product identity and applies confirmed-over-unresolved precedence only within the same product+attribute slot.
- Added a public research regression for unknown non-null ownership and an orchestrator-level two-product partial-memory flow proving A's confirmed memory fact, B's unresolved coverage, B's `unconfirmedFacts`, and B's writer clause all survive merging.
- Current verification: focused 245/245 PASS; full release gate 925/925 unit and 203/203 agentic PASS; typecheck, no-regex, dependency audit, and build PASS. Fresh Verifier 8 pending.

## Fresh Verifier 8

### AC7 - Canonical same-product coverage precedence

- Criterion: AC7. A later turn retrieves matching persisted facts before web research, skips external lookup when memory fully covers the requested product/attributes, and researches only partial-memory gaps.
- Status: FAIL.
- Why it is not proven: Memory matching uses exact-model equivalence, but `mergeVerifiedMemoryWithResearch()` keys confirmed precedence by the entire compacted `productName`. An alias-equivalent persisted name such as `SUNREKA G7000iS generator 6 kW` matches typed target `SUNREKA G7000iS` during retrieval, yet receives a different merge slot from catalog coverage. The earlier `not_confirmed` item therefore survives beside the full memory confirmation.
- Minimal reproduction: Use typed target `SUNREKA G7000iS`, catalog coverage `{ productName: "SUNREKA G7000iS", attribute: "nominal power", status: "not_confirmed" }`, and a reusable memory fact whose product name is `SUNREKA G7000iS generator 6 kW`. `textMatchesTargetName` accepts the names bidirectionally, while the merge keys at `src/ai/agentManagerOrchestrator.ts:3261-3270` are `sunrekag7000is|nominalpower` and `sunrekag7000isgenerator6kw|nominalpower`.
- Expected vs actual: Expected the memory confirmation to supersede unresolved coverage for the same exact product+attribute slot. Actual merged coverage retains both statuses even though memory is treated as fully covering the request.
- Affected files: `src/ai/agentManagerOrchestrator.ts`, `src/ai/verifiedFactMemory.ts`, `tests/agentManagerComparisonResearch.test.ts`.
- Smallest safe fix: Canonicalize merged coverage ownership against the current typed targets, or compare product slots with bidirectional exact-model equivalence plus canonical attribute equality instead of full display-string equality. Preserve distinct model codes and keep ambiguous ownership fail closed.
- Corrective hint: Reuse the exact target identity boundary already used by memory lookup and targeted research. Add an alias-equivalent catalog/memory/research regression that proves one confirmation suppresses only the same exact model's unresolved item.

### AC9 - False unresolved fact can reach the writer

- Criterion: AC9. Buyer-facing text names concrete confirmed facts and only the exact genuinely unresolved customer fact, without process disclosure; handoff remains blocked until source exhaustion.
- Status: FAIL.
- Why it is not proven: The semantic reviewer and process-language repair are fail closed, but the alias-equivalent merge defect leaves a stale non-confirmed coverage item. The tool payload copies every non-confirmed item into `unconfirmedFacts`, so the writer may be told that a fact remains unresolved even when verified memory fully confirms that exact model and attribute.
- Minimal reproduction: Produce the AC7 merged coverage, then follow `src/ai/agentManagerOrchestrator.ts:7528-7536`. The stale typed catalog item is copied into `payload.unconfirmedFacts` despite the alias-equivalent confirmed memory fact.
- Expected vs actual: Expected no unresolved writer fact for a fully covered exact product slot. Actual writer input can contain both the confirmation and a false unresolved fact for the same exact model.
- Affected files: `src/ai/agentManagerOrchestrator.ts`, `tests/agentManagerComparisonResearch.test.ts`.
- Smallest safe fix: Apply canonical same-product confirmed precedence before deriving `unconfirmedFacts`, then assert the final writer payload and required clauses contain no stale gap.
- Corrective hint: Keep semantic review as the final wording boundary, but repair the structured truth before the writer; a language reviewer cannot reliably infer that two display-name variants identify one product.

### AC10 - Missing alias-equivalent merge regression

- Criterion: AC10. Focused tests cover the research, persistence, memory reuse, partial-gap, and customer-language boundaries, and a fresh verifier pass succeeds.
- Status: FAIL.
- Why it is not proven: The focused 245-test suite and full release gate pass. The public unknown-owner regression reaches production normalization, and the two-product partial-memory regression reaches the real merge-to-writer boundary, but both use identical target and persisted product names. Neither catches canonical same-model aliases receiving different merge keys. The unknown-owner test also cannot by itself prove that `source_coverage_target_mismatch` caused exhaustion blocking because its default mocked web calls contain no validated query/source attempts.
- Minimal reproduction: Run the canonical focused suite, then change only the model A memory fact name in the two-product regression from `SUNREKA G7000iS` to `SUNREKA G7000iS generator 6 kW` while retaining typed target `SUNREKA G7000iS`; assert no stale model A `not_confirmed` coverage or `unconfirmedFacts` remains.
- Expected vs actual: Expected a focused regression to prove canonical product identity across catalog, memory, research, and writer payload. Actual tests prove per-product isolation only when every layer uses byte-equivalent display names.
- Affected files: `tests/agentManagerComparisonResearch.test.ts`, `tests/productComparisonResearch.test.ts`, `src/ai/agentManagerOrchestrator.ts`.
- Smallest safe fix: Add the alias-equivalent end-to-end regression after canonicalizing the merge. Strengthen the unknown-owner regression with otherwise complete validated tier attempts so removing the mismatch warning from the exhaustion blocker would make the test fail.
- Corrective hint: Keep the regressions on exported research and real orchestrator paths. Do not replace them with direct tests of pre-normalized persistence input.

## Fresh Verifier 8 Remediation

- Coverage merge now canonicalizes alias-equivalent display names with bidirectional exact-model identity matching before deduplication and confirmed-over-unresolved precedence; distinct model codes retain separate slots.
- The end-to-end partial-memory regression now starts with unresolved short catalog targets and a confirmed persisted verbose alias, then proves no stale unresolved fact for that model reaches `unconfirmedFacts` while the second model's real gap remains.
- The warning-based exhaustion regression now isolates `source_coverage_target_mismatch` as the blocker with otherwise completed source attempts, so removing that warning from exhaustion policy would fail the test.
- Current verification: focused 245/245 PASS; full release gate 925/925 unit and 203/203 agentic PASS; typecheck, no-regex, dependency audit, and build PASS. Fresh Verifier 9 pending.

## Unrelated Worktree Cleanup

- Removed the independent runtime V2, lead-delivery/widget, temporary catalog-analysis, stale task-artifact, and scratch-file changes at the user's request.
- Reduced mixed files (`src/db/repositories.ts`, `src/db/migrate.ts`, and `src/shared/types.ts`) to only the verified-fact provenance, memory lookup, and migration changes required by this task.
- Current post-cleanup verification: focused 245/245 PASS; full release gate 856/856 unit and 203/203 agentic PASS; typecheck, no-regex, dependency audit, and build PASS. Fresh post-cleanup verifier pending.

## AC11 Production Pass 1

- Verdict: FAIL. Runtime/preflight and widget/admin access passed on deployed commit `ea843b0e3dc4135cfb8cb3373d486cf9028a12db`, but no tested new exact fact reached verified persistence.
- Decisive reproduction: production widget session `228d9b07-0ed5-4318-a4dd-7f250b4c7040` asked for the USB output currents of exact model `BISON BS6250IE`.
- Buyer-visible failure: the assistant said the manufacturer page did not confirm USB parameters even though its cited exact page contains `DC USB output 5V/1A/2.1A`.
- Admin evidence: research correctly classified `bisonpower.net/generator/inverter-generator/BS6250IE.html` as `official_page` + `manufacturer` and extracted high-confidence facts, but marked them `evidenceVerifiedExact=false`; persistence traced `persistableCount=0`, `savedCount=0`.
- Root cause: semantic source validation could accept an exact claim, but only literal quote/value matching set `evidenceVerifiedExact`; persistence then repeated another literal translated-value substring check. Rejected duplicate guidance also hid accepted facts from confirmed coverage.
- Boundary decision: exact product identity, source fetch, authority/tier, conflict, unresolved product+attribute coverage, and execution disposition remain deterministic. Semantic claim/value equivalence stays LLM-owned and returns a structured exact-verification marker consumed by persistence.
- Smallest safe fix: mark semantically accepted exact claims as verified, derive confirmed coverage from accepted facts, and remove the duplicate literal value substring requirement after semantic verification. No product-, USB-, or model-specific production rule was added.
- Focused remediation result: `tests/productComparisonResearch.test.ts` + `tests/agentManagerComparisonResearch.test.ts` PASS, 84/84; typecheck and `git diff --check` PASS.
- Full remediation verification: canonical focused suite PASS, 247/247; release gate PASS with 858/858 unit tests, 203/203 agentic tests, typecheck, no-regex guard, dependency audit, and production build. Fresh remediation verifier pending.

## AC11 Remediation Fresh Verifier 1

- Verdict: FAIL (`AC5`, `AC6`, `AC9`, `AC10`); AC11 remains pending deployment and a production rerun. All local commands passed.
- High: semantic claim support could set `evidenceVerifiedExact` without proving that the persisted evidence string was an exact excerpt from fetched source text.
- High: prepending derived confirmations before the 12-item coverage cap could evict contradicted or unresolved product coverage before persistence and writer guards consumed it.
- Medium: the focused proof did not exercise either boundary.

## AC11 Remediation Fresh Verifier 1 Fix

- Semantic validation still owns claim/value meaning, but code now requires a concise exact excerpt to occur in fetched source text, binds it to the exact target, stores that verified excerpt, and strips reserved verification markers from model-supplied warnings.
- Fact-derived coverage remains bounded, but omitted unresolved, ambiguous, contradicted, or not-found coverage replaces a capped confirmation instead of being discarded. Retry completion also rebuilds coverage from accepted facts so facts and guidance cannot diverge.
- Added regressions for a semantically supported claim with fabricated evidence, reserved-marker injection, exact BISON excerpt propagation, and 12 accepted facts competing with contradicted coverage.
- Current verification: corrective focused 86/86 PASS; canonical focused 249/249 PASS; release gate PASS with 860/860 unit tests, 203/203 agentic tests, typecheck, no-regex guard, dependency audit, production build, and `git diff --check`. Fresh corrective verifier pending.

## AC11 Remediation Fresh Verifier 2

- Verdict: FAIL (`AC5`, `AC6`, `AC7`, `AC9`, `AC10`); AC11 remains pending deployment and production proof. All local commands passed.
- High: literal value inclusion could bypass semantic attribute/claim validation, allowing a maximum-power excerpt to be labeled as rated power.
- High: catalog/web and exact-retry merges could retain accepted facts while dropping their confirmed coverage or primary-pass facts.
- High: four targets by twelve attributes can expand malformed coverage to 48 fail-closed slots, but the 12-item internal cap retained only twelve.
- Medium: normalized case-insensitive excerpt matching returned model casing rather than the actual fetched-source slice.
- Medium: focused tests omitted these boundaries.

## AC11 Remediation Fresh Verifier 2 Fix

- Every accepted source claim now requires semantic validation of exact product, attribute, and value meaning, even when the value appears literally in the excerpt. Literal matching remains deterministic provenance evidence, not a semantic bypass.
- Exact excerpt matching returns the actual case-preserving slice from collapsed fetched source text; model-supplied casing is not persisted.
- Catalog/web merging always combines accepted facts and regenerates confirmed coverage. Exact retry merges primary, catalog, and retry facts before constructing final guidance.
- The coverage cap remains strict for confirmations but becomes soft for fail-closed unresolved/ambiguous/contradicted/not-found slots; all expanded safety slots survive for persistence and writer guards.
- Added regressions for wrong-attribute literal evidence, actual-source excerpt casing, non-start catalog-gap resolution, primary+retry fact retention, and 48 expanded fail-closed slots.
- Current verification: corrective focused 89/89 PASS; canonical focused 252/252 PASS; release gate PASS with 863/863 unit tests, 203/203 agentic tests, typecheck, no-regex guard, dependency audit, production build, and `git diff --check`. New fresh verifier pending.

## AC11 Remediation Fresh Verifier 3

- Verdict: FAIL (`AC3`, `AC5`, `AC9`, `AC10`); AC11 remains pending deployment and production proof. Existing local commands passed.
- High: facts and confirmed coverage were semantically validated with one provider call per item. A maximum result could spend 24 calls in validation alone and concurrent official tiers could consume the turn provider reserve before fallback and writer execution.
- High: timeout coverage retained only the first twelve generated slots instead of preserving every fail-closed product+attribute gap.
- High: the exhausted retry result could spread the primary result instead of the merged primary+retry result, and conflict-typed facts could survive as accepted support.
- Medium: long-source semantic validation was prefix-bound even when an exact evidence excerpt occurred later, while Unicode case folding did not robustly map a matched folded excerpt back to the actual fetched-source slice.

## AC11 Remediation Fresh Verifier 3 Fix

- Facts and confirmed coverage are fetched under bounded concurrency and semantically validated together in one indexed structured batch per result. The response budget scales with batch size, missing or duplicate validation indices fail closed, and tests prove four claims use one provider call.
- Coverage validation remains semantic rather than deterministic value matching, so aggregate claims are accepted only when the LLM validates their exact product, attribute, and meaning against fetched source text.
- Timeout and merge paths preserve all fail-closed slots and merged retry facts. Conflict-typed facts are rejected as support.
- Exact evidence matching maps Unicode-folded matches back to the fetched-source casing. Long semantic context is centered around an exact evidence excerpt when available.
- Corrective focused verification: 89/89 PASS; canonical focused verification: 252/252 PASS; release gate: 863/863 unit and 203/203 agentic tests PASS.

## AC11 Remediation Fresh Verifier 4

- Verdict: FAIL (`AC5`, `AC9`, `AC10`). The fresh source-exhaustion audit found that `source_evidence_source_cap_reached` was emitted when the global distinct-source cap prevented a read, but was not classified as unread source evidence.
- Risk: otherwise complete tier attempts could theoretically authorize source exhaustion while at least one cited source remained unread.

## AC11 Remediation Fresh Verifier 4 Fix

- Added `source_evidence_source_cap_reached` to the deterministic unread-evidence blockers and a direct regression proving it prevents source exhaustion.
- Fresh verification after the fix: focused 89/89 PASS; canonical focused 252/252 PASS; release gate 863/863 unit and 203/203 agentic tests PASS; typecheck, no-regex guard, dependency audit, build, and `git diff --check` PASS.

## AC11 Remediation Fresh Verifier 5

- Verdict: PASS for `AC1`-`AC10`; `AC11` remains pending commit/push, Railway deployment, and production widget/admin proof.
- No remaining local findings after rereading the frozen criteria and current source, retry, timeout, evidence, persistence, and exhaustion paths and rerunning all required local gates.
