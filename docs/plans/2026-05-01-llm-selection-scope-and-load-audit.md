# LLM selection-scope and generator-load audit plan — 2026-05-01

## Root cause

The last browser dialogue exposed a manager-quality issue after the load scenario fix: when the buyer asked a follow-up like “which of the two should I take first?”, the system could perform a fresh catalogue ranking and replace the two discussed models.

This should not be solved by a list of trigger words (`из двух`, `этот`, `второй`, `запасной`). The root cause is architectural: the LLM planner already returns semantic `contextScope` and `searchScope`, but downstream selection does not strictly honor `searchScope='previousSelectionOnly'` as a hard product scope. As a result, the semantic decision can be lost and the selection engine may broaden the set anyway.

## Generator load audit

Current load values come from deterministic controlled layers, not from final prose:

1. `src/ai/generatorLoadReference.ts`
   - curated classes and aliases;
   - typical running/starting watts;
   - source/provenance (`estimated_average`, `web_average`, confidence, source notes);
   - role-aware detection: active/staged/excluded/context.
2. `generatorReferenceLoadItemsFromText(text)`
   - converts only role=`active` detections into electrical load items.
3. `generatorLoadProfileFromText(...)` in `src/ai/assistant.ts`
   - merges current profile + active reference items + deterministic explicit branches;
   - холодильник fallback: 0.15 kW running / 1.0 kW starting;
   - свет fallback: currently 0.8 kW running/start unless explicit;
   - насос fallback: pump type estimate + starting estimate;
   - simultaneous starting only if `hasAffirmativeSimultaneousStarting(text)` returns true.
4. `calculateGeneratorLoadProfile(...)`
   - total running = sum running kW;
   - starting = running + largest starting extra by default;
   - if affirmative simultaneous start, starting = running + all starting extras;
   - required nominal = ceiling of required starting to 0.5 kW.

The earlier 7.5 kW bug was caused by non-simultaneous loads being promoted into this active profile. That is fixed by role-aware load mentions and affirmative simultaneity.

## Target behavior

Every buyer turn is semantically analyzed by the LLM planner. Downstream code must obey the planner’s structured intent:

- If LLM sets `searchScope='previousSelectionOnly'` or `contextScope='previousSelection'`, selection must operate on the current selected/matched set only.
- The engine may reorder the current set for the buyer’s stated criterion, but must not introduce new catalogue products.
- A fresh or broadened catalogue selection is allowed only when the LLM sets `searchScope='broadenAlternatives'` / focused new need, or the buyer clearly changes requirements and the planner encodes that.
- Heuristic phrase matching may remain only as fallback when the LLM is unavailable; it must not be the primary contract.

## Implementation steps

1. Add RED unit regression with a synthetic LLM plan:
   - current selection has two generator IDs;
   - larger catalogue contains cheaper/newer alternatives;
   - plan uses `searchScope='previousSelectionOnly'` and `contextScope='previousSelection'`;
   - expected visible/selected products are only the previous two, not new catalogue products.
2. Patch `selectProductsForTurn(...)` to derive a scoped candidate pool from semantic LLM plan scope.
3. Patch planner prompt to make the semantic rule explicit: when buyer continues discussing current cards, set `previousSelectionOnly`; only broaden on explicit request for alternatives/replacement/better options.
4. Keep fallback phrase helpers as fallback only, not as the source of truth.
5. Re-run focused tests, targeted tests, typecheck/build/diff.
6. Run new browser dogfood as a neutral buyer: 10 turns, each next buyer message derived from the assistant’s actual previous answer; no meta-instructions like “show 2 and hide rest”.

## Green criteria

- Previous-selection regression is GREEN.
- Existing generator load tests remain GREEN.
- Typecheck/build/diff pass.
- Browser dialogue does not replace the discussed pair on a current-selection follow-up unless the buyer asks for replacement/alternatives.
- Browser buyer messages are natural and based on assistant answers, not pre-baked UI contract wording.
