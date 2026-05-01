# Generator load reference implementation report

Date: 2026-04-30
Scope: Bakaut AI consultant generator-load handling for unknown consumer power.

## Goal

Make the backend stop treating unknown consumer wattage as a dead end when the buyer names a recognizable class of load, e.g. "болгарка", "дрель", "свет", "насос". The implementation must use curated engineering reference values, not LLM guesses, and must keep uncertainty visible through `source: 'estimated_average'`.

## Implemented files

1. `src/ai/generatorLoadReference.ts`
   - Added a curated reference table for common generator consumers.
   - Added classification helpers:
     - `classifyGeneratorLoadText(text)`
     - `generatorReferenceLoadItemsFromText(text)`
     - `generatorReferenceSummaryForPrompt(text)`
   - Added source/provenance note for the baseline values.

2. `src/ai/assistant.ts`
   - Integrated `generatorReferenceLoadItemsFromText()` into:
     - `estimatedGeneratorPowerFromLoads()` for generator power estimation from free text.
     - `generatorLoadProfileFromText()` for durable selection-state load profile calculation.
   - The integration keeps existing explicit/past load handling and adds missing named consumers as estimated load items.

3. `tests/generatorLoadReference.test.ts`
   - Added regression tests for:
     - reference table completeness and required metadata;
     - "свет + болгарка или дрель, мощность не знаю";
     - unknown/high-risk "станок" not inventing power;
     - pump load preserving high startup-power logic.

4. `tests/generatorLoadReferenceEnrichment.test.ts`
   - Added regression tests for dynamic reference growth:
     - unknown named consumer triggers enrichment;
     - enriched consumer is persisted to JSON overlay and reused in later lookups;
     - persisted high-risk/`canEstimate:false` consumers do not trigger repeated web/LLM enrichment;
     - repeated forced/upserted enrichment updates existing entry instead of duplicating it.

## Dynamic enrichment implemented

The buyer flow is now:

1. First search the controlled static table in `src/ai/generatorLoadReference.ts`.
2. Then search the persisted runtime overlay JSON:
   - default: `data/generator-load-reference-overrides.json` under `RAILWAY_VOLUME_MOUNT_PATH` when present;
   - override: `GENERATOR_LOAD_REFERENCE_PATH`.
3. If a generator buyer names a consumer and neither static nor persisted table can produce a load item, `AssistantService.generateAnswer()` calls `enrichGeneratorLoadReferenceFromWeb()` before product selection.
4. The enrichment call uses OpenAI web search and requires strict JSON with:
   - load class;
   - aliases/consumer names;
   - running kW range;
   - conservative running kW;
   - starting factor / conservative starting kW;
   - confidence;
   - source note/caveat;
   - one useful follow-up question.
5. The parsed entry is sanitized, saved to the overlay, and immediately becomes available to `generatorReferenceLoadItemsFromText()` for this and later dialogues.

Safety rules in code:

- unknown/high-risk entries may be saved with `canEstimate: false`, but then they do not create a wattage item and do not trigger web/LLM lookup again on every later mention;
- persisted web-derived items use `source: 'web_average'`, not `explicit_user`;
- source notes are forced to carry `web_average:` provenance;
- exact buyer/model/nameplate power still remains stronger evidence than averages.

## Reference classes and values added

The first baseline includes 23 consumer entries across 7 classes:

1. `resistive_light_load`
   - lighting/LED/projection lights
   - typical running: 0.1-0.5 kW
   - startup factor: 1.0

2. `small_electronics_load`
   - router, chargers, cameras, laptop, TV/Hi-Fi
   - typical running: 0.05-0.5 kW
   - startup factor: 1.0

3. `motor_compressor_load`
   - refrigerator, freezer, surface pump, submersible pump, compressor, pressure washer, construction vacuum, concrete mixer
   - typical running: from 0.2 kW to 2.5 kW depending on device
   - startup factor: usually 2-5x
   - confidence is lower for pumps/compressors because model/nameplate matters.

4. `handheld_tool_load`
   - drill, angle grinder/УШМ, rotary hammer, circular saw, electric chain saw, jigsaw
   - generic handheld tool estimate: 1.5 kW running, up to 3.0 kW startup for grinder/rotary/circular-saw class
   - used as preliminary estimate, not as exact fact.

5. `heating_resistive_load`
   - microwave, kettle, resistive heater, heat gun, boiler/water heater, electric stove
   - startup usually near 1.0x, but running power can be high.

6. `workshop_industrial_load`
   - welder/inverter welding machine
   - not used for confident final estimate without model/current/phase.

7. `unknown_named_load`
   - станок, аппарат, оборудование, unknown machine/device
   - does not produce a power estimate; asks for class/model/nameplate/phase.

## Important behavior

- If the buyer says: "свет и иногда болгарка или дрель, мощность не знаю", backend now creates estimated load items:
  - lighting: 0.5 kW running / 0.5 kW starting;
  - handheld tool: 1.5 kW running / up to 3.0 kW starting.
- If the buyer says: "какой-то станок, мощность не знаю", backend does not invent wattage and returns no estimated load item for that unknown machine.
- Pump/compressor classes remain cautious because startup current dominates generator sizing.

## Sources used for baseline

The values are curated from public generator-sizing/wattage references reviewed before implementation:

- Generator Source, Power Consumption Chart.
- Fubag, таблица пусковых токов.
- Elec.ru generator sizing / пусковые токи guidance.
- PowerToolLab power-tool wattage chart.

The code stores this as a controlled baseline, not as a live web fact. Exact buyer-provided wattage/model should override estimates.

## Verification run

Passed:

```bash
npm test -- --run tests/generatorLoadReference.test.ts tests/generatorLoadReferenceEnrichment.test.ts
```

Result:

- 2 test files passed.
- 8 tests passed.

Earlier narrow baseline also passed:

```bash
npm test -- --run tests/generatorLoadReference.test.ts
```

Result:

- 1 test file passed.
- 4 tests passed.

Additional adjacent contract run:

```bash
npm test -- --run tests/generatorLoadReference.test.ts tests/generatorLoadReferenceEnrichment.test.ts tests/turnContract.test.ts
```

Result:

- 3 test files passed.
- 13 tests passed.

Known broader targeted run from the earlier implementation session:

```bash
npm test -- --run tests/generatorLoadReference.test.ts tests/recommendationRanking.test.ts tests/turnContract.test.ts
```

Result:

- `tests/generatorLoadReference.test.ts` passed.
- `tests/turnContract.test.ts` passed.
- `tests/recommendationRanking.test.ts` still has 11 failures in the current working tree.

The recommendation-ranking failures are not all caused by this change; several refer to pre-existing/stale test-hook and answer-sanity issues, e.g. missing `assistantTestHooks.resolveTurnContractForPlan` and power-range normalization failures. One generator-load expectation changed from 9 kW to 8 kW in the current local tree and needs follow-up review before claiming full regression green.

## Git/diff notes

The working tree already contains many unrelated modified files and CRLF/trailing-whitespace noise. I only intentionally changed/added:

- `src/ai/generatorLoadReference.ts`
- `src/ai/assistant.ts`
- `tests/generatorLoadReference.test.ts`
- `tests/generatorLoadReferenceEnrichment.test.ts`
- `docs/reports/2026-04-30-generator-load-reference.md`

`git diff --check` over just these files has no whitespace errors.

## Not done

- No push.
- No Railway deploy.
- No live UI/Railway verification.
- No claim that the whole Bakaut regression suite is green.

## Recommended next step

Before deploy: isolate unrelated working-tree changes/CRLF noise, then fix or explicitly baseline the existing `tests/recommendationRanking.test.ts` failures, especially the generator-load expectation that now reports 8 kW instead of 9 kW in the current tree.
