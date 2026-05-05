# Dialog 41 Catalog Shortlist Remediation Plan

## Source

Railway conversation `#41`, session `7e5f17f9-5ccd-4e62-b3dd-6ef21c276d2b`, May 5, 2026.

User path:

1. `нужен генератор`
2. `буду подключать холодильник и свет, нужен тихий небольшой и недорогой тысяч до 30, 220`
3. `Нет бюджет до 30 точно,холодильник у меня LG GA-B509MLSL`
4. `Что нету за 30 000 генераторов 2 квт закрытых?`

## Problem

The assistant eventually named the right exact match, `TOR KM2000is` for `26 540 RUB`, but the consultation path was weak:

- It did not show product cards at any turn.
- It incorrectly treated electric generator start as a hard requirement even though the user only discussed refrigerator startup/load.
- It initially told the user that a quiet closed inverter option under `30 000 RUB` was not a good/current fit, forcing the buyer to object.
- It mentioned less optimal expensive alternatives while missing closer alternatives such as `SUNREKA G1800iS`, `BISON BS2000IS`, and `TCC SGG 2400SI`.
- The final `turnPlan.answerGuidance` contradicted the final answer: the plan said there were no closed 2 kW generators under 30 000, while the answer named `TOR KM2000is`.

## Non-Goal

Do not implement a phrase patch for specific wording such as `нету ли`, `есть ли`, or `что нету`.

Those phrases are only examples of a broader semantic turn: the buyer is checking whether the catalog contains suitable products under active constraints and expects exact matches plus nearest alternatives.

## Target Behavior

For catalog availability and alternative-shortlist turns, the assistant should:

1. Preserve the active need and constraints from the dialogue.
2. Separate generator `startType` from load startup/current draw. Refrigerator startup must not become `startType=electric`.
3. Run structured catalog selection even when the planner classifies the turn as `answer_question/currentLineup/textOnly`, unless the turn is a pure factual/current-manufacturing question.
4. Build a shortlist in this order:
   - exact matches that satisfy hard constraints;
   - nearest alternatives with the smallest violation count;
   - alternatives slightly above budget;
   - alternatives slightly below/above target power;
   - only then expensive or distant alternatives.
5. Explain every compromise explicitly: price over budget, lower power, open casing, manual start, or missing confirmed data.
6. Show cards for the exact match and nearest alternatives when concrete products are named.

## Implementation Plan

1. Add a semantic helper for catalog shortlist turns.
   - It should detect the turn type by plan intent, active constraints, and buyer goal, not by one hardcoded phrase.
   - Inputs: `AssistantTurnPlan`, `ProductSelectionResult`, current user message, and active `needState`.
   - Output: whether structured selection may override `textOnly` and drive cards/shortlist.

2. Fix start-type extraction.
   - `startType=electric` only when the user explicitly asks for button start, electric starter, auto start, or no manual start.
   - Mentions of refrigerator startup, pump startup, starting current, or load startup must affect generator load calculation only.

3. Add nearest-alternative ranking.
   - Extend selection diagnostics with violation reasons and sortable severity.
   - Prefer small violations: `budget + 2-10k`, `power within nearby band`, `same casing/fuel`, same product class.
   - Avoid jumping to much more expensive alternatives while closer ones exist.

4. Allow cards for concrete catalog shortlist answers.
   - If the answer names exact or nearest catalog products, `productCards` should include those products.
   - Preserve existing blocks for service, spares, delivery, manufacturing/current-lineup proof questions, and pure text-only factual answers.

5. Add tests.
   - Regression: Dialog #41 final turn must find `TOR KM2000is`, show its card, and list nearest alternatives in price/distance order.
   - Negative: refrigerator startup must not set `startType=electric`.
   - Negative: true current-manufacturing/current-lineup factual questions must remain text-only when no recommendation is requested.
   - Ranking: closest alternatives under/near constraints beat distant expensive products.

6. Live verification.
   - Replay Dialog #41 on Railway or local live UI.
   - Expected first concrete product answer: `TOR KM2000is` shown as a card.
   - Expected alternatives: nearest compromises before expensive distant models.
   - Save protocol under `local-live-tests/`.

## Expected Result

The bot behaves like a sales consultant:

- It answers the buyer's objection directly.
- It does not make the buyer prove that the catalog has a product.
- It shows the exact matching product card when available.
- It gives nearby alternatives by rational compromise, not by random model mentions.
- It keeps LLM reasoning active, while the catalog engine provides factual grounding and ranking.
