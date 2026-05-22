# No-Regex Runtime URL Opt-In

## Problem

`agentManagerRuntime.ts` still falls back to a `RegExp` constructor to detect `agentHarness=1` in malformed or relative page URLs. This is legacy routing code in the runtime switch between the agent-manager path and the legacy path. The project direction is to remove old regex rather than expand it.

## Current Behavior

- Absolute URLs with `?agentHarness=1` enable the agent-manager runtime.
- URLs without that query value keep legacy runtime unless the global harness flag is enabled.
- Relative query strings can still be interpreted by the regex fallback.

## Structural Improvement

Use structured URL parsing with a fixed local base URL instead of regex. This preserves absolute URL handling and makes relative URLs/query strings parseable through `URLSearchParams`.

## Acceptance Criteria

- AC1: No regex constructor remains in `agentManagerRuntime.ts`.
- AC2: Absolute production URL `https://bakautprof.ru/?agentHarness=1` still enables agent-manager runtime.
- AC3: Relative query/page URL values such as `/?agentHarness=1` and `?agentHarness=1` still enable agent-manager runtime.
- AC4: Similar but non-matching values such as `agentHarness=10` do not opt in.
- AC5: No public API or metadata shape changes.
- AC6: Local non-OpenAI gates pass and no-regex baseline is updated after reviewing the removal.
