# Technical diagnostics (schema 1)

The Platform Agent runtime emits content-free JSON events into stdout and a separate private PostgreSQL journal. No prompt, answer, tool arguments/output, SQL/parameters, contact, credential, cookie, raw URL, or arbitrary error message is copied. Provider errors are projected to recognized codes/types; other values are `unknown`. Known code locations can be retained without absolute paths. The live health marker includes `diagnosticsSchemaVersion: 1`.

## Follow a request

1. Use `x-request-id` from the HTTP/SSE response or the local `turnId`. The original submit, each recovery, and background reconciliation have separate `executionId` values. A recovery preserves the same local turn; provider `agentTurnId` is a different identifier.
2. With an existing administrator credential authorized for `diagnostics:read`, open the admin technical timeline or GET `/api/admin/diagnostics?turnId=<UUID>`. Exactly one of `turnId`, `executionId`, `requestId`, `providerRequestId` is required. Follow `nextId` with `afterId` while `hasMore` is true; limit is at most 500. No new credentials or principals were created.
3. Start with the earliest failure, not the latest recovery exception. `causalEventId` links reconciliation to the observed primary failure. `providerRequestId`, timestamps, observed model and endpoint template identify the evidence for provider support without exporting conversation content.
4. `spanId` / `parentSpanId` identify diagnostic spans. Legacy timing spans use `spanNumber` / `parentSpanNumber` within an execution. Each execution has monotonically increasing `eventSeq`. Gaps, terminal `droppedEvents`, `sinkFailures`, unfinished spans, and journal health show missing evidence. An open span with no terminal event is interrupted/unknown, not a successful operation.
5. Separate business commit (`assistant.answer.persisted`), server SSE write attempts, socket finish/close, browser transport observations and render-opportunity receipt (`delivery.client_render.observed`). HTTP 200 and `done` write do not prove delivery. A browser report is untrusted and advisory. Two animation frames do not prove a person read the answer. Absence of a receipt is not proof of failed delivery.

## Coverage

- Early HTTP request/rejection, authorized local identities, duplicate turn acceptance, explicit server deadline/client cancel/recovery grace.
- Platform GET/POST including usage reconciliation: start/end, header/body/parse time, status, request ID, bounded known error code/type, available numeric rate limits and Retry-After. Error-envelope inspection is limited to 16 KiB and one second; success requests retain their existing timeouts.
- Observed remote polls/statuses and tool/item metadata. Arguments, tool output, reasoning and generated text are excluded. No additional model requests were added.
- Lease acquire/renew/release, checkpoints, execution/recovery, contract validation, catalog/full snapshot/history/price stages, database query/pool pressure, safe SQLSTATE, row counts and transaction commit/rollback.
- Direct outbound URL validation/DNS/headers/body/redirects, without hostnames or payloads. TCP/TLS internals are not separately measured by this wrapper.
- Isolated lead outbox/usage/maintenance jobs, provider acceptance versus unknown outcome, startup/shutdown/readiness and minute-level RSS/heap/CPU/event-loop lag. Email acceptance is not delivery or reading; no new retries were introduced.

## Storage and loss

The `049_diagnostic_events.sql` migration creates only the private diagnostic table/indexes. The writer uses one dedicated connection with bounded connection/query/statement timeouts; it never uses the instrumented business pool. Batches of 100 flush every 250 ms. Ordinary queue capacity is 5,000 with 100 reserved slots for terminal/failure events. Insert is idempotent by event UUID. A failed write retains the batch and retries later; failure/overflow/shutdown counters go to stdout and the protected admin health result. Logging does not roll back a successful consultation.

Detailed retention defaults to **7 days**, configurable by `DIAGNOSTIC_RETENTION_DAYS` within 1–30 days. This setting affects only new technical events, never messages, checkpoints, leads or usage. Minute sweeps delete up to ten batches of 10,000 expired rows with a five-second work budget. `retentionBacklog` signals further work; cleanup continues next minute. Check table size/queue pressure against actual traffic before increasing retention. No external SaaS or financial settings were added.

A single execution accepts 20,000 normal events with bounded reserved error capacity and terminal summaries. The legacy `turn_timing` sink keeps only start/complete stdout records; its historic 400-event cap appears separately as `legacyDroppedEvents` and does not truncate the private diagnostic path. A sequence gap may be a local cap or queue loss; compare counters rather than guessing. The root and nested diagnostic/timing active spans are reported separately where relevant.

A process crash can lose the bounded in-memory queue. A simultaneous process/storage failure has no independent copy guarantee. Stdout can also be truncated by infrastructure. Use business transaction state as the source of truth; this journal is best-effort evidence, not a transactional outbox of every business change. Do not infer that an operation did not happen because no event survived.

## Limits and safe operations

Provider wait includes polling and network time; it is not pure model-generation time. Parallel/parent spans overlap: never add every duration into wall-clock latency. The provider does not expose every internal cause. Remote OpenAI→MCP steps have only returned metadata; no unverified cross-service trace propagation is assumed. Unknown usage remains unknown, not zero cost. Recognized 429 codes distinguish quota from rate limits; unknown 429 is not automatically classified as either.

Technical tokens/IDs from unknown provider formats are omitted rather than copied blindly. Code errors with unrecognized text remain `unknown` with safe class/site/fingerprint when possible. No diagnostic action reads an existing customer's query for investigation.

Roll out only via the repository's normal `git commit` + `git push` process, then verify the exact commit in Railway and `/api/health`. Never invoke manual Railway deploy. Offline checks do not substitute for a live widget behavior test; no paid live dialogue was authorized/run for this instrumentation change. A successful deployment marker proves installation, not AI-answer quality.

## Offline checks

Run `npm run verify` (offline oracle/mutation checks, regex guard, dependency audit, TypeScript, unit tests and production build). New tests cover concurrency, callback pool reuse, event caps/sink failure, queue retry/overflow, privacy canaries, provider timeout/malformed/error metadata, primary/recovery errors, SSE headers, browser one-shot reporting, authenticated client-report bounds and unknown email outcomes.

The task artifact `verify-journal.mjs` additionally exercises the exact migration, writer insert/idempotency, authorized render-to-turn correlation and telemetry-only retention on embedded PostgreSQL (PGlite). Its temporary npm dependency is test-only and is not added to application dependencies.
