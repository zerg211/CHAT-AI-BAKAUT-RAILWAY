# Evidence: chat route SSE helper extraction

Task ID: `2026-05-22-chat-route-sse-helper`
Recorded: `2026-05-22T09:23:02+03:00`
Base HEAD: `86aea7a`

## Summary

Extracted duplicated SSE plumbing from `src/routes/chat.ts` into `src/routes/sse.ts`.

The refactor preserves the same route behavior:

- same SSE headers;
- same `event:` / `data:` frame format;
- safe no-op after the raw reply is destroyed or ended;
- same immediate status event;
- same 12 second status timer cadence;
- same reply close behavior.

No prompt, model, OpenAI, widget UI, database, public route, timeout, or recovery policy changed.

## Validation

- `npm test -- tests/chatSse.test.ts tests/agentManagerIntegrationSource.test.ts`: PASS, 2 files, 12 tests.
- `npm run lint:no-regex`: PASS, `Legacy baseline: 1824`.
- `npm run typecheck`: PASS.
- `npm test`: PASS, 74 files, 598 tests.
- `npm run build`: PASS.
- `git diff --check`: PASS with CRLF warnings only.

## Behavior Parity

- `tests/chatSse.test.ts` covers standard SSE headers, frame formatting, no-op after close, initial status event, and status timer advancement.
- `tests/agentManagerIntegrationSource.test.ts` now guards that chat routes use `openSseReply`, `startStatusTimer`, and `closeSseReply`, and no longer duplicate `reply.raw.writeHead(200)` directly.

## Verdict

PASS for this structural refactor pass. Production Promptfoo/widget rerun is not required because no AI behavior, prompt, API payload shape, or client contract changed; local route helper tests and full build/test gates cover the extracted infrastructure.
