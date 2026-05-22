# No-Regex Promptfoo SSE Parser

## Problem

`evals/promptfoo/chat-app-provider.cjs` still parses SSE blocks with regex-based splitting and field cleanup. This is eval harness code, not bot behavior, but it is on the production Promptfoo path and should follow the no-new-regex/no-regex-removal direction.

## Current Behavior

- SSE responses are split into event blocks by blank lines.
- `event:` lines determine the event name, defaulting to `message`.
- `data:` lines are joined with newline and parsed as JSON when possible.
- The provider trims trailing slashes from `baseUrl` before constructing API URLs.

## Structural Improvement

Replace regex splitting/replacement with small deterministic string helpers:

- normalize CR/LF by scanning characters;
- split SSE blocks by blank lines;
- strip `event:` / `data:` field prefixes by slicing;
- trim trailing URL slashes by scanning from the end.

## Acceptance Criteria

- AC1: `parseSseEvents()` keeps parsing normal `event: done` JSON payloads.
- AC2: `parseSseEvents()` handles CRLF and multi-line `data:` payloads.
- AC3: The default provider export remains constructable by Promptfoo.
- AC4: No new regex constructs are introduced; reviewed removals are reflected in the baseline.
- AC5: Local non-OpenAI gates pass.
