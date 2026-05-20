# Problems: LLM + Embedding Intent Finalization

## P1: live gate exposed missing generator sizing context

Status: fixed locally, pending production live verification.

During the real-widget live gate on 2026-05-20, production correctly switched the catalog/cards from the generator topic to vibroplates after the buyer changed focus. The remaining failure was the text-only generator sizing answer after the buyer supplied pump power: the product selection tool had calculated `requiredNominalKw=4.5`, but the answer context suppressed the load profile for `technical_answer` turns without cards. The LLM therefore wrote a broad `5-6 kW` recommendation instead of grounding the answer in the calculated minimum.

Fix:
- expose `productSelection.loadProfile` and `generatorSizingPolicy` to LLM text-only technical generator answers when the load-derived hard constraints are current;
- add answer guidance that treats the load calculation as an authoritative tool result;
- keep post-answer numeric repair strict whenever `generatorSizingPolicy` is present;
- permanently disable the canned `fast_technical_orientation` writer and remove the visible `Без звонка` canned preface from deterministic emergency summary text.

Local verification:
- `npm run typecheck`: PASS
- targeted tests: PASS, 240 tests
- `npm test`: PASS, 512 tests
- `npm run build`: PASS

Remaining verification:
- commit and push this fix;
- wait until Railway reports the new commit;
- rerun the production widget live gate through `https://bakautprof.ru/`;
- mark final only if generator sizing uses the calculated minimum and plate turn shows plate cards only.
