# Problems: LLM + Embedding Intent Finalization

## P1: live gate exposed missing generator sizing context

Status: fixed and production-verified.

During the real-widget live gate on 2026-05-20, production correctly switched the catalog/cards from the generator topic to vibroplates after the buyer changed focus. The remaining failure was the text-only generator sizing answer after the buyer supplied pump power: the product selection tool had calculated `requiredNominalKw=4.5`, but the answer context suppressed the load profile for `technical_answer` turns without cards. The LLM therefore wrote a broad `5-6 kW` recommendation instead of grounding the answer in the calculated minimum.

Fix:
- expose `productSelection.loadProfile` and `generatorSizingPolicy` to LLM text-only technical generator answers when the load-derived hard constraints are current;
- add answer guidance that treats the load calculation as an authoritative tool result;
- keep post-answer numeric repair strict whenever `generatorSizingPolicy` is present;
- permanently disable the canned `fast_technical_orientation` writer and remove the visible `Без звонка` canned preface from deterministic emergency summary text.

Verification:
- `npm run typecheck`: PASS
- targeted tests: PASS, 24 tests
- `npm test`: PASS, 521 tests
- `npm run build`: PASS
- production commit `4bf48dc27348b5ea3d15f1e85b741d356b811aea`: deployed
- production widget live gate through `https://bakautprof.ru/`: PASS

Final production result:
- pump update answer used the calculator-derived minimum `4.5 kW` and practical `5 kW` class;
- vibroplate turn did not inherit generator context;
- explicit vibroplate catalog request showed vibroplate cards only;
- admin metadata showed no fallback/recovery.
