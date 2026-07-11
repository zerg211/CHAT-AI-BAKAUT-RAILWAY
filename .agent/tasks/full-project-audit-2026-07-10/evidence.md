# Evidence

## Scope

- Repository: `C:\Projects\chatAI`
- Branch: `main`
- HEAD: `2ce1ce43b3804b72e723d403fc355a66331b3358`
- Source code was not changed.
- Existing user modifications in `.agent/tasks/2026-07-08-agentic-dialogue-fixes/` were preserved.

## Key static evidence

- Active runtime dispatch: `src/ai/assistant.ts:9930-9936`.
- New orchestrator entry/recovery: `src/ai/agentManagerOrchestrator.ts:2383-2403`.
- Text-based request hash: `src/routes/chat.ts:32-34`.
- Cross-turn hash reuse: `src/db/repositories.ts:528-545`.
- Session history bounded to 80: `src/db/repositories.ts:944-951`.
- Ledger bounded to 500 in runtime: `src/ai/agentManagerOrchestrator.ts:2578-2581`.
- Derived state not persisted by new runtime: no `updateNeedState`, `updateHistorySummary`, or `updateSessionTopic` call in `agentManagerOrchestrator.ts`.
- Limited regex product-class reducer: `src/ai/dialogueLedgerReducer.ts:47-54`.
- Generic tool args and unbounded request list: `src/ai/agentManagerContracts.ts:58-68`, `:126-137`.
- LLM reviewer default off: `src/config.ts:88`, `src/ai/agentManagerOrchestrator.ts:4088-4091`.
- Lead side effect in tool loop: `src/ai/agentManagerOrchestrator.ts:3322-3378`.
- Final-contract recovery drops cards: `src/ai/agentManagerOrchestrator.ts:4131-4180`.
- Stale runtime artifact marker: `src/app.ts:13-29`.
- Dynamic policy only wired to legacy prompts: `src/ai/assistant.ts`, `src/ai/prompts.ts`; no matching import/use in `agentManagerOrchestrator.ts`.

## Commands

- `npm run typecheck` -> PASS.
- `npm run build` -> PASS.
- `npm test -- --run` -> 93 files PASS, 1 file FAIL; 768 tests PASS, 1 timeout FAIL.
- `npm test -- tests/productionLiveGate.test.ts --testTimeout=15000` -> PASS, 5/5.
- `npm run lint:no-regex` -> FAIL, 91 new constructs.
- `npm audit --omit=dev --json` -> 4 vulnerabilities: 2 high, 2 moderate.
- `git diff --check` -> no whitespace errors; existing CRLF warnings only.

## Existing production evidence read

- `.agent/tasks/2026-07-08-agentic-dialogue-fixes/evidence.md`
- `.agent/tasks/2026-07-08-agentic-dialogue-fixes/production-dialogues-2026-07-08T14-39-57-735Z.production.md`

The stored protocol reports commit marker `2ce1ce4`, `https://bakautprof.ru/`, six scoped sessions, and zero recorded issues. It is evidence for the July 8 scoped fixes, not a complete fresh live audit for this report.

## Acceptance criteria verification

| AC | Verdict | Evidence |
|---|---|---|
| AC1 | PASS | Report sections 2-3 separate original intent from active implementation. |
| AC2 | PASS | Report section 3 traces widget -> route -> runtime -> tools -> answer -> persistence. |
| AC3 | PASS | Widget, backend, OpenAI, ledger, catalog, web, cards, leads, DB, admin, deploy and tests were inspected. |
| AC4 | PASS | Report section 4 contains the feature/status matrix. |
| AC5 | PASS | Report section 6 explicitly maps semantic LLM decisions and deterministic invariants. |
| AC6 | PASS | Report section 5 contains P0-P3 findings with code evidence, impact and recommendation. |
| AC7 | PASS | Report section 7 lists legacy-only, duplicated, stale and unfinished components. |
| AC8 | PASS | Commands and outcomes are recorded above and in `raw/checks-summary.txt`. |
| AC9 | PASS | Report sections 9-10 define target architecture and phased remediation criteria. |
| AC10 | PASS | Static conclusions are separated from production-state items requiring live/DB verification. |

Fresh verifier verdict: **PASS for the audit deliverable**. This does not mean the audited application passed all readiness gates; the application verdict remains `PARTIAL_NOT_PRODUCTION_COMPLETE`.
