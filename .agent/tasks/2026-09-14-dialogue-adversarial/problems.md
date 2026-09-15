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
