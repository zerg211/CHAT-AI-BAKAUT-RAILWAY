# Spec: derived strict constraints in live product selection

Status: FROZEN before implementation

## Production evidence

- Production widget: `https://bakautprof.ru/`, session `678e31eb-6899-4092-83b0-8350fd6a47b7`.
- Buyer supplied a 1.1 kW borehole pump, a 1.5 kW angle grinder, single-phase 220 V, simultaneous operation, and no autostart.
- `calculator.generatorLoad` deterministically produced `requiredNominalKw = 5.5`.
- Catalog filtering retained single-phase 9 kW and 15 kW products without autostart.
- The planner also encoded simultaneous operation as the strict requirement `r5:simultaneous_operation_pump_and_angle_grinder`.
- The generic strict-requirement guard treated that derived operating condition as an unsupported product attribute, suppressed all products, and replaced the useful answer with a vague refusal.

## Intended boundary

- The LLM owns semantic interpretation: which loads operate together and which typed calculation is required.
- Deterministic code owns typed calculator execution, derived power thresholds, catalog filtering, and proof that a strict requirement was actually consumed by a successful tool result.
- Unknown strict product attributes must continue to fail closed.

## Acceptance criteria

- AC1: Selection requirements explicitly distinguish product-attribute verification from typed-tool-derived verification without relying on phrase-specific regex or requirement names.
- AC2: A strict typed-tool-derived requirement is accepted only when it references a matching required typed tool request and that request has a successful, mechanically valid result.
- AC3: For `calculator.generatorLoad`, deterministic proof requires a finite positive `requiredNominalKw`, and candidate products remain subject to the derived nominal-power filter.
- AC4: A strict derived simultaneous-operation requirement that is successfully consumed by `calculator.generatorLoad` does not independently suppress otherwise eligible generator products or visible cards.
- AC5: A missing, failed, mismatched, or malformed tool result still suppresses products and produces a precise blocker.
- AC6: An unknown strict product-attribute requirement continues to fail closed exactly as before.
- AC7: Planner instructions and structured JSON schema explain the verification boundary and require an explicit verification descriptor for newly planned requirements; legacy persisted contracts remain parseable and default to fail-closed product-attribute behavior.
- AC8: The safe rewrite for a real unverifiable strict constraint names the exact missing constraint/evidence instead of saying only `one parameter`.
- AC9: Unit/regression tests cover success, failed tool, wrong tool request, malformed result, legacy unknown requirement, card selection, answer-product evidence, and review behavior.
- AC10: Full local verification passes: typecheck, build, complete test suite, agentic eval, no-regex gate, audit, and diff check.
- AC11: Changes are committed and pushed to GitHub; Railway deploy marker matches the pushed commit.
- AC12: The adaptive production dialogue is repeated through the embedded widget on `bakautprof.ru`; the buyer-visible answer, product cards, `turnContract`, tool artifacts, warnings, and review trace are audited and saved in a production protocol.

## Non-goals

- No phrase-specific exception for `pump`, `angle grinder`, or this exact live sentence.
- No weakening of fail-closed handling for unknown strict product attributes.
- No promise of stock, delivery, discounts, or commercial terms.
- No manual Railway deployment.
