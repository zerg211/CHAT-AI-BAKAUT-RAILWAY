# LLM Router Fast-Path Finalization Evidence

## Status

Current status: local code verification PASS after removing deterministic lead-created answer override and adding LLM post-verification rewrite, final_ready=false.

This is not final yet because the current code still needs commit/push, Railway deploy observation, and a passing production widget live gate through https://bakautprof.ru/.

## Acceptance Criteria

- AC1 - PASS locally: commercial handoff and catalog-selection fast route decisions now come from `llm_fast_turn_route`.
- AC2 - PASS locally: fast-route buyer-facing answers now come from `llm_fast_turn_answer`; deterministic commercial/catalog text is not the normal path; local lead-created confirmation no longer overwrites the LLM answer; post-verification failures are rewritten by LLM before final rejection.
- AC3 - PASS locally: catalog retrieval, card manifest, lead persistence, policy gate, and post-answer verification still run around the LLM answer; `autoLead` state is passed into answer context; repeated contact requests after created leads are blocked.
- AC4 - PASS locally: focused tests cover LLM route/answer use for commercial handoff, mixed catalog selection, LLM-preserved lead confirmation, LLM post-verification rewrite, and post-answer created-lead contact blocking.
- AC5 - PASS locally: evidence artifacts are recorded under this task directory.

## Commands

- `npm run typecheck` - PASS.
- `npm test -- tests/assistantFallback.test.ts tests/assistantControlPlaneGenerate.test.ts tests/remediationCommercialFallback.test.ts tests/assistantLegacyWriterGuard.test.ts tests/postAnswerVerifier.test.ts` - PASS, 5 files / 48 tests.
- `npm test` - PASS, 58 files / 498 tests.
- `npm run migrate` - PASS.
- `npm run embeddings:coverage` - PASS command, local DB finalReady=false.
- `npm run embeddings:backfill -- --dry-run --limit=50` - PASS.

## Notes

Local embedding coverage is not production evidence. It reports zero usable local embeddings, but this change did not modify embedding storage or backfill logic.

## Production Live Gate

- Attempted on 2026-05-20 through `https://bakautprof.ru/` widget.
- Protocol saved: `local-live-tests/2026-05-20-production-diverse-buyer-audit-2026-05-20T07-34-41-926Z.production.md`.
- Result: FAIL on current production commit `393b306`: final lead/order-check turn fell into recovery failure after post-answer verification rejected unsafe commercial wording.
- Local fix added after this failed live gate: LLM post-verification rewrite before final rejection. This still requires commit/push, Railway deploy observation, and a new passing production widget live gate.
