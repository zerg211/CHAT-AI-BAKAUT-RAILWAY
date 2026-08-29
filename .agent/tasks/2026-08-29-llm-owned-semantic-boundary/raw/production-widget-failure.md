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
