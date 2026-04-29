# Audit Remediation Test Plan

## 2026-04-29 — AI manager architecture audit

Area: chat AI agent / sales-manager behavior.
Status: audit completed, remediation not started.

Findings:
1. `src/ai/assistant.ts` is a god-runtime: ~5,470 lines combine need extraction, planning, product retrieval, deterministic classification, full-catalog selection, web verification, answer repair, metadata, and persistence.
2. The intended AI-manager loop exists, but several deterministic layers can override the planner: `fallbackTurnPlan`, `selectProductsForTurn`, `findStructuredCatalogSlice`, `selectCardsFromPlan`, `enforceAnswerCardContract`, answer sanitizers/repairs.
3. Product-selection state is strong but split across planner schema, `CustomerNeedState.selectionState`, hard/soft criteria, card metadata, and frontend `leadRequested/cards`; there is no single typed turn contract that owns “what the buyer wants now / what to do next / what to render”.
4. Site/catalog knowledge is live through `catalog_pages` retrieval and injected into planner/final context, but web-fact extraction is disabled by default (`OPENAI_ENABLE_WEB_FACT_EXTRACTION=false`), so verified external facts mostly become evidence logs, not durable product knowledge.
5. Generator and product-card logic has accumulated many family-specific regex/heuristic branches; this improves recent cases but raises branch-rot risk and can make the agent feel rule-bound.
6. Verification status: `npm run typecheck` passed; `npm test` is blocked by missing optional Rollup native package in local `node_modules` (`@rollup/rollup-linux-x64-gnu`); `npm audit --omit=dev` reports 0 vulnerabilities.

Affected files:
- `src/ai/assistant.ts`
- `src/ai/prompts.ts`
- `src/ai/needState.ts`
- `src/shared/types.ts`
- `src/db/repositories.ts`
- `src/client/main.tsx`
- `docs/ASSISTANT_BEHAVIOR.md`
- `docs/ARCHITECTURE.md`
- `docs/EVALS.md`

Recommended fixes:
1. Extract a typed `TurnContract` that becomes the only authority for current intent, action, search scope, lead action, product selection, render policy, and knowledge requirements.
2. Split `AssistantService.generateAnswer` into explicit stages: state update, planner, retrieval, selection, knowledge verification, answer generation, post-check, persistence.
3. Move deterministic product-selection heuristics behind one semantic selection engine with traceable reasons, instead of scattered overrides after the planner.
4. Make knowledge policy explicit: catalog/site/company/web sources should be chosen by the turn contract and persisted as verified facts when safe.
5. Add regression tests around full dialogue turns, not only ranking helpers: changed requirements, accessories vs core products, generators with unknown loads, current-lineup questions, lead capture.

## 2026-04-30 — TurnContract Stage 1-4 progress

Area: turn contract / product-card selection / knowledge policy.
Status: implemented locally, verified by automated tests and one local live protocol.

Findings addressed:
1. Added `src/ai/turnContract.ts` with a typed resolver for action, scopes, knowledge/web requirement, selected products, render cards, lead form, guidance, and diagnostics.
2. Routed `selectCardsFromPlan`, `selectProductsForTurn`, `findStructuredCatalogSlice`, answer reasoning complexity, card suppression, and selected-product boost through the resolved contract where safe.
3. Added regression coverage for contract-level text-only/card suppression, structured selection suppression, selected-product authority, and stale planner selection not outranking current contract selection.
4. Preserved existing recommendation/card regressions after removing the last failing stale-selection case.

Verification:
- `npm run typecheck` — PASS.
- `npm test` — PASS, 7 files / 101 tests.
- `npm run build` — PASS.
- Local live protocol saved: `local-live-tests/2026-04-30-turn-contract-generator.local.md`.

Remaining:
1. Stage 5 module extraction was completed locally for shared assistant types/constants and OpenAI response helpers; deeper stage extraction can continue later, but the current `assistant.ts` no longer owns those support contracts.
2. Live answer quality is acceptable for generator and vibroplate flows; Stage 6 also found and fixed a timeout issue for a purchase/accessory follow-up by increasing route generation timeout to 180s.
3. Stage 7 deploy/Railway verification remains pending and must not be claimed complete from local checks alone.
