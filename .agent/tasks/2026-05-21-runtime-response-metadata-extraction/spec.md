# Runtime Response Metadata Extraction Spec

## Current Behavior

`src/ai/assistant.ts` still defines `runtimeResponseMetadata` inline. The helper converts an `AgentManagerRuntimeDecision` into response metadata and adds `legacyRuntime` details only when the runtime mode is `legacy`.

Current behavior to preserve:

- Always include `runtimeMode`, `runtimeModeReason`, and `agentManagerRuntime`.
- For `agent_manager`, do not include `legacyRuntime`.
- For `legacy`, include `legacyRuntime.active`, `path`, `reason`, and `legacyAnswerWritersDisabled`.
- Keep all caller metadata shapes unchanged.

## Structural Improvement

Move `runtimeResponseMetadata` into the existing runtime module:

- `src/ai/agentManagerRuntime.ts`

`assistant.ts` should import it alongside `getAgentManagerRuntimeDecision`.

## Validation

AC1. `assistant.ts` no longer defines `runtimeResponseMetadata` inline.

AC2. Focused runtime tests prove metadata shape for both `agent_manager` and `legacy` modes.

AC3. Existing assistant/runtime tests still pass.

AC4. `npm run lint:no-regex` proves no new regex constructs were added.

AC5. `npm run typecheck`, `npm run build`, and full `npm test` pass.

AC6. No production Promptfoo rerun is required for this pass because it is a pure extraction of response metadata helper code with no prompt/API/model/tool/business behavior change.
