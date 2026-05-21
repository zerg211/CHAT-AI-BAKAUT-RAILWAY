# Runtime Response Metadata Extraction Evidence

## Refactor

- Moved `runtimeResponseMetadata` from `src/ai/assistant.ts` into `src/ai/agentManagerRuntime.ts`.
- Updated `assistant.ts` to import the helper with `getAgentManagerRuntimeDecision`.
- Updated source guard coverage to assert `legacyRuntime` shape in the runtime module.
- Extended `tests/agentManagerRuntime.test.ts` to cover `agent_manager` and `legacy` metadata shapes.

`assistant.ts` line count after extraction: `12608`.

## Validation

- `npm test -- tests/agentManagerRuntime.test.ts tests/agentManagerIntegrationSource.test.ts tests/assistantFallback.test.ts`
  - PASS: 3 files, 30 tests.
- `npm run typecheck`
  - PASS.
- `npm run lint:no-regex`
  - PASS: `No new regex constructs. Legacy baseline: 1832.`
- `npm run build`
  - PASS.
- `npm test`
  - PASS: 67 files, 571 tests.

## Production gate

Not rerun for this pass. The change is a pure extraction of response metadata helper code with no prompt text, API, model, tool, or business behavior change.
