# Verification problems and fixes

## P1 — client helper tests disturbed widget session tests

The first full-suite run after the implementation passed 1491 tests and failed four. Three `widgetSessionBoundary` assertions were caused by the new component test importing `src/client/main.tsx`, which executed the application entry point and changed module/mock state for unrelated tests.

Smallest fix: move the pure admin/contact view-model helpers into `src/client/widgetDiagnostics.ts` and test that module directly. The affected focused suite then passed 114/114.

## P2 — parallel full suite hit unrelated five-second timeouts

The fresh parallel run passed 1499 tests and timed out in three unrelated cases: admin authorization, lead persistence, and the real external PDF parser. No assertion failed. Running exactly those files with one worker passed 20/20 in 3.90 seconds.

The full repository suite was then rerun with one worker and passed 1502/1502 with one intentional skip. The repository release gate independently repeated the suite with serial files and also passed 1502/1502 with one skip.

No product-code change was made for P2 because the failures were process contention against a fixed five-second test timeout, not a reproducible behavior defect.

## P3 — production research turn spent the final-answer window

The first post-deploy widget dialogue (`#2186`, session `76513e9c-98ed-4563-ab0c-885b00d7522d`) failed before any assistant message was committed. The buyer saw only `Не удалось завершить ответ. Текст вашего вопроса остался в чате.` The persisted turn ended as `agent_manager_generation_failed` with `Structured JSON request exceeded its deadline`.

The trace shows a successful calculator and catalog search, then a 45.846-second web research call. Research finished with 48.834 seconds left; the optional observation cycle and one catalog detail read reduced that to 36.541 seconds. The writer was then limited by `deadlineForStage(45_000, 15_000)` to roughly 21 seconds and timed out. `WEB_ANSWER_RESERVE_MS=30_000` preserved less time than the actual writer plus semantic review contract requires, while the observation-cycle guard only stopped below 40 seconds.

Required fix: reserve the complete writer-and-review window before admitting web research or another observation round. Under a short remaining budget, persist an honest partial research result and proceed to the writer with the catalog/calculator/verified evidence already collected. Do not add a query-specific fallback and do not mask the failed production dialogue.

Smallest fix applied after root/critic review: one `AGENT_MANAGER_FINALIZATION_RESERVE_MS` now protects 45 seconds for composition, 15 seconds for semantic review and a 5-second checkpoint/evidence margin. Initial web research preserves that reserve. A continuation round needs a further fixed 10 seconds before admission, and every continuation read receives the same downstream reserve at execution time. FAST/NORMAL catalog work keeps its prior 8-second reserve until semantic observation expands the turn to RESEARCH. The critic rechecked the final diff and returned PASS; the focused suite passed 205/205.

## P4 — removed external PDF fixture blocks one repository test

`tests/firstPartyPdf.test.ts` currently requests `https://bakautprof.ru/documents/hours.pdf?branch=2`. A fresh independent HEAD request returned HTTP 404. The test first exceeded its five-second limit and, with a 15-second test timeout, completed with `result.ok=false`, consistent with the removed remote fixture. This test does not exercise the finalization-reserve change. It remains recorded as a failed external integration check rather than being weakened or silently skipped.

## P5 — one long generated sequence exceeded the fixed test timeout under the release gate

The release-gate serial suite timed out on seed 22 of `dialogueLedgerGeneratedSequences.test.ts`. An immediate isolated rerun of the complete file passed 24/24 in 48.94 seconds. No product-code change was made because the assertion and all generated sequences passed when isolated; the gate failure is preserved alongside the retry result.

## P6 — aggregate calculator evidence triggered an unaffordable repair

The second post-deploy widget dialogue (`#2187`, session `96948942-ee02-400d-9ba7-65b0478aa6d0`) again ended before an assistant message was committed. The first corrective reserve behaved correctly: after calculator, catalog, web research and observation, another continuation was refused with 68.15 seconds left, and the writer completed a useful draft. The semantic review then returned three `fact_evidence_attribute_mismatch` issues and repair started with only 31.359 seconds remaining; its 30-second writer deadline expired before the reserved second review.

The draft declared `combined_running_load=2.9` with attribute `totalRunningKw`, but bound it to three component evidence items whose attributes are `runningKw`. The calculator had already persisted the authoritative aggregate at `payload.profile.totalRunningKw=2.9`. Recomputing this value inside the validator would be unsafe because calculator semantics include counts, operation modes, simultaneous groups, scenarios and rounding.

Smallest fix after root/critic dispute: for this narrowly defined calculator aggregate only, component IDs from one successful calculator request are remapped to the exact canonical `payload.profile.totalRunningKw` item when the fact value matches it exactly. Any wrong value, missing canonical item, mixed request, non-running component or product-scoped claim remains fail-closed. Calculator profile evidence is enumerated before loads so the canonical total survives the 80-item cap. Repair admission now requires more than 47 seconds: 30 seconds for the writer, 12 seconds for the second review and 5 seconds for persistence and other operations.

## P7 — verified-memory projection lost durable evidence provenance

PR #28 merged as `984cbf7eba8fd736848f79995df3cc10aaa8cc7f` and Railway deployment `050492ad-7e20-404e-add1-f014bffa4d06` reached SUCCESS at that exact SHA. Production dialogue `#2188` (session `355fccf1-14f5-493e-b5d2-5640416cca07`) proved the calculator correction: the first turn completed with a useful 2.9 kW preliminary selection. On the buyer's natural follow-up, a second useful draft was composed but the buyer saw only the recovery message and final error.

The second turn loaded four A-iPower values from verified fact memory. `verifiedFactsResearchResult()` preserved their value and source URL but dropped the durable row ID and exact-evidence status. The writer cited `research_generator_facts`, while `toolResultEvidenceItems()` correctly refused to expose the projected facts as exact evidence. Review blocked two numeric facts; a third nonnumeric fuel fact revealed a separate gap because missing item bindings were enforced only for claims containing a number.

Final root/critic resolution:

- add `verified_product_facts.evidence_verified_exact NOT NULL DEFAULT false`; do not backfill legacy/SQL rows;
- set the marker only in the current exact-validated runtime persistence path, reject new web/manual repository writes without it, and allow a later exact write to promote a legacy row;
- retain legacy URLs as research candidates while preventing their values from becoming reusable facts;
- project the durable row ID and exact marker into memory research, and use a stable row-backed evidence item ID;
- fill an omitted item ID only for one exact source/product/canonical-attribute/normalized-value match;
- require item binding and value compatibility for nonnumeric tool facts as well as numeric facts.

The critic found and corrected one flaw in the root implementation: production memory results repeat the same row in `facts` and `coverage`, so a raw unique-count saw two candidates. The final binder removes only a proven coverage projection duplicate. A separate fresh exact fact remains an independent candidate and keeps the answer fail-closed. The root challenged that preference and the generic repository guard; after caller and ambiguity analysis, the critic's narrower duplicate rule and repository-boundary guard became the final shared position.

## P8 — one prioritized question was stated as the only remaining blocker

PR #29 and Railway correctly deployed the durable-memory correction, including a no-backfill production migration. In clean production conversation #2189 the calculator returned `missingStartingLoads` for the refrigerator, circulation pump and workshop tool. The writer's preliminary product facts and caveats were grounded, but its last sentence said that one pump fact would move the selection to exact. The semantic reviewer correctly rejected that claim as `research_guidance_uncertainty_mismatch`; no assistant message reached the buyer.

The root proposed lowering the repair threshold or adding a deterministic salvage path, then challenged both options. The critic argued that the current repair repeats the full writer and review, so the observed 43 seconds cannot safely replace the proven `>47,000 ms` admission boundary; recognizing an overbroad sufficiency promise through phrase matching would also put a semantic decision into code. The final shared fix keeps review fail-closed, supplies the complete deterministic missing-start list to the LLM, and defines one focused question as a next step rather than the sole blocker. This applies to every multi-gap technical answer, not to one Russian phrase.

## P9 — repair mixed calculator evidence IDs with display paths

PR #30 and Railway deployment `b7d67533-23a7-4113-b4f7-c39e665c184e` reached merged SHA `b19b2dfa7055c05ae152b73324e38d02c6962565`. In clean production conversation #2190 (session `2d79d260-0e79-41dc-b9d2-1a1c94a50657`, turn `2b42863f-031f-417e-9ce6-264d04b97b83`) the revised writer produced the intended honest preliminary answer: all unresolved startup loads remained visible and the pump question was only the next step. The buyer still saw recovery followed by the generic failure message.

The first draft used canonical calculator item IDs but attached consumer names as `productName` and mixed `startingSource` with a numeric `startingKw`; review correctly rejected those bindings. Repair fixed product, attribute and value semantics, then emitted hybrid addresses such as `calc_generator_workshop_1:payload.profile:totalRunningKw`, combining the displayed evidence path with the opaque item ID. Five otherwise exact calculator facts were rejected as unknown and the remaining wall-time could not fund another repair.

The root first proposed a bounded calculator-profile address normalizer. The critic initially preferred enumerating all evidence IDs in the response schema; the root challenged the extra latency and schema size from duplicating up to 160 long IDs. The critic accepted that objection and made the scoped normalizer the final shared position: only a successful `calculator.generatorLoad`, only `payload.profile`, an exact request-ID prefix and exactly one canonical path match. Existing product, attribute, status, exact-evidence and value checks still run, and the stored binding uses the canonical item ID. Web, catalog and verified-fact evidence remain exact-ID-only. Negative tests preserve failure for wrong values, attributes, sources, product scope, non-profile paths, ambiguous normalized paths and using `startingSource` as proof of numeric `startingKw`.

## P10 — writer combined several evidence units into one fact

PR #31 merged as `be7a6b43a900342802f3338312f61ad6c8034253`; Railway deployment `d4e1ff15-1b22-4cc9-9eb9-10e33b254028` reached SUCCESS at that exact SHA and the public health marker matched. Clean production conversation #2191 (session `f02ea0e8-a2b8-482b-b66a-b8a5200a4fec`, turn `01feb77f-fc67-4c8f-88cc-509c2933226b`) still showed the generic completion error and committed no assistant message.

The prior calculator-address fix worked: the writer used canonical IDs. The new failure was semantic structure. Three `factsUsed` entries combined different evidence attributes or values: `2.8 kW` with `estimated_average`, two separate `missingStartingLoads` values, and phase with voltage and fuel. The answer text itself was useful and preserved every unresolved start load, but the deterministic validator correctly rejected the composite contract. The semantic language reviewer also rejected the internal phrase `В расчётном профиле`.

Root and critic agreed that code must not split or remap these composite facts: doing so could make unsupported customer text appear grounded. The final correction keeps the validator fail-closed, limits each writer fact to one evidence item in the structured schema, and instructs both initial and repair writing to emit one product, one attribute and one scalar value per `factsUsed` entry. Exact repair issue evidence is serialized into the untrusted user-data payload and never interpolated into the system prompt. Customer-facing calculation/source attribution remains allowed; only internal tool/pipeline/stage/profile vocabulary is forbidden. Regression tests preserve the three #2191 composites as failures and accept their seven atomic canonical equivalents.

## P11 — evidence attribute invention exposed an underpowered preliminary pool

PR #32 merged as `4b91438a5ee192cb0bce92b9c3d46638f71449a6`; Railway deployment `844b97ed-3b66-4a57-ba81-4acb621bd32b` reached SUCCESS at that exact SHA and the public health marker matched. Clean production conversation #2192 (session `08ca6331-b992-4c79-afdd-da5f6ecf34c3`, turn `077c56fc-5a46-439b-a2d8-7110d277b644`) still committed no assistant message.

The atomic schema worked, but the writer labelled three exact `missingStartingLoads` items as invented attribute `starting_power_kw`; deterministic review correctly returned three `fact_evidence_attribute_mismatch` issues. The same trace exposed two independent defects. First, the catalog returned eight generators rated 0.65–1.6 kW even though the calculator proved a 3 kW running-only floor. That floor cannot prove final startup sizing, but it does prove every lower nominal rating incompatible. Second, `catalog.search` reported `configuredTimeoutMs=10000` while completing after 34128 ms; its 1,000-row primary expansion consumed the budget reserved for required web research.

The root proposed an evidence-derived attribute enum, then challenged the critic's initial scope because durable verified facts can be the only source in a later turn. The final enum includes active ledger `factKey`, concrete tool evidence attributes and `verifiedProductFacts[].attribute`, and stays unconstrained only when the set is empty. Both sides rejected attribute rewriting because it could turn a nominal value into a maximum value or otherwise hide a real qualifier error.

On candidate filtering, the critic accepted the root's objection that running-only load is a deterministic lower bound, then caught an unsafe fallback: raw `totalRunningKw` can be only the known part when power factor or another running load is unresolved. The final helper reads `requiredNominalKw`, otherwise only `runningOnlyNominalFloorKw`; it never changes final readiness or the required-nominal oversize guard. The floor is applied before ranking and slicing, so proven-underpowered cards cannot occupy the shortlist.

The critic's final objection found that a `TimeoutError` raised by the absolute deadline could enter the generic retry branch while the timer-backed signal still reported `aborted=false`. The final executor classifies that timeout before retry eligibility. An executor-level regression crosses the deadline during the repository call and proves one search call, `status=timeout`, `attempts:1` and one saved artifact. Root verification passed 238/238 focused tests, TypeScript, production build and the no-new-regex guard; the critic's independent 230/230 run, TypeScript, regex and diff checks passed, and the final verdict is PASS.

For latency, both rejected a hard `Promise.race`, which would leave PostgreSQL/CPU work alive and cannot interrupt a blocked event loop. The corrective path keeps the 1,000-candidate breadth but uses a bounded 1,200-character description prefix during expansion, hydrates only the selected products through a signal-aware lookup, checks an absolute deadline between stages and rethrows cancellation from fail-soft catches. The prefix preserves the description signals used by the classifier; full product text is restored before answer composition.
