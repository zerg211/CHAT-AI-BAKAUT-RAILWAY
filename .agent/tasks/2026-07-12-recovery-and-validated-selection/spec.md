# Specification — recovery and validated selection

Status: `FROZEN_BEFORE_IMPLEMENTATION`

## Production evidence that triggered the task

- Deployed commit: `7ba775f6d5966074cebfef7c10aae3359d858cf9`.
- Embedded-widget session: `f69a04c0-e6e6-4ccd-9781-5135be9cca98` on `https://bakautprof.ru/`.
- Turn 2 (`88422583-6476-4ce7-9e9d-0e946c289a34`) calculated `requiredNominalKw=5.5`, but one derived requirement referenced `calc1` without listing the same requirement in `calc1.coversRequirementIds`; deterministic fail-closed suppression removed otherwise useful answer-product evidence.
- Turn 3 (`e773cb28-5f6a-49f7-b75c-51a37186a4f6`) used the strict kind `autostart_required`, which the deterministic verifier did not support. Review correctly refused unsafe cards, but every same-turn recovery reused the same `answer_contract_created` checkpoint, so the invalid semantic answer could not be recomposed. The widget finally showed the generic technical fallback.
- Raw catalog candidates also contained conflicting phase facts. They must not become recommendations merely to satisfy a request for cards.

## Objective

Keep semantic intent in the LLM contract while making its explicit typed links and supported generator constraints mechanically executable. When a generated answer is blocked, recovery must make a fresh bounded repair attempt instead of replaying the same failed answer. Raw search candidates must never be treated as buyer-visible validated products.

## Acceptance criteria

- **AC1 — Deterministic typed-proof link repair.** When a requirement explicitly names a required typed tool request, the request exists, `verification.tool` equals the request tool, and the verifier/binding are otherwise supported, normalization adds the exact requirement id to that request's `coversRequirementIds` if the planner omitted only that reverse link. The supported generator-load proof accepts both the scenario shape (`generator_load_scenario=true`, `unit=null`) and the explicit derived-minimum shape (`nominal_power_min_kw`/`power_min_kw` with `value=null` and a kW unit). The repair is recorded in intent risk/trace metadata.
- **AC2 — Fail-closed malformed typed proofs.** Missing request ids, optional requests, tool mismatches, unsupported verifier/binding, malformed results, and wrong product classes remain blockers. The repair must not infer a tool or a semantic requirement that the LLM did not explicitly declare.
- **AC3 — Typed generator autostart constraint.** Strict `auto_start_required` and `autostart_required` requirements accept only boolean values with `unit=null` and are evaluated against explicit product facts. Required `false` accepts an explicitly confirmed no-autostart product; required `true` accepts an explicitly confirmed autostart product. Unknown or contradictory facts fail closed.
- **AC4 — Same evidence boundary for text and cards.** Answer product evidence and visible card selection apply the same autostart and existing phase/power constraints. No model may be named or shown merely because it occurred in raw `catalog.search` output.
- **AC5 — Validated products are authoritative.** The answer writer and semantic reviewer treat the top-level validated `products` array as the only catalog recommendation set. If raw search returned rows but validated `products=[]`, they may require a truthful explanation and a useful next action, but must not demand impossible cards or invent a model from raw tool payloads.
- **AC6 — Blocked answer checkpoint invalidation.** Before throwing a blocked-review error, persist structured review failure evidence and mark the draft `answer_contract_created` checkpoint non-succeeded. A same-turn recovery reuses valid ledger, intent, calculator, and catalog artifacts but must not reuse the blocked answer contract.
- **AC7 — Structured recovery feedback.** The recovered answer composition receives the prior review issue codes/messages as bounded repair context. It must not be implemented as a canned buyer-facing sentence or a product/phrase-specific branch.
- **AC8 — Bounded recovery.** Recovery remains within the existing turn/model-call budgets. If a fresh answer still cannot pass, it fails safely; it must not loop forever or silently publish an unverified recommendation.
- **AC9 — Regression coverage.** Tests cover duplicate typed requirements sharing one calculator proof, malformed proof cases, both autostart aliases and boolean directions, unknown/conflicting product facts, text/card parity, reviewer behavior with raw candidates but no validated products, and recovery that recomposes rather than reuses a blocked answer.
- **AC10 — No phrase patch.** `npm run test:no-new-regex` passes and no branch matches the production buyer sentence, pump model, brand, or exact dialogue wording.
- **AC11 — Local release gate.** Focused tests, full `npm run verify`, `npm audit --audit-level=low`, typecheck/build, and `git diff --check` pass on the final diff.
- **AC12 — GitHub and Railway proof.** The implementation is committed and pushed to `origin/main`; `/api/health` reports the exact full commit SHA. No manual Railway deploy command is used.
- **AC13 — Adaptive production replay.** A fresh embedded-widget dialogue on `https://bakautprof.ru/` must: preserve the useful first clarification; calculate the detailed load; handle an explicit preliminary-card request without a generic fallback; show only mechanically validated cards or clearly explain why no verified candidate can be shown; and keep memory of phase, simultaneous operation, and autostart. Buyer-visible text and authenticated admin metadata are audited.
- **AC14 — Durable evidence.** Save the production transcript, session/turn ids, calculator result, catalog/card decisions, warnings, recovery traces, marker SHA, and final verdict in task evidence and `local-live-tests/*.production.md`.

## Non-goals

- Do not weaken phase, power, product-class, or unsupported-fact fail-closed checks.
- Do not promise stock, price, delivery, discount, or lead completion without exact evidence.
- Do not manually deploy Railway.
- Do not bulk-sync or rewrite the production catalog without separate authorization.
