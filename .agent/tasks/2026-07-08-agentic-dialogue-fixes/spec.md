# Agentic Dialogue Fixes Spec

Date: 2026-07-08

## Problem

Production dialogues #1706, #1707, and #1708 show that the assistant can understand parts of the buyer intent, but later runtime layers break the consultation:

- lead/commercial repair can replace a meaningful answer with one generic handoff sentence;
- battery portable power stations are treated as generic generators, so gasoline/diesel generators can appear for a battery-station request;
- watt values such as `800 Вт` are not enforced as numeric product requirements;
- answer text can name products that are not shown as product cards;
- lead form submissions are not reflected in the dialogue state, so the assistant can ask for contact again after a lead was already submitted.

The fix must not add phrase scripts for the three exact dialogues. The implementation must strengthen general agentic architecture: LLM decides semantic intent and hard requirements; deterministic code validates catalog facts, product traits, card consistency, and lead state.

## Acceptance Criteria

AC1. Battery/portable-power requests are represented and enforced as structured product traits, not as a special response phrase. If the current semantic request requires an аккумуляторная электростанция / battery-powered station, visible cards must not include gasoline or diesel generators unless explicitly labeled as unsuitable/compromise and not shown as a primary fit.

AC2. Watt-based product requirements are normalized. Requests like `800 Вт`, `1000 ватт`, and `1-1,8 кВт` must participate in numeric filtering/ranking for generator/station cards.

AC3. Mixed product-selection plus delivery/stock/region questions must answer the product-selection part first when useful catalog matches exist, then add a safe specialist/logistics handoff. Lead repair must not replace the product-selection answer with a generic handoff.

AC4. Pure location/company/warehouse questions must not be mechanically rewritten into the generic availability/delivery form text. They must either answer known facts or say the exact warehouse/location condition must be checked without pretending selected positions exist.

AC5. Text/card consistency is enforced. Products named in a recommendation answer must either be present in visible cards or be explicitly described as not shown/not suitable; filtered-out products must not remain as primary recommendations.

AC6. After a lead form submission for a session, subsequent assistant behavior must have access to the fact that contact was submitted and must not ask for the same contact again as if none existed.

AC7. Add regression tests for the broken scenarios and at least two phrasing variants. Tests must be local-safe and not require OpenAI.

AC8. Verification artifacts must include `evidence.md`, `evidence.json`, raw command outputs, and production live protocols after commit+push and Railway deployment. Production dialogue review must be holistic across full conversations, not isolated single answers.

## Non-goals

- No manual Railway deploy.
- No hard-coded final answer scripts for exact buyer phrases.
- No local OpenAI behavior validation as readiness proof.
