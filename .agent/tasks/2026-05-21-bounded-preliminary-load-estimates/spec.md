# Task: Bounded Preliminary Load Estimates

## Problem

When a buyer asks for an approximate generator selection but does not know exact consumer powers, the assistant must not stop at "send nameplates". It should identify the minimum missing facts for each uncertain load, ask the smallest useful question, and, once the unknown is bounded enough by type/function/scenario, provide an approximate calculation and preliminary product cards.

The previous generator gate blocked all estimate-only generator cards. That prevented hallucinated exact recommendations, but it also blocked useful approximate selection after the buyer explicitly asked for a rough estimate.

## Acceptance Criteria

- AC1. If all loads are generic estimates and the uncertain load source is not bounded by type/function/scenario, generator catalog cards remain blocked.
- AC2. If the buyer gives enough context for a bounded preliminary estimate, such as a 220 V borehole pump plus household loads and asks for approximate minimum/reserve options, the calculator may mark the load basis as `bounded_assumption`.
- AC3. `bounded_assumption` generator load results allow preliminary catalog search/cards only when the answer contract marks `selectionReadiness.status="ready_for_preliminary_cards"` and keeps missing exact facts visible.
- AC4. Invalid tool payloads where a product class is passed as a load kind still block catalog search/cards.
- AC5. The implementation must not add user-text regex or private phrase matching for deciding buyer intent. LLM supplies the structured basis; code validates typed args and mechanical safety.
- AC6. Local verification must avoid OpenAI-dependent localhost checks because this environment returns `403 Country, region, or territory not supported`. Production behavior verification must happen after GitHub push and Railway deployment.

## Design

Add a structured `estimateBasis` field to tool args for `calculator.generatorLoad`:

- `exact_or_user_provided`: exact or explicitly provided load power exists.
- `catalog_or_web_fact`: facts were retrieved from catalog/web.
- `bounded_assumption`: LLM has enough bounded context to estimate a missing load approximately.
- `unbounded_guess`: LLM only has vague load names without bounded type/function/scenario.

Runtime behavior:

- `unbounded_guess` and invalid structured load kinds remain an unconfirmed basis.
- estimate-only loads with `bounded_assumption` are not treated as unconfirmed.
- estimate-only loads without `bounded_assumption` remain blocked.
- prompts instruct the planner to ask for minimum missing facts first, then use `bounded_assumption` for preliminary cards only after the unknown is bounded.

## Verification

Local:

- `npm test -- tests/agentManagerOrchestrator.test.ts`
- `npm run typecheck`
- `git diff --check`

Production after push/Railway:

- `npm run evals` only against production Railway/bakautprof URL.
- `npm run test:live:production` with production flags.
