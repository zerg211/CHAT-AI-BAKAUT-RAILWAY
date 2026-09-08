# BAKAUT AI manager — final project state

Updated: 2026-09-08

## Status: PARTIAL — full programme not yet accepted

Selected implementation items from `C:\Users\Александр\Downloads\deep-research-report.md` were deployed in commit `8b0ad11032ef5c36d7ea9c8dd83124c08aa04335`. This is not completion of the full programme. Both supplied documents reference longer sandbox artifacts that are absent locally: `BAKAUT_FINAL_COMPLETION_PLAN_MUSE_SPARK_1_3_2026-09-07.md` and `BAKAUT_AI_MANAGER_FINAL_HARDENING_GUIDE_MUSE_SPARK_1_3_2026-09-07.md`. The first report describes a 1,531-line master plan; only its 151-line summary was available.

The existing T01–T13 implementation was preserved. The new hardening work adds:

- truthful customer progress driven by real orchestrator stages;
- durable turn events with per-turn cursor replay and bounded transport recovery;
- shared, deduplicated, bounded current-price verification with proof and circuit breaking;
- FAST/NORMAL/RESEARCH/ACTION/RECOVERY budget profiles under the hard ceiling;
- a compact structured decision artifact with no hidden chain-of-thought;
- provider prompt/schema/token/cost observability and resolved-conversation cost metrics;
- strict JSON parsing in place of balanced-brace repair;
- targeted semantic regex enforcement plus retirement of the obsolete Promptfoo pipeline.

## Boundary of responsibility

The LLM decides semantic intent, requirement changes, risk, research need, candidate meaning, authorization policy, and stop/continue. Deterministic code owns typed schemas, limits, transport sequencing, catalog facts, price identity/proof, circuit/concurrency controls, redaction, release gates, and idempotent side-effect infrastructure. No buyer-specific keyword or canned-answer patch was added.

## Verification

`npm run verify` passed all local gates: offline acceptance 193/193, seeded mutation checks 12/12 killed, no-regex delta, production dependency audit with zero high vulnerabilities, typecheck, 101 test files/1311 tests, and production build. The release gate reported `REAL_AGENT_ACCEPTANCE=NOT_RUN` by design.

The task evidence is in `.agent/tasks/2026-09-08-completion-plan/`. On 2026-09-08, the deployed marker was verified and four adaptive buyer turns were completed through the embedded widget at `https://bakautprof.ru/`, session `eb2288ba-2474-4558-9050-8165a7499bdc` (#2169). Visible responses were read between turns and cross-checked against admin metadata. Server times were 20.076, 56.118, 88.447 and 80.248 seconds; all turns completed without recovery or lead capture. The protocol is `local-live-tests/2026-09-08-completion-plan.production.md` (local, not committed).

## Outstanding programme requirements

- The new DecisionArtifact is a diagnostic summary constructed near composition; it is not evidence that a new executable decision loop supervises every action.
- Budget profiles exist, but current profile selection uses prior need state and message length. Current-turn semantic risk routing and validated adaptive model/reasoning escalation are not fully implemented.
- Characterization-first decomposition into the supervisor/router/resolver/selection/action/composition/recovery/telemetry components from the report remains outstanding.
- No measured pre-change baseline, paired A/B cost/quality result, or validated cost per resolved conversation is available. Turn-budget estimates are not billed provider costs.
- The existing synthetic calibration examples do not establish human-labelled critical recall/precision, Cohen kappa, Krippendorff alpha or session holdout targets from the report.
- Persisted event replay has unit coverage, but an actual interrupted-stream/reconnect production proof has not been collected. Four normal completed turns do not prove recovery.
- The live dialogue exposed repeated shared selection rationale on every card and incomplete next-step guidance after unresolved research. These are recorded for correction; the final global quality verdict is NOT_PROVEN.

Earlier local PASS labels apply only to their narrow tests; they do not certify the complete requirements of either unavailable master document. Full completion must not be claimed until the outstanding items and final acceptance evidence are resolved.

## Explicit non-scope

Stock, delivery, reservation, order status, CRM, and manual Railway deployment were not added. The production model remains GPT-5.6 Luna unless current provider evidence justifies a configuration change. Local OpenAI calls are not treated as valid production behavior evidence in this environment.
