# Spec: Exact Catalog Description Research

Task ID: `2026-05-21-exact-catalog-description-research`
Date: 2026-05-21

## Current Behavior

For exact-model technical questions such as "RD3910E starts with a key or button?", the research tool can use web search while underusing the exact BAKAUT catalog card `description`. This can make the answer treat a broad catalog spec like `manual / electric starter` as incomplete even when the product description contains the precise start-control mechanism.

## Structural Improvement

Use a structured LLM catalog-fact extraction pass before web search when exact target products are present in the BAKAUT catalog:

- pass exact product cards including `description` to a catalog-only extractor;
- accept high/medium confidence exact target facts from `catalog` when the extractor answers the buyer question and no conflicts remain;
- fall back to web research only when the catalog extraction is incomplete or conflicting;
- merge catalog extraction with web results so first-party catalog evidence is not discarded;
- pass product descriptions into answer/pre-send context so the agent can preserve checked catalog guidance;
- keep deterministic code limited to evidence routing/merge and pre-send safety, not semantic intent guessing.

## Non-Goals

- Do not add regex or keyword-only answer patches.
- Do not hard-code a single product answer.
- Do not change product ranking, product card selection, lead policy, delivery/stock policy, or public API shape.
- Do not run local OpenAI/Promptfoo gates, because this environment returns `403 Country, region, or territory not supported`.

## Acceptance Criteria

- AC1: Exact catalog products can be fact-extracted from `specs` and `description` before web search.
- AC2: Web research still runs when catalog extraction cannot fully answer or has unresolved conflicts.
- AC3: AgentManager answer and pre-send review receive product descriptions and can safe-rewrite an answer that omits confirmed checked research guidance.
- AC4: No new regex constructs are introduced.
- AC5: Local non-OpenAI gates pass: focused tests, `npm run lint:no-regex`, `npm run typecheck`, `npm run build`, and full `npm test`.
- AC6: After push, Railway production marker reaches the commit. Because this affects AI behavior, production Promptfoo/widget evidence is required before claiming the behavior change fully production-validated.

## Validation Plan

- Run focused tests:
  - `tests/productComparisonResearch.test.ts`
  - `tests/agentManagerComparisonResearch.test.ts`
  - `tests/agentManagerIntegrationSource.test.ts`
- Run no-regex, typecheck, build, and full unit suite.
- Push through git and verify Railway production marker.
- Run production eval/widget check if available through the existing production harness; otherwise record that production behavior validation remains pending.
