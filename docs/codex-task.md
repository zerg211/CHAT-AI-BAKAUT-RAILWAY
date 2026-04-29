# Codex Task

## 2026-04-29 — Next remediation task from AI-manager audit

Goal: make the chat behave more like one coherent AI sales manager and less like overlapping rule layers.

Do not add trigger-word fixes. Keep remediation narrow and architecture-first.

Task:
1. Introduce a typed `TurnContract` / `ResolvedTurn` interface near shared AI types. It must unify:
   - buyer intent/action;
   - context scope;
   - search scope;
   - knowledge requirements;
   - product-selection state;
   - render policy for cards/lead form/text-only;
   - diagnostics/trace.
2. Refactor `src/ai/assistant.ts` so downstream stages consume this one contract instead of independently checking planner fields, regex classifiers, selection state, card policy, and answer mode.
3. Do not remove safety/business constraints. Move them into the contract resolution stage.
4. Preserve current behavior with tests before behavior changes.
5. Add tests for at least:
   - changed requirement resets/decays previous need;
   - generator unknown load asks clarifying question instead of final recommendation;
   - accessory/consumable follow-up does not show the original core product as the main card;
   - current-lineup factual question stays text-only and uses web when required;
   - purchase intent opens lead flow without claiming an order was already created.

Verification:
- `npm run typecheck`
- `npm test` after reinstalling/fixing local `node_modules` optional Rollup dependency if needed
- local live chat protocol in `local-live-tests/*.local.md` for one natural buyer dialogue.
