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

## Repair-budget follow-up failure

- Deployed commit: `f7ee0ef3d6e4e9645fedbbe8ebff8ba1f3107109`
- Session: `990bb45f-d0e3-4139-9c10-b0dccf25da49`
- Failed turn: `63e96ca0-9215-4531-81b1-4adb0d92b1f4`
- Buyer-visible result: one empty response among nine turns; later turns recovered and showed one generator card and two plate cards.

Attempt 1 issues were `conditional_research_plan_missing` and `active_requirement_mismatch:generator_load_scenario`. Attempt 2 repaired those but produced missing/unexecutable pump load issues. Attempt 3 restored the load but reintroduced `conditional_research_plan_missing` and changed the pump `source`. Remaining wall time was 108535 ms, so this was correction regression rather than budget exhaustion.

## Cumulative-history follow-up failure

- Deployed commit: `a50f70e96adb444949129ab1732c313b13f2f257`
- Session: `37924cf9-44d4-43bb-aade-fdcea4939079`
- Failed turn: `bdab556e-a2cb-4592-8277-3534ad4685b9`
- Buyer-visible result: one empty response at first clarification among eight turns; later seven turns recovered and showed three generator cards, four plate cards, and lead capture.

Attempt 1 issues were `required_catalog_tool_missing` and `active_requirement_mismatch:generator_loads`. Attempt 2 fixed catalog but hallucinated five product mentions with `product_mention_evidence_not_in_current_message` and kept `active_requirement_mismatch:generator_loads`. Attempt 3 fixed mentions but introduced `required_tool_request_missing:calculator.generatorLoad` and `typed_requirement_tool_mismatch:req_loads` for a hard `generator_loads` fact. Remaining wall time was 109441 ms, so this was also correction oscillation, now on the initial clarification turn.

Required fix: add explicit LLM guidance for `generator_loads` vs `generator_load_scenario` and for missing `calculator.generatorLoad` while keeping cumulative history and fail-closed validation.

## Writer FactsUsed Follow-up Failure

- Deployed commit: `7908deb8a8bd492072bb22a4e83a1248cf99930b`
- Session: `79ba351c-d491-41cd-8e2e-5e8df1126d0a`
- Failed turn: `5532bcff-d90e-4e4c-ba2b-37a79d661534`
- Buyer-visible result: one empty response at plate switch among nine turns; later turns recovered and showed two generator cards, two plate cards, and lead capture.

Writer produced 3 `factsUsed` entries with empty `sourceEventIds`, failing `AnswerContractSchema` validation (`too_small` at `factsUsed.*.sourceEventIds`) even though semantic decision was valid on first attempt. Remaining wall time was ample. Required fix: sanitize writer `factsUsed` by filtering entries with empty `sourceEventIds` in `parseAnswerContractModelOutput`, keeping planner validation fail-closed.

## Preliminary Load Follow-up Failure

- Deployed commit: `f8d0baae77f3c31007d7a2dd86680f35cd6be3c5`
- Session: `5de0bdbc-c227-4204-8bf4-f2187ff60fc0`
- Buyer-visible result: six answers without generator cards, followed by three timed-out catalog turns. The 20-minute harness command ended before a protocol could be completed.

Admin audit found two upstream causes. The first selection used `nominal_power_kw` as a strict numeric product attribute with `value=true`; semantic validation did not reject that malformed shape, and catalog filtering suppressed every candidate. Later selections had a bounded estimate for the pump, boiler, and refrigerator plus lighting with no numeric value. `loadsFromArgs` added both `generator_load_bounded_basis_incomplete` and `generator_load_unbounded_guess`, causing deterministic preliminary-card suppression even though missing lighting power was not a proven conflict. The final three traces stop at `tool_started:catalog.search` and the turns later fail with `agent_manager_generation_aborted_or_timeout`.

Required fix: reject structurally invalid strict requirements before tool execution so the LLM correction loop repairs them, and classify omitted load values as incomplete rather than unbounded. Keep final-fit validation blocked until all required load facts are confirmed.

## Availability Handoff Follow-up Failure

- Date: 2026-08-30
- Deployed commit: `5e18d505950654c1791c6d8eafd674419b8bb158`
- Session: `4bf4478c-dd95-467e-8d24-9f281e1912a1`
- Failed turn: `83e9c047-eabd-47c0-afcd-4a654f4ec712`
- Buyer message: `Как с доставкой до Азова и наличием, если оформлять вместе генератор и виброплиту? Это можно уточнить?`
- Buyer/code audit: 1 issue each; buyer goal and lead audit passed.

The turn returned no assistant message. Attempt 1 was schema-invalid because an unauthorized lead carried authorization fields. Attempt 2 failed `product_mention_evidence_not_in_current_message:1`. Attempt 3 failed `opened_need_action_mismatch:continue` and `required_tool_request_missing:lead.capture`, with 120563 ms still remaining. The next buyer turn correctly produced a form offer and the subsequent lead was captured, confirming that the defect is the semantic correction guidance for the pre-contact handoff rather than execution or persistence.

Required fix: tell the LLM correction to remove `lead.capture` from `requiredToolKinds/toolRequests` when contact authorization is absent and preserve an availability/delivery handoff for writer `leadAction="offer_form"`; add exact guidance for reconciling `need.opened` with `needAction`. Do not infer buyer meaning or rewrite the decision in code.

## Multi-class Catalog Follow-up Failure

- Date: 2026-08-30
- Deployed commit: `8fe9d7759af90bf72a1f56ebab5f3a22364ca08a`
- Session: `4fa03331-1802-43d9-baca-8132f636b7fd`
- Failed turn: `3d12b999-229f-48ec-9c15-6eeaebf7553f`
- Buyer message: `Покажите, пожалуйста, виброплиты из каталога в районе 80-100 кг и скажите насчет коврика для плитки.`
- Buyer/code audit: 1 issue each; buyer goal and lead audit passed.

The prior availability/delivery defect is resolved in this session: the corresponding turn returned a correct form offer, and lead capture completed. The plate-plus-accessory turn produced no assistant message. Attempt 1 issues were `conditional_research_plan_missing` and `catalog_tool_product_class_mismatch:mat_search:plateAccessory:plate`; attempts 2 and 3 retained only the class mismatch. The planner consistently represented a primary plate search and a separate accessory search, but deterministic validation assumed all catalog requests had to equal the single primary selection class.

Required fix: preserve one primary selection policy while allowing a secondary catalog class only when the LLM contract supplies a current-message exact-target product mention for that class. Continue rejecting unexplained cross-class requests and validating mention evidence; do not infer accessory meaning from buyer text in code.
