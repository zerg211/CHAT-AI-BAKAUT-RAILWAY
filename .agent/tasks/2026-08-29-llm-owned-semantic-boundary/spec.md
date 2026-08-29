# LLM-owned semantic boundary

Status: FROZEN before implementation
Date: 2026-08-29

## Objective

Make the deployed `agent_manager` runtime use the LLM contract as the sole
authority for buyer meaning. Deterministic code may validate and execute the
structured decision, but must not infer intent, product role, requirement
meaning, number meaning, alternatives, load operation semantics, or answer
conclusions from raw buyer text.

## Scope

- The production-reachable `agent_manager` path selected by `src/routes/chat.ts`
  and implemented in `src/ai/assistant.ts` / `src/ai/agentManagerOrchestrator.ts`.
- Product mention and product-intent resolution.
- Selection requirements, preferences, alternatives, ranking objectives, and
  visible-card rationale.
- Generator load semantics used before deterministic arithmetic.
- Research planning and source-backed conclusions.
- Lead intent and action authorization boundary.
- Existing recovery and retry behavior when the typed LLM decision is missing,
  inconsistent, or invalid.

The untracked `src/ai/v2/` workstream is outside this task and must not be
modified or used as proof for the deployed runtime.

## Acceptance Criteria

- AC1. On every production-reachable turn, raw buyer text is interpreted only by
  the LLM semantic decision. Code does not use regex, keyword matching, token
  shapes, or canned branches to infer product class, product-mention role,
  requirement meaning, active/new need, number meaning, approved alternatives,
  load operation mode, research intent, or lead intent.
- AC2. Product selection requires structured LLM authority. Missing or
  inconsistent `selectionPolicy`, product mentions, or selection semantics
  cause a bounded LLM replan/repair or a safe non-semantic failure; they never
  activate legacy keyword inference or implicit task-derived weight ranges.
- AC3. Code does not mutate a valid planner decision into a different semantic
  decision. Electric start versus automatic start, final versus preliminary
  fit, target versus context products, and new versus existing need are decided
  by the LLM contract. Deterministic validation may reject contradictions and
  request LLM repair.
- AC4. Generator arithmetic consumes explicit per-load typed semantics returned
  by the LLM, including operation/co-running behavior and provenance. Regex over
  evidence or the full message does not decide whether a value is running,
  starting, occasional, separate, or simultaneous. Numeric defaults may only be
  explicitly marked estimates authorized by the LLM contract.
- AC5. Research planning remains mandatory when a missing fact can affect
  selection, comparison, or recommendation. Attribute-name heuristics do not
  suppress conditional research. Code validates source/evidence references but
  does not replace an LLM conclusion with a canned semantic answer.
- AC6. Missing catalog data is not treated as a proven conflict. Products with
  unknown price or another mandatory attribute remain preliminary candidates
  for research unless a confirmed value violates a hard requirement.
- AC7. Deterministic code remains authoritative for schemas, evidence
  integrity, catalog identity and confirmed facts, proven-conflict filtering,
  sorting according to typed LLM objectives, arithmetic, action authorization,
  business restrictions, contact validation, safety, persistence,
  idempotency, checkpoints, and tool execution.
- AC8. Customer-visible product rationale comes from the LLM answer contract.
  Code neither invents a selection reason nor displays a deterministic canned
  reason when the LLM omitted it.
- AC9. Regression tests prove the removed fallback paths cannot regain semantic
  authority. Targeted tests, full tests, typecheck, build, no-regex guard, and
  `git diff --check` pass against the current codebase without local OpenAI
  calls.
- AC10. After commit and push, Railway deploys from GitHub and a fresh adaptive
  dialogue is completed through the real widget on `https://bakautprof.ru/`.
  The protocol audits each visible answer, cards, turn contract, tools,
  warnings, recovery/fallback state, and lead state, with zero buyer and code
  issues.

## Non-goals

- Do not weaken catalog, evidence, source, safety, or business-policy checks.
- Do not add phrase-specific production replies or replacement keyword rules.
- Do not promise exact stock, discounts, delivery, special conditions, or
  timing.
- Do not manually deploy to Railway.
- Do not modify or reset unrelated dirty-worktree changes.

## Required structured authority

The LLM contract must provide enough typed data for code to execute without
reading semantic meaning from raw text:

- active need and whether prior requirements are retained, superseded, or reset;
- product mentions with surface text, canonical identity/name, product class,
  and role (`target`, `context`, `alternative`, or `exclude`);
- hard requirements, preferences, buyer-approved alternatives, ranking
  objectives, and requested result count;
- each number's semantic kind, unit, target entity, certainty, and evidence span;
- per-load running/starting values, estimate authorization, operation mode,
  co-running group, and provenance;
- research questions and canonical attributes whose answers affect the turn;
- lead authorization, source, requested fields, and next action;
- selected product IDs and customer-visible rationale for shown cards.

## Verification

1. Static audit of production-reachable raw-text classifiers and fallback calls.
2. Focused unit and integration tests for each removed path.
3. Full repository release gate without OpenAI calls.
4. Fresh verification pass against current files and current command output.
5. Commit and push only intended files.
6. Wait for matching production marker and run the required live widget audit.
7. Store `evidence.md`, `evidence.json`, raw command output, live protocol, and
   `problems.md` if any criterion is not PASS.

## Done Definition

Every AC is independently verified as PASS. A local green suite without the
fresh production widget audit is not completion.
