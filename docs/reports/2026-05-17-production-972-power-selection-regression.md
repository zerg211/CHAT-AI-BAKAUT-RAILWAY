# Production dialog 972 power-selection regression

## Scope

Production dialog: `Диалог #972`, session `83ae9168-4393-415a-b8af-572e7f062eb5`.

User-reported failure: buyer asked `Есть в наличии ТСС 10 кВт бензин?`, but the assistant answered that it did not see an exact 10 kW TSS and showed 2.0-2.8 kW cards.

Sanitized artifact: `local-live-tests/2026-05-17-production-972-detail.sanitized.json`.

## What happened

The buyer made two turns:

1. Asked to compare Baudouin and Doosan engines.
2. Switched to a new generator availability request: `Есть в наличии ТСС 10 кВт бензин?`.

The second turn was not completed normally. The turn status was `recovered`:

- `errorCode`: `generation_failed`
- `errorMessage`: `AI answer generation failed: empty_answer`
- recovery then generated the final assistant response from saved `session.needState`.

The saved need state correctly recognized the buyer intent at a semantic level:

- product class: generator;
- brand: TSS / ТСС;
- fuel: gasoline;
- requested power: 10 kW.

But the structured selection criteria stored the power incorrectly:

```json
{
  "nominalPowerKwMax": 10,
  "provenance": {
    "nominalPowerKwMax": "planner"
  },
  "mustHaveTraits": ["ТСС", "бензиновый", "около 10 кВт"]
}
```

There was no `nominalPowerKwMin`. The code therefore interpreted the request as `up to 10 kW`, not as `10 kW target`.

## Why 2 kW cards passed

The ranking/filtering code treated max-only nominal power as a valid upper bound. In that state, 2.0 kW and 2.8 kW are technically `<= 10 kW`, so they passed the deterministic selector.

The product card reasons prove this:

- `ТСС SGG 2000N (2,0 кВт)` reason: `Мощность около 2 кВт соответствует заданному диапазону`.
- `ТСС SGG 2800N (2,8 кВт)` reason: `Мощность около 2.8 кВт соответствует заданному диапазону`.

So this was not the LLM independently deciding that 2 kW is a good replacement for 10 kW. The LLM/need extractor produced an underspecified structured number, then deterministic code accepted the wrong interpretation, and recovery reused the saved bad card set.

## Root cause

The bug is at the boundary between semantic need extraction and deterministic selection:

- `src/ai/assistant.ts` applied a semantic `powerKw` requirement with `{ amount: 10, max: 10 }` as max-only.
- `generatorPowerFromSelectionHardConstraints` and `powerCriteriaFromSelection` did not recover a missing min from single-power evidence in `mustHaveTraits`.
- `productCardsFromRecoveredSelection` trusted `session.needState.selectedProductIds` and rebuilt cards from the same max-only criteria during recovery.

## Fix

Implemented in `src/ai/assistant.ts`:

- added `textMarksPowerUpperBound`;
- added `exactSinglePowerFromCriteriaText`;
- added `completeSingleTargetNominalPower`;
- semantic `powerKw` requirements with a single `amount` now become `nominalPowerKwMin=amount` and `nominalPowerKwMax=amount` unless the evidence clearly says `до / не больше / max / up to`;
- max-only hard constraints with `mustHaveTraits` like `10 кВт` are completed into a single target before product filtering;
- this applies to normal selection and recovery selection.

Added regression coverage in `tests/recommendationRanking.test.ts`:

- a recovered/semantic state with `nominalPowerKwMax=10` and `mustHaveTraits=["ТСС", "бензин", "около 10 кВт"]` no longer accepts a 2 kW generator;
- a 10 kW generator still passes.

## Verification

Local checks passed:

- `npm.cmd run typecheck`
- `npm.cmd test -- tests\recommendationRanking.test.ts tests\agenticCycle876.test.ts`
- `npm.cmd test`

Production live verification was not rerun because production OpenAI currently returns `insufficient_quota`. After billing is restored, rerun a short live widget check for:

`Есть в наличии ТСС 10 кВт бензин?`

Expected behavior:

- no 2 kW cards;
- if exact 10 kW exists in catalog, show it first;
- if exact 10 kW is absent, say that exact 10 kW is not visible in the current catalog data and offer only near-power alternatives, not low-power generators.
