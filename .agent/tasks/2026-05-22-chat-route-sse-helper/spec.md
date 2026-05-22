# Spec: chat route SSE helper extraction

Task ID: `2026-05-22-chat-route-sse-helper`

## Current behavior

`src/routes/chat.ts` implements the same SSE mechanics in two paths:

- normal `/api/chat/sessions/:id/messages` generation;
- explicit `/api/chat/sessions/:id/messages/:turnId/recover` recovery.

Both paths manually write the same SSE headers, create the same `send(event, data)` closure, manage a status timer, and close the raw reply.

## Structural improvement

Extract the duplicated SSE plumbing into a small route helper module:

- write standard SSE headers;
- create a safe sender that no-ops after the raw reply is destroyed or ended;
- start the status timer with the same initial status and interval behavior;
- close the raw reply safely.

This is infrastructure refactoring only. It must not change generated text, recovery policy, tool execution, public HTTP routes, SSE event names, event payloads, timeout values, or client behavior.

## Non-goals

- No prompt, model, eval, OpenAI, database, widget UI, or public API changes.
- No functional change to same-turn recovery or explicit recovery.
- No regex or keyword behavior changes.

## Acceptance criteria

- AC1. Generation and recovery routes still emit the same event names and payload shape through the shared sender.
- AC2. The status timer still sends the first status immediately and advances through the existing `generationStatusMessages`.
- AC3. Focused tests cover helper send/close behavior and status timer behavior.
- AC4. `npm run lint:no-regex`, focused tests, typecheck, full tests, build, and `git diff --check` pass.

## Validation plan

- `npm test -- tests/chatSse.test.ts tests/agentManagerIntegrationSource.test.ts`
- `npm run lint:no-regex`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `git diff --check`
