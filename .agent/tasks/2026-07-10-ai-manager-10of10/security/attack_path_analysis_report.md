# Security attack-path analysis

Date: 2026-07-11
Threat-model source: `security/threat_model.md`
Baseline: `2ce1ce43b3804b72e723d403fc355a66331b3358`
Current target: remediated worktree before commit/deploy

## Result

No validation candidate has a surviving reportable attack path in the current worktree. The paths below were real or plausible at baseline and materially drove the remediation, but their current final policy decision is `ignore` because the source-to-sink path is now broken by deterministic controls. Production deployment/live state remains outside this static verdict and is a separate release gate.

## AP-1 — Public OpenAI denial of wallet / capacity exhaustion

Candidate instances: `PUB-OPENAI-COST-001`, `OPENAI-BUDGET-ZERO-001`, `sec_review_provider_legacy-001`, `OPENAI-BUDGET-SOURCE-SPOOF-001`, `OPENAI-BUDGET-RACE-001`, `CHAT-SEC-DISC-ORCH-BUDGET-001`.

Affected locations:

- entrypoint: public chat/session routes in `src/routes/chat.ts`;
- baseline root control: disabled ordinary daily budget and source-selected budget in baseline `src/ai/openaiUsageGuard.ts`;
- wrapper: shared Responses/embedding client in `src/ai/openaiClient.ts`;
- sink: paid OpenAI Responses/embedding requests;
- current controls: `src/ai/openaiUsageGuard.ts`, `src/ai/agentManagerTurnBudget.ts`, `sql/016_openai_usage_reservations.sql`.

### Attack steps

1. Remote unauthenticated actor creates active widget sessions and sends natural-language messages.
2. Baseline normal buyer traffic selects a zero/disabled global budget, while spoofable URL/UA telemetry can select another bucket.
3. Multiple agent stages, retries or nested provider calls reach the paid provider wrapper.
4. Concurrent requests race the read/check accounting and can spend past the intended threshold.
5. Result is bill consumption and possible assistant unavailability for real buyers.

### Attack Path Facts

- Assumptions: public chat remains reachable through the production widget/API; OpenAI billing is active.
- In scope: yes — public AI runtime and denial of wallet are explicit threat-model surfaces.
- Exposure/vector: remote, public HTTP.
- Identity/auth scope: no buyer authentication; provider credential stays server-side.
- Attacker input control: yes for request rate/content and session metadata, not for the provider secret.
- Boundary crossing: public request causes a privileged paid server-side provider action.
- Impact surface: runtime availability and external spend; no direct data/identity compromise.
- Target reach: single production service and its shared OpenAI quota.
- Baseline mitigations/counterevidence: Fastify rate limiting existed, and provider-side limits may cap damage; neither was a transactional application budget.
- Current controls: positive shared 24-hour budget, transaction + advisory lock + reservation, fail-closed unavailable ledger, exact-host telemetry only, physical provider-call/output budget for nested/retry calls, public rate limit.
- Blindspot: no real concurrent PostgreSQL load test; static transaction/lock semantics and migration tests are decisive for the race invariant.
- Confidence: high.

Severity calibration at baseline: impact `medium`, likelihood `high` → final `medium/P2`.
Current policy decision: `ignore` — atomic global and per-turn controls break the overspend path.

## AP-2 — Server-side request forgery through catalog/research fetching

Candidate instances: `CHAT-SEC-DISC-SSRF-PCSOURCE-001`, `CATADMIN-SSRF-SYNC-SITE-START-001`, `CATADMIN-SSRF-SYNC-SITE-REDIRECT-002`, `CATADMIN-SSRF-SITEMAP-ROOT-003`, `CATADMIN-SSRF-SITEMAP-CHILD-004`, `CATADMIN-SSRF-PRODUCT-PAGE-005`, `CATADMIN-SSRF-PRODUCT-REDIRECT-006`, `CATADMIN-SSRF-CONTENT-PAGE-007`, `CATADMIN-SSRF-CONTENT-REDIRECT-008`.

Affected locations:

- public semantic entrypoint: buyer message → web research in `src/ai/productComparisonResearch.ts`;
- admin entrypoints: catalog sync routes in `src/routes/admin.ts`;
- baseline sinks: raw Undici fetch calls in product research/crawler/sitemap;
- current root control: `src/security/outboundHttp.ts`;
- current concrete integrations: `src/ai/productComparisonResearch.ts`, `src/catalog/crawler.ts`, `src/catalog/sitemapSync.ts`.

### Attack steps

1. Public buyer influences a web-research query/model-produced source URL, or an authenticated catalog operator supplies a URL/start path.
2. Baseline server fetches the URL and follows redirects without resolved-address policy.
3. A malicious public host/redirect or crafted literal targets loopback, private/LAN, metadata or IPv4-mapped/compatible IPv6 space.
4. Server-origin network access could disclose a reachable internal response or trigger internal side effects.

### Attack Path Facts

- Assumptions: a model/search result can produce an attacker-controlled URL; an internal target exists and responds.
- In scope: public research path yes; catalog admin path is a real production workflow but privileged.
- Exposure/vector: public research is remote; catalog sync is admin-only.
- Attacker input control: plausible/indirect on research URL, direct only after admin auth for catalog URL.
- Boundary crossing: server-side network boundary.
- Impact surface: network/confidentiality; exact internal target impact was not proven from repository evidence.
- Counterevidence: catalog routes require timing-safe bearer auth; intended product research must fetch arbitrary public origins; no repository proof identifies a sensitive internal service.
- Current controls: HTTP(S) only, no credentials/nonstandard ports/local hostnames, exact catalog origin, all-address DNS validation, private/reserved/mapped/compatible IPv6 rejection, DNS pinning, manual per-hop redirect validation, time/byte/redirect limits.
- Blindspots: deployment-specific egress topology is unknown; the current control does not rely on that topology.
- Confidence: high for baseline reachability, medium for baseline impact.

Severity calibration at baseline public path: impact `high`, likelihood `medium` → `medium/P2`; admin-only variants mechanically `ignore`.
Current policy decision: `ignore` — destination validation and pinning break every identified private-network path.

## AP-3 — Public lead/email amplification

Candidate instances: `PUB-LEAD-EMAIL-AMPLIFICATION-001`, `DB-LEAD-IDEMPOTENCY-001`, plus agent-origin replay candidate `CHAT-SEC-DISC-ORCH-LEGACY-LEAD-001`.

Affected locations:

- entrypoint: `POST /api/leads` in `src/routes/leads.ts` and `lead.capture` tool in AgentManager;
- baseline root control: fresh lead creation per retry and insufficient side-effect authorization;
- sinks: `leads`, `lead_outbox`, HTTP email worker;
- current controls: `sql/015_lead_form_idempotency.sql`, `src/db/repositories.ts`, structured lead authorization in AgentManager, client stable UUID.

### Attack steps

1. Remote actor creates/reuses a session and repeatedly posts contact data or retries a timed-out submission.
2. Baseline creates independent lead rows and email attempts without a stable business key.
3. Agent recovery can also repeat a side effect after a crash.
4. Mailbox receives duplicates/spam; database and HTTP email provider consume resources.

### Attack Path Facts

- In scope/exposure: public lead form and AI side effects are explicit production surfaces; remote vector.
- Auth scope: public but requires an active session; baseline active sessions were cheap to create.
- Attacker control: direct over form fields/retry rate; semantic lead path also depended on model output.
- Boundary crossing: public request → durable DB side effect → external email delivery.
- Impact: medium operational/reputation/cost, not account or secret compromise.
- Baseline counterevidence: global/route rate limits and outbox uniqueness reduced volume but did not make a user action idempotent.
- Current controls: stable `clientLeadId`, payload hash conflict, active-session recheck, DB unique key, one `(lead,destination)` outbox, origin turn/tool uniqueness, current-message semantic authorization/evidence, exact contact extraction, sent status cannot be downgraded by replay.
- Residual: fresh UUID abuse remains possible only within the dedicated per-IP rate limit.
- Confidence: high.

Severity calibration at baseline: impact `medium`, likelihood `high` → `medium/P2`.
Current policy decision: `ignore` — replay/amplification path is idempotent and rate-bounded.

## AP-4 — Catalog integrity loss through incomplete full sync / concurrent writers

Candidate instances: `CATADMIN-INTEGRITY-FULL-SYNC-016`, `CATALOG-EMPTY-FULL-SYNC-PRODUCTS-001`, `CATALOG-EMPTY-FULL-SYNC-PAGES-001`, `CATADMIN-DOS-SYNC-LOCK-017`.

Affected locations:

- entrypoint: authenticated sitemap/crawler/CSV/inventory-import workflows;
- root control: sync-mode/coverage/inventory guard in `src/catalog/sitemapSync.ts` and global lock identity in `src/catalog/catalogFreshness.ts`;
- sink: atomic deactivation/upsert lifecycle in `src/db/repositories.ts`;
- operational schema: `sql/014_catalog_freshness.sql`.

### Attack steps

1. Admin chooses a same-origin sitemap/alias, upstream sitemap becomes incomplete, or two mutation commands run with equivalent but textually distinct sources.
2. A non-empty incomplete inventory passes baseline “successful full run” checks or aliases obtain separate locks.
3. Upserts/interleaving mark only the observed subset as seen.
4. Missing active products/pages are mass-deactivated, damaging recommendations and catalog integrity.

### Attack Path Facts

- In scope: catalog integrity is a crown-jewel supporting buyer recommendations.
- Exposure/vector: admin-only or upstream catalog compromise; no lower-privileged public route controls the sync.
- Attacker control: no realistic public attacker control proven; operator/upstream precondition.
- Boundary crossing: privileged catalog workflow changes production data.
- Impact: potentially high correctness/business impact, but policy treats privileged-only preconditions as non-reportable security unless privilege is gained.
- Strongest counterevidence: bearer admin auth and same-origin network policy; the bug is primarily reliability/integrity, not privilege escalation.
- Current controls: one global mutation advisory lock for every mutation path, full/partial mode, prior active inventory ratio/floor before writes, positive/equal discovered/synced counts, no skip/failure, atomic finalize/deactivation, heartbeat/stuck health, bootstrap exception, no separate bypass repository API.
- Residual: threshold is conservative and may retain stale records after a legitimate sharp shrink; this fails safe.
- Confidence: high.

Severity calibration: privileged-only hard suppression → `ignore` as a security finding; retained as a P1 production integrity requirement.
Current policy decision: `ignore` — both the attack and correctness paths are closed for current callers.

## AP-5 — Web evidence poisoning into buyer-visible guidance/memory

Candidate instances: `CHAT-SEC-DISC-TRUST-PCGENERIC-001`, `CHAT-SEC-DISC-ORCH-VERIFIED-MEMORY-001`, `CHAT-SEC-DISC-ORCH-EVIDENCE-LAUNDER-001`, `CHAT-SEC-DISC-ORCH-FAILED-TOOL-TEXT-001`, `CHAT-SEC-DISC-DOS-PCPDF-001`.

Affected locations:

- entrypoint: public buyer question and web-search result;
- root controls: source fetch/target/semantic validation in `src/ai/productComparisonResearch.ts`, evidence-ID validation and final review in AgentManager;
- sinks: required answer clauses, buyer-visible answer, verified fact memory.

### Attack steps

1. Buyer steers research toward poisoned, mismatched, unavailable or resource-heavy source content.
2. Baseline generic research skips source validation or removes individual facts while retaining model-authored `directAnswer`/summary.
3. Orchestrator labels the text checked guidance; evidence IDs may be replaced with unrelated valid IDs.
4. Buyer receives an unsupported technical claim or it is persisted as verified memory.

### Attack Path Facts

- In scope/exposure: public remote prompt/content-integrity surface.
- Attacker input control: indirect over query/source; direct over buyer text.
- Boundary crossing: untrusted web/model data → trusted buyer answer/memory.
- Impact: answer integrity and possible unsafe product advice; no demonstrated auth/secret compromise.
- Counterevidence: an independent LLM semantic validator is probabilistic; however deterministic source/status/ID/card gates limit what can become trusted.
- Current controls: bounded HTML only (PDF parser removed/fail-closed), exact target source match, semantic claim/source validation for high/medium evidence, low evidence rejection, conflict evidence cannot support positive guidance, generic model-authored directAnswer/summary always removed, failed tool text replaced, unknown evidence IDs rejected, semantic risk review and independent rewrite recheck.
- Residual: third-party sources and semantic validation can still be wrong; that is model/data quality risk, not a bypass of the validated trust boundary.
- Confidence: high.

Severity calibration at baseline: impact `medium`, likelihood `medium` → `low/P3`.
Current policy decision: `ignore` — no unsupported generic prose or invalid evidence reference reaches the trusted sink.

## Final policy matrix

| Attack path | Baseline calibrated severity | Current decision | Reason |
|---|---:|---|---|
| Public OpenAI denial of wallet | Medium / P2 | Ignore | Global atomic reservation + per-turn physical budget close path. |
| Public research SSRF | Medium / P2 | Ignore | Destination/DNS/redirect/pinning controls close path. |
| Public lead/email amplification | Medium / P2 | Ignore | Business idempotency, authorization and rate limits close path. |
| Catalog mass deactivation/concurrent writers | Ignore as security; P1 reliability | Ignore | Admin-only and current integrity controls close current path. |
| Web evidence poisoning | Low / P3 | Ignore | Generic prose removed; surviving claims require validated evidence. |

There are no current `critical`, `high`, `medium` or `low` reportable findings after the mechanical policy-adjustment pass.
