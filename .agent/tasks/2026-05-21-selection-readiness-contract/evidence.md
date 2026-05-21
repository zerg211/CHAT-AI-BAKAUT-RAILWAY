# Selection readiness contract evidence

## Change

Moved the semantic decision “are buyer-visible product cards useful and honest now?” into the structured answer contract.

Implementation evidence:

- `src/ai/agentManagerContracts.ts`
  - adds `AnswerSelectionReadinessSchema`;
  - adds optional `selectionReadiness` to `AnswerContractSchema`.
- `src/ai/agentManagerOrchestrator.ts`
  - requires `selectionReadiness` in `answerContractFormat`;
  - instructs the answer model to set card readiness and explain missing facts in `answerText` when cards are blocked;
  - suppresses cards from `assessVisibleCardReadiness` without canned answer rewriting.
- `src/ai/agentManagerCardSelection.ts`
  - reads `answer.selectionReadiness`;
  - returns `blocked_by_answer_contract` when `canShowProductCards=false`;
  - preserves legacy ready behavior when no selection-readiness contract exists.

## Current behavior

- Product cards can still render when the structured answer contract says cards are ready.
- Cards are suppressed when the answer contract says more information is needed.
- The user-visible explanation comes from the LLM answer contract, not a fixed code phrase.
- Generic unknown pump loads are not invented into calculator payloads.

## Validation

- `npm test -- tests/agentManagerOrchestrator.test.ts`
  - PASS: 1 file / 21 tests.
- `npm test -- tests/generatorLoadReference.test.ts tests/generatorLoadReferenceEnrichment.test.ts`
  - PASS: 2 files / 10 tests.
- `npm test`
  - PASS: 59 files / 526 tests.
- `npm run typecheck`
  - PASS.
- `git diff --check`
  - PASS with existing Windows line-ending warnings only.
- `npm run build`
  - PASS.

## Eval status

- `npm run evals -- -o .agent/tasks/2026-05-21-refactor-completion/raw/local-evals-after-generator-load-selection-readiness.json`
  - BLOCKED/FAIL: 0/6 tests passed.
  - Root cause from fresh local server log: OpenAI generation and recovery return `403 Country, region, or territory not supported`.
  - No valid LLM average can be claimed from this environment.
  - Per project/user constraint, final behavior validation must happen only after push/merge and Railway deploy through the production widget.

## Migration note

This is an internal model-contract migration. It should be reviewed carefully before deployment because production LLM behavior depends on the new required structured field.
