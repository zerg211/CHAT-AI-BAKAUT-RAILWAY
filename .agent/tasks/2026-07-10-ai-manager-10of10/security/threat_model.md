# Overview

`chatAI` — production web application for the BAKAUT site. It exposes an embeddable React iframe widget and a Fastify API, keeps anonymous buyer conversations and leads in PostgreSQL/pgvector, uses OpenAI Responses API for planning and answer generation, reads product facts from the BAKAUT catalog and external research, and sends qualified leads through a configured HTTP email provider. GitHub is the source of deployment truth and Railway builds and runs the service plus migrations.

The primary deployed surfaces are `src/server.ts` and `src/app.ts`, the public routes in `src/routes/chat.ts`, `src/routes/leads.ts` and `src/routes/widget.ts`, the privileged routes in `src/routes/admin.ts`, the agent runtime in `src/ai/agentManager*.ts`, persistence in `src/db/*` and `sql/*`, catalog ingestion in `src/catalog/*`, and the lead outbox/email path in `src/ai/leadOutbox.ts` and `src/email/httpEmail.ts`. Tests, local dialogue scripts and documentation are not production entry points, but CI/release scripts can affect what is shipped.

Security matters here both in the conventional sense (confidentiality, integrity, availability and authorization) and at the agent boundary: untrusted buyer, catalog and web content must not become instructions that bypass deterministic business constraints or trigger side effects without current consent.

# Threat Model, Trust Boundaries, and Assumptions

## Assets and security objectives

- Buyer PII and commercial context: names, phones, email addresses, page URLs, user agents, conversation messages, semantic ledgers, feedback, lead records, traces and email payloads.
- Conversation integrity and isolation: one anonymous visitor must not read, alter, recover, close or rate another visitor's session merely by controlling request input.
- Lead integrity: a lead and its email notification must be created only from a real buyer action or a structurally authorized agent action, and retries must not duplicate the external side effect.
- Catalog and answer integrity: product identity, prices, specifications, availability qualifiers, evidence provenance, selected cards and assistant text must remain consistent and must not be poisoned by untrusted HTML, CSV, JSON-LD, PDF or web content.
- Privileged operations: catalog imports/sync, conversation and lead inspection, feedback export, runtime probes, eval calls and deletion endpoints must remain admin-only.
- Secrets and infrastructure: OpenAI, admin, database and email credentials; PostgreSQL contents; Railway/GitHub deployment authority; model/token budget; service availability.
- Auditability and recovery: turn leases, checkpoints, tool artifacts, traces, usage records, feedback queue and outbox status must be tamper-resistant enough to explain and safely resume behavior.

## Actors and trust boundaries

1. **Anonymous buyer browser ↔ public Fastify API.** The widget can be embedded on a public page, but the API is directly reachable by arbitrary clients. Buyer messages, `visitorId`, `pageUrl`, user agent, feedback, lead fields, session/turn/message identifiers and request timing are attacker-controlled. There is no customer account identity; a high-entropy session UUID therefore functions as a capability and must be treated as sensitive.
2. **Host page ↔ cross-origin iframe/widget.** `embed.js` creates an iframe that runs on the assistant service origin. The containing site, forwarded host/protocol headers, browser storage and any future `postMessage` interface sit on a trust boundary. The iframe must not give the parent page or unrelated origins access to conversation data beyond the intended embed contract.
3. **Public/admin HTTP API ↔ application process.** Fastify validation, request/body limits, CORS, rate limiting, route authorization and error handling are the controls between untrusted network traffic and application logic. Admin endpoints use a bearer secret and expose PII plus high-impact catalog, deletion, OpenAI and feedback operations.
4. **Application process ↔ PostgreSQL/pgvector.** The database stores all durable conversations, PII, model/tool evidence, catalog data and side-effect state. SQL parameters, transaction boundaries, uniqueness constraints, leases and migrations must preserve isolation and idempotency. The application database credential is assumed to be unavailable to public clients and scoped to this service.
5. **Agent orchestrator ↔ OpenAI.** Conversation history, catalog facts and structured tool artifacts cross to a third-party model provider. Model output is untrusted control-plane input until strict schema validation and deterministic policy enforcement succeed. Prompt injection can originate in buyer messages, crawled pages, catalog descriptions or web results.
6. **Agent tools ↔ catalog/web/calculator/lead side effects.** Read tools may consume untrusted external data; `lead.capture` crosses into persistent PII and the email outbox. LLM intent may choose semantics, but code must own argument validation, factual fit, permissions, budgets, retries and idempotency.
7. **Catalog synchronizers ↔ BAKAUT site and operator-supplied inputs.** HTML, sitemap XML, JSON-LD, document metadata, CSV files, URLs and redirect targets are not executable instructions. They may be attacker-controlled if the source site, DNS, content pipeline or admin credential is compromised. Full-sync deactivation is especially integrity-sensitive.
8. **Application ↔ HTTP email provider.** Lead and dialogue PII leaves the service over a configured endpoint. TLS, destination configuration, provider authentication, timeouts and idempotency support are assumed; the generic provider must honor the supplied idempotency key for exactly-once semantics across ambiguous network failures.
9. **Operator/developer ↔ production.** Environment variables, admin requests and catalog-source choices are operator-controlled. Source code, dependencies, migrations, GitHub workflows and lockfiles are developer-controlled. GitHub/Railway account compromise, malicious maintainers, database superuser access and deliberate local filesystem access are outside the anonymous web-attacker model, but supply-chain controls should reduce their blast radius.

## Core invariants

- Every public session mutation and read/recovery operation must be bound to the correct anonymous session capability; session identifiers must not leak through logs, cross-origin behavior or predictable values.
- Every admin operation must fail closed when no secret is configured and must compare a bearer credential safely; privileged responses containing PII must never be reachable through public routes or permissive browser policy.
- Untrusted text/data may inform the model, but cannot redefine system policy, tool schemas, tool permissions, hard catalog constraints, evidence provenance, turn budgets or business prohibitions.
- LLM-proposed product IDs and claims must be checked against the exact retrieved evidence and deterministic hard constraints before text/cards become visible.
- PII collection and `lead.capture` require a current structured authorization signal and an actual contact from the current message or already-authorized session state; LLM-supplied contact arguments alone are not authority.
- Retries/recovery must not create duplicate messages, leads, tool side effects or email sends. Durable state must be written before the response is treated as completed.
- Catalog/web/email outbound requests must be limited to intended destinations or explicit trusted configuration, reject unsafe redirect/address classes where relevant, and have time/size/count budgets.
- Secrets must stay in environment/runtime secret stores and out of Git, client bundles, health responses, traces and errors.
- Stored/rendered buyer, catalog, web and model content must remain data. React/server responses must not interpolate it into executable HTML, JavaScript, headers, SQL or shell commands.

## Assumptions and exclusions

- Production traffic terminates through Railway/HTTPS and Railway supplies trustworthy forwarding headers only after stripping client spoofing; if arbitrary clients can set accepted forwarded headers directly, origin/script generation must not trust them.
- PostgreSQL and service environment variables are not publicly reachable. Admin and email secrets are high entropy, rotated when exposed, and not reused as user passwords.
- The configured OpenAI and email endpoints are legitimate HTTPS providers. Generic email transports are responsible for honoring the idempotency key documented by this application.
- The BAKAUT catalog is an important business source, not a trusted instruction source. Facts can be stale or conflicting even without an attacker.
- A visitor who deliberately shares their own session UUID has delegated access to that conversation. Guessing or obtaining another visitor's UUID through application leakage is not accepted.
- Direct compromise of GitHub/Railway owners, a database superuser, the host OS or a deliberately malicious administrator is out of scope for anonymous remote severity, while accidental operator misuse and a stolen admin bearer remain relevant.

# Attack Surface, Mitigations, and Attacker Stories

## Public chat and widget

The public surface creates/heartbeats/closes sessions, submits messages, streams generation state, recovers turns and records feedback. Relevant classes are broken object-level authorization, session fixation/leakage, CSRF/cross-origin abuse, oversized or concurrent requests, resource exhaustion, stored/reflected XSS, log injection and model-cost abuse. High-entropy UUIDs, Zod schemas, per-message length limits, request idempotency, one-active-turn rules, execution leases, checkpoints, payload recovery and a global Fastify rate limit are material controls. React's normal text rendering is expected to escape content; any raw HTML path or executable URL requires separate scrutiny.

Realistic attacker stories include direct scripted creation of many sessions/turns to consume OpenAI budget, reuse of a disclosed session UUID to mutate that session, adversarial prompt content, malformed identifiers and retries timed around SSE disconnects. A normal buyer is allowed to write arbitrary natural-language content; safety cannot depend on keyword blocks.

## Agent, model and tool boundary

The planner/writer/reviewer produce strict structured contracts, while code validates schemas, caps model/tool/web calls and bytes, persists tool artifacts, verifies selected product IDs, provenance and hard fit, and guards business claims. Tool payloads are explicitly labeled untrusted evidence. The lead tool has a separate side-effect authorization contract and durable origin/outbox idempotency.

Relevant classes are indirect/direct prompt injection, schema confusion, tool argument smuggling, use of failed/stale evidence, cross-turn state poisoning, hallucinated products/facts, unauthorized PII collection, side-effect replay and denial of wallet. A successful prompt injection would need to cross deterministic validation to become a conventional security finding; model misjudgment that is caught and safely qualified is a quality issue, not an exploit.

## Leads, feedback and email

Public lead input carries PII and attacker-controlled text into PostgreSQL, admin views and outbound email. Feedback can capture conversation/model context and later become an eval candidate. Relevant classes are duplicate submission, cross-session association, email/header/template injection, PII overcollection or export, stored XSS in admin views, poisoned eval fixtures and ambiguous provider retry. Schema validation, text-only email composition, PII reduction for feedback export, database constraints, a durable outbox, stale-worker recovery, timeouts and `Idempotency-Key` are expected mitigations.

## Admin control plane

Admin routes expose conversation/trace/lead/catalog/feedback/usage data and can import files, crawl URLs, deactivate catalog records, call OpenAI and delete sessions. They are protected by a fail-closed bearer secret and constant-time equality check. Relevant classes are authentication bypass, credential leakage, insufficient per-operation authorization, CSRF/CORS exposure, SSRF, arbitrary local file read through imports, unsafe redirects, resource exhaustion and PII exposure. A stolen admin token is a realistic high-impact precondition; a legitimate administrator intentionally choosing an arbitrary local path is an operator action unless it crosses an additional privilege boundary.

## Catalog ingestion and retrieval

Crawler/sitemap/CSV ingestion parses hostile-size and malformed content, follows links, creates embeddings and updates/deactivates catalog rows. Retrieval places this content in prompts and buyer-visible cards. Relevant classes are SSRF/redirect bypass, decompression or parser denial of service, path traversal, formula injection in exported/imported CSV workflows, content/prompt poisoning, unsafe URL schemes, persistent XSS and destructive partial-sync behavior. Same-host/catalog-path filtering, caps, concurrency limits, request delay, fetch timeouts, parser normalization, freshness tracking, conflict records and coverage-complete deactivation rules reduce risk.

## Persistence, operations and supply chain

PostgreSQL queries, migrations, background cleanup, turn leases, usage accounting and lead outbox processing affect confidentiality and availability. Parameterized query values, transactions, uniqueness constraints, additive migrations, bounded list queries and graceful shutdown are important controls. Dependency or CI compromise, unsafe migration rollback, leaked `.env` files, verbose logs, public health metadata and stale operational queues remain relevant classes. The lockfile, production-only dependency audit, release gate, commit-marker health check and GitHub-to-Railway deployment flow are expected controls.

## Out-of-scope or reduced-severity stories

- An attacker who already owns the Railway/GitHub account, database superuser or host filesystem can bypass application controls; this is infrastructure compromise rather than an application-only attack.
- A finding reachable only by a correctly authenticated administrator is generally an operator footgun unless it enables SSRF to privileged networks, reads secrets outside intended scope, persists executable content, or crosses another boundary.
- Incorrect commercial advice without unauthorized data access, side effects or safety impact belongs primarily to product-quality evaluation; it becomes security-relevant when attacker-controlled content reliably defeats grounded-policy controls or exposes/changes protected data.
- Availability issues that require sustained traffic beyond Railway/upstream protections may be medium or low when model-call budgets and rate limits bound cost; unauthenticated amplification or budget bypass can raise severity.

# Severity Calibration (Critical, High, Medium, Low)

## Critical

- Unauthenticated remote code execution in the production service or build/deploy path.
- Unauthenticated extraction of application/database/email/OpenAI/admin secrets, database-wide PII, or takeover of the admin control plane.
- A supply-chain or migration flaw that predictably compromises every deployment with no meaningful precondition.

## High

- Authentication/authorization bypass exposing many conversations, leads or traces, or allowing catalog destruction/admin actions.
- SSRF from a remotely reachable or realistically stolen low-privilege boundary into cloud metadata/internal control services, especially with response disclosure or credential theft.
- Stored XSS executing in the BAKAUT site/admin security context, or prompt/tool injection that crosses deterministic controls and creates unauthorized leads, exfiltrates protected context or performs material side effects.
- Reliable idempotency failure causing repeated external lead/email actions at scale or persistent cross-session data corruption.

## Medium

- Cross-session access limited to one capability/session with substantial guessing/leak preconditions; CSRF that changes a victim's anonymous conversation without broader PII exposure.
- Bounded unauthenticated resource/cost exhaustion, catalog poisoning with material buyer impact but no code execution, or operator-reachable SSRF/local file exposure that requires an admin token and does not reach secrets by default.
- PII appearing in logs, feedback exports or errors in a limited operational scope; a duplicate lead/email caused by a rare ambiguous failure when downstream idempotency is unavailable.

## Low

- Minor health/version metadata disclosure, non-sensitive verbose errors, or rate-limit gaps with negligible cost/availability impact.
- Defense-in-depth weaknesses reachable only by a fully trusted administrator and unable to cross into secrets, other tenants/sessions or production code execution.
- Robustness or validation defects that are caught by downstream controls and have no demonstrated confidentiality, integrity, availability or side-effect impact.

Repository: codex-security-target/v1:sha256:b59e248049a88f66229e06fa26517e90e7c032717f1c557db8549d52a763efbf
Version: codex-security-snapshot/v1:sha256:a7e5a81babf44fc10abac6f7682e6276a454a1f53c8d0729ead408080452f828
