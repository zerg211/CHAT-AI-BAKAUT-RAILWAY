# BAKAUT AI manager — final project state

Updated: 2026-09-08

## Scope completed

The completion plan in `C:\Users\Александр\Downloads\deep-research-report.md` was implemented as a single repository change set. The companion `deep-research-report (1).md` is a one-line link to a sandbox artifact that is not present locally; that missing artifact is recorded in the task evidence instead of being invented.

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

The task evidence is in `.agent/tasks/2026-09-08-completion-plan/`. AC7 is complete only after the code is pushed, Railway deploys the new runtime marker, and an adaptive dialogue is audited through the real embedded widget at `https://bakautprof.ru/`. The resulting protocol belongs in `local-live-tests/*.production.md`; otherwise the project state remains partial and must say why.

## Explicit non-scope

Stock, delivery, reservation, order status, CRM, and manual Railway deployment were not added. The production model remains GPT-5.6 Luna unless current provider evidence justifies a configuration change. Local OpenAI calls are not treated as valid production behavior evidence in this environment.
