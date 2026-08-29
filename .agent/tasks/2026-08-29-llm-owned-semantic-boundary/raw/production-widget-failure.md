# Production Widget Failure

- Date: 2026-08-29
- Site: `https://bakautprof.ru/`
- API: `https://bakaut-chat.vexr.dev`
- Deployed commit: `af020f228e2058612ffc02c39f6e60070cdd2dd9`
- Session: `78cf118b-fd3b-45bf-b654-1cd143f4e1fb`
- Verdict: FAIL

## Buyer-visible result

Turns 1-3 returned useful clarification responses. Turns 4-8 produced no assistant answer and no cards. Turn 9 eventually returned two preliminary 3 kW generator cards, but the five failed turns make the dialogue invalid for AC10.

## Admin result

Turns 4-8 have `status=failed`, `errorCode=agent_manager_generation_failed`, and no assistant message. Their final validation errors were:

1. `generator_load_source_missing:1`, `generator_load_source_missing:2`, `generator_load_source_missing:3`, `typed_requirement_coverage_missing:req_power:calc_load_1`
2. `conditional_research_plan_missing`
3. `required_tool_request_missing:web.researchProductFacts`, `required_web_tool_missing`, `conditional_research_plan_missing`
4. `typed_requirement_coverage_missing:req_nominal_power:calc_generator_load`, `generator_load_scenario_fact_missing`, `active_requirement_mismatch:boiler_type`
5. `generator_load_source_missing:1`, `generator_load_source_missing:2`, `generator_load_source_missing:3`, `active_requirement_mismatch:generator_load_scenario`

The traces show different issue sets on the first and correction attempts. The correction request contained `semanticValidationIssues` but not the rejected `AgentSemanticDecision`, so the model had no typed object to edit and replanned independently.

## Required fix

Pass the rejected `AgentSemanticDecision` together with validator issues to the one bounded LLM correction attempt. Keep all validators fail-closed and do not mutate the planner decision in deterministic code.

## Follow-up failure

- Deployed commit: `71c30a070f4d3b985bd88c84d99898569fbab946`
- Session: `359b8cf9-0a20-45ae-9ca7-4fd48bde957e`
- Result: turns 2-9 failed with no assistant message.

The rejected decision was now available to correction, but recurring errors showed that structured output still allowed `source=null` even though validation and generator execution require non-null provenance. Other corrections changed the right object but lacked actionable descriptions for requirement mirroring, exact load-scenario equality, conditional web planning, and current-message product evidence.

## Schema/guidance follow-up failure

- Deployed commit: `08eebebed0dd8474d9d93960d24b745972ab399f`
- Session: `7c53864a-4e20-4f67-ba61-774210229ec8`
- Result: clarification turns 2-3 completed, but selection turns failed.

Production traces converged to `active_requirement_mismatch:generator_load_scenario` and `generator_load_scenario_load_semantics_mismatch:boiler:газовый котёл с электроникой`. One correction often repaired conditional research and exposed the deeper invariant only on its result, so a second bounded correction is required. The mismatch diagnostic also needs exact field names rather than only the load identity.
