# Evidence

## Summary

Implemented a general agent-manager fix for technical questions about exact named models that are absent from the BAKAUT catalog.

## Acceptance Criteria

- AC1 PASS: `web.researchProductFacts` now passes `targetProductNames` and forces web search when exact target models are provided.
- AC2 PASS: regression verifies the final answer uses the checked external fact to answer the direct question.
- AC3 PASS: tool payload exposes `catalogPresence.status = "absent"` for the exact model and the answer says the exact model is not in the catalog.
- AC4 PASS: nearby catalog suggestions are derived from same brand plus same product class first; comparable same-class products are used only when same-brand candidates do not exist.
- AC5 PASS: regression answer does not include availability, delivery, discount, lead, callback, or price language for a pure technical question.
- AC6 PASS: added regression coverage for an absent `FIRMAN RD8910E`-style model with nearby same-brand catalog models.

## Commands

```powershell
npm test -- tests/agentManagerComparisonResearch.test.ts tests/agentManagerOrchestrator.test.ts
npm run typecheck
npm test
npm run build
git diff --check
git diff -- src/ai/agentManagerOrchestrator.ts src/ai/productComparisonResearch.ts tests/agentManagerComparisonResearch.test.ts | Select-String -SimpleMatch -Pattern 'RegExp','.match(','.test(','replace(','.toMatch('
```

## Results

- Focused tests: 2 files passed, 24 tests passed.
- Typecheck: passed for `tsconfig.json` and `tsconfig.server.json`.
- Full unit suite: 59 files passed, 528 tests passed.
- Build: passed.
- Diff whitespace check: passed with existing line-ending warnings only.
- No-regex diff scan: passed, no new `RegExp`, `.match(`, `.test(`, `replace(`, or `.toMatch(` in this pass.

## Production Gate

- Pending until commit/push, Railway auto-deploy, and production widget/eval verification.
