# Ledger P0 builder evidence

Дата: 2026-08-09

Область builder-а:

- `src/ai/dialogueLedgerReducer.ts`;
- узкие ledger-участки `src/ai/agentManagerOrchestrator.ts`: compact state, reducer JSON schema/prompt, snapshot load fallback;
- targeted tests в `tests/dialogueLedgerReducer.test.ts`, `tests/openAIAgentManagerModel.test.ts` и один malformed-snapshot test в `tests/agentManagerOrchestrator.test.ts`.

`tests/agentManagerOrchestrator.test.ts` одновременно дополнялся sibling-builder-ом по product referents. Этот документ приписывает текущему builder-у только тест `falls back to authoritative full replay when a snapshot has malformed nested state`.

## RED

1. `npm.cmd test -- --run tests/dialogueLedgerReducer.test.ts`

   До implementation: exit 1, 4 failed / 11 passed.

   - mandatory empty `rejectedProductIds` стерли `['too-heavy', 'too-expensive']`;
   - mandatory empty `constraints` и `openQuestions` стерли сохранённые значения;
   - поздний `fact.observed` вытеснил `fact.confirmed` и compact state не содержал epistemic metadata;
   - malformed nested snapshot был принят unsafe cast-ом вместо ошибки.

2. `npm.cmd test -- --run tests/openAIAgentManagerModel.test.ts`

   До compact/schema/prompt fix: exit 1, compact fact не содержал `eventType`, `source`, `confidence`, `createdAt`.

3. `npm.cmd test -- --run tests/agentManagerOrchestrator.test.ts -t "falls back to authoritative full replay"`

   До owning-layer fallback: exit 1 с `invalid_dialogue_ledger_snapshot` из `loadDialogueLedgerContext`.

## Implementation

- Need arrays получили независимые typed operations `merge | replace | clear`:
  `constraintsUpdateMode`, `openQuestionsUpdateMode`, `rejectedProductIdsUpdateMode`.
- Legacy events остаются читаемыми. Пустой untyped update сохраняет состояние; legacy non-empty constraints/questions сохраняют прежнюю replace-семантику; legacy rejection additions merge-ятся, поэтому untyped update не может снять ранее записанный отказ.
- `ReducedFact` сохраняет `eventType`, `source`, `confidence`, `createdAt` и evidence. `fact.observed` с confidence 1 детерминированно понижается до 0.5 с warning и не вытесняет активный `fact.confirmed` того же scoped key.
- Наблюдения остаются в `uncertainInferences`; в `confirmedFacts` и legacy hard constraints попадают только `fact.confirmed`.
- Nested snapshot state валидируется Zod-схемами. При malformed state/recent events orchestrator не использует частично доверенный snapshot, а перечитывает authoritative ledger events с cursor 0 и добавляет warning `invalid_snapshot_replayed_from_events`.
- Reducer structured-output schema и prompt требуют явные list operations и fact confidence; compact planner/reducer input сохраняет fact provenance.

## GREEN

Финальные targeted проверки после последних правок:

- `npm.cmd test -- --run tests/dialogueLedgerReducer.test.ts` — exit 0, 15/15;
- `npm.cmd test -- --run tests/openAIAgentManagerModel.test.ts` — exit 0, 2/2;
- `npm.cmd test -- --run tests/agentManagerOrchestrator.test.ts -t "rehydrates a snapshot|falls back to authoritative full replay"` — exit 0, 2 passed;
- `git diff --check -- src/ai/dialogueLedgerReducer.ts src/ai/agentManagerOrchestrator.ts tests/dialogueLedgerReducer.test.ts tests/openAIAgentManagerModel.test.ts tests/agentManagerOrchestrator.test.ts` — exit 0.

Connected check на coherent ledger revision:

- `npm.cmd test -- --run tests/dialogueLedgerReducer.test.ts tests/agentManagerContracts.test.ts tests/openAIAgentManagerModel.test.ts tests/agentManagerOrchestrator.test.ts` — exit 0, 173/173.

`npm.cmd run typecheck` в builder-проходе завершился exit 1 только на параллельных/non-ledger изменениях: `src/routes/leads.ts(73,84)` и временном `tests/productionRuntimeMarker.test.ts` → `.mjs` declaration. Ошибок в ledger-файлах команда не сообщила; root-wide typecheck должен быть повторён после завершения sibling-правок.

Production widget/live evidence не выполнялось: builder не commit/push/deploy и не заявляет release PASS.
