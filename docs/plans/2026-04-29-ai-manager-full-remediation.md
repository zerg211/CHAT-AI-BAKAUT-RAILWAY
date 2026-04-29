# 2026-04-29 AI-manager full remediation plan

Goal: turn the chat runtime into one coherent AI sales manager, not overlapping rule layers, while preserving current buyer-facing quality.

Total stages: 7.

## Stage 0 — restore reliable verification baseline
Scope:
- Fix local dependency/test runner issue if needed.
- Establish current gates before production refactor.
Acceptance:
- `npm run typecheck` passes.
- `npm test` runs or the dependency blocker is documented with exact cause.
- `npm audit --omit=dev` checked.

## Stage 1 — introduce typed turn contract without behavior change
Scope:
- Add shared `ResolvedTurn` / `TurnContract` types.
- Add a resolver that converts the existing planner result + deterministic policies into one typed object.
- No broad behavior rewrite.
Acceptance:
- Existing tests pass.
- New tests prove contract preserves existing planner fields and render policy.

## Stage 2 — make downstream render/action decisions consume the contract
Scope:
- Replace scattered direct checks of `answerMode`, `cardPolicy`, `followUpPolicy`, lead/web/card flags where safe with contract accessors.
- Keep old logic behind the resolver until fully migrated.
Acceptance:
- Tests cover lead flow, text-only factual answers, current-lineup text-only, and product-card recommendation turns.

## Stage 3 — unify product-selection authority
Scope:
- Move selection-state overrides, structured catalog slice forcing, and card policy overrides into the contract resolution stage.
- Keep deterministic catalog truth and hard filters.
Acceptance:
- Tests cover generator unknown-load clarification, accessory follow-up, changed requirements, exact model lookup, and show-more contract.

## Stage 4 — explicit knowledge policy
Scope:
- Make catalog/site/company/web source policy a first-class contract field.
- Ensure web-required turns are traceable and verified findings persist when safe.
Acceptance:
- Tests cover technical fact/current-lineup questions requiring web, and no-web ordinary recommendation turns.

## Stage 5 — split `AssistantService` into stage modules
Scope:
- Extract pure helpers/modules: need state update, planning, retrieval, selection, contract resolution, answer generation, persistence.
- No product behavior change except through already-tested contract.
Acceptance:
- `src/ai/assistant.ts` materially smaller.
- Full tests pass.
- Contract diagnostics still present in metadata.

## Stage 6 — regression/live-dialog hardening
Scope:
- Add/refresh live regression scenarios for natural buyer dialogue.
- Verify the assistant does not degrade in realistic live chat.
Acceptance:
- `npm run typecheck` passes.
- `npm test` passes.
- `npm run build` passes.
- One local live protocol saved under `local-live-tests/*.local.md`.

## Stage 7 — production verification after deploy
Scope:
- Push clean commits.
- Verify GitHub/Railway deploy.
- Run live Railway dialogue/audit.
Acceptance:
- Production health reports expected commit.
- Live dialogue still behaves as AI consultant: asks useful clarifications, preserves context, uses catalog/web facts, and does not leak wrong cards/forms.

Execution rule:
- Use TDD for every behavior-impacting change.
- Execute locally with `gpt-5.5`/current Hermes session; Codex is not required for this local-only repo state.
- Do not add trigger-word patches as the main fix.
- Stop only on blocker, failing verification, or if plan/docs need correction.

## Progress log

### 2026-04-30
- Stage 0: complete. `npm install` restored dependency baseline; `npm run typecheck`, `npm test`, and `npm audit --omit=dev` passed after fixing the healthcheck timeout.
- Stage 1-4: local implementation in progress/mostly complete for TurnContract authority:
  - `src/ai/turnContract.ts` introduced.
  - `selectCardsFromPlan`, `selectProductsForTurn`, `findStructuredCatalogSlice`, answer reasoning, card rendering and selected-product scoring now consume `ResolvedTurnContract` in the touched paths.
  - Tests added/updated in `tests/turnContract.test.ts` and `tests/recommendationRanking.test.ts`.
  - Latest local gates: `npm run typecheck` PASS, `npm test` PASS (101 tests), `npm run build` PASS.
  - Local live protocol: `local-live-tests/2026-04-30-turn-contract-generator.local.md`.
- Stage 5: complete locally. Extracted shared assistant types/constants to `src/ai/assistantTypes.ts` and OpenAI/response parsing helpers to `src/ai/responseUtils.ts`; `src/ai/assistant.ts` is smaller and keeps the same runtime behavior.
- Stage 6: local live verified through the UI with `gpt-5.5`; first run exposed a 90s generation timeout on a purchase/accessory follow-up, so `GENERATION_TIMEOUT_MS` was raised to 180s and the UI dialogue passed. Protocol: `local-live-tests/2026-04-30-stage6-ui-vibroplate-after-timeout.local.md`.
- Stage 7: production deploy/Railway verification pending.
