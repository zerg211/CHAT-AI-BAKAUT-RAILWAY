# Fast Persistent Product Research

Task ID: `2026-08-30-fast-persistent-product-research`
Frozen at: `2026-08-30`
Status: FROZEN

## Context

The production assistant must replace a live BAKAUT sales manager. When a decision-relevant fact is absent from catalog data and verified memory, research is mandatory. The current research path can spend almost the entire 60-second tool window in one opaque operation, its outer retry reuses the first attempt's start time, source coverage is inconsistent, and incomplete execution details can leak into buyer-facing wording. Confirmed facts must become durable memory so the same question is not researched again.

This task extends `2026-08-30-human-facing-research-failures` with search performance, source quality, observability, and persistence requirements.

## Goal

Build a bounded research loop that finds exact product facts as quickly as practical, verifies them against trustworthy sources, persists every reusable confirmed fact with product/source provenance, and answers naturally without exposing internal execution details.

## Acceptance Criteria

- AC1. Research follows a deterministic evidence order: current catalog product data and description, verified fact memory, exact official product page, official manual/specification, then reliable exact-model secondary sources. A complete earlier tier short-circuits later work.
- AC2. Search requests use the LLM's typed exact product names, aliases/model identifiers, and missing canonical attributes. Search does not infer product meaning from raw buyer text with regex or keyword routing.
- AC3. No single attempt can consume the entire research allowance while preventing a meaningful fallback. Every attempt has a fresh absolute deadline inside the shared turn budget and preserves enough time for validation and the writer. Retry metadata reports actual attempt duration and disposition.
- AC4. Source tiers are attempted efficiently. Independent official-page, manual/specification, and reliable-secondary lookups may run concurrently when they do not depend on one another; cancellation stops unnecessary work after sufficient exact evidence is obtained.
- AC5. A fact is accepted only when source evidence names the exact product/model identity and contains the claimed value. Manufacturer/manual evidence is preferred; secondary evidence remains medium confidence unless corroborated. Missing data is not incompatibility.
- AC6. Every newly confirmed reusable product fact is persisted idempotently with catalog product identity when available, product name, canonical attribute, value, confidence, source URL/title/tier/authority, exact evidence excerpt, observed timestamp, and catalog snapshot binding. Failed, timed-out, ambiguous, contradicted, or source-less claims are not persisted as verified facts.
- AC7. A later turn retrieves matching persisted facts before web research and skips the external lookup when memory fully covers the requested product/attributes. Partial memory triggers research only for the remaining gaps.
- AC8. Research traces identify stage/tier, attempt number, elapsed time, remaining budget, outcome, source count, accepted fact count, and persistence count without exposing secrets or this metadata to the buyer.
- AC9. Buyer-facing text never mentions tools, web/external search execution, timeout, retries, pipelines, or whether a check completed. It names concrete products, confirmed facts, and the exact unresolved customer fact in normal sales-manager language. Handoff remains forbidden until typed source exhaustion is proven.
- AC10. Focused tests cover fast-path short-circuit, fresh retry deadlines, tier fallback/concurrency, exact-model evidence rejection, successful persistence, idempotency, memory reuse, partial-memory gap research, and customer-language review/repair. Typecheck, full release gate, build, no-regex guard, and fresh verifier pass.
- AC11. After explicit commit/push authorization, Railway deploys from GitHub and a fresh adaptive dialogue through the embedded widget at `https://bakautprof.ru/` proves: exact product research returns a useful answer within the turn budget, admin traces show the source path, the fact is persisted, and a later question reuses memory without another external lookup. Buyer/code/goal/lead audit issues are zero.

## Constraints

- Do not add phrase-specific customer answers, model-specific branches, or raw-text semantic classifiers.
- Do not weaken exact identity, evidence, source exhaustion, catalog, safety, business, or lead authorization checks.
- Do not persist unsupported LLM output as verified fact memory.
- Do not increase latency by always running every source tier; stop when the requested fact is sufficiently covered.
- Do not manually deploy Railway.
- Do not modify or reset unrelated dirty-worktree changes.

## Verification

1. Audit current catalog extraction, verified memory retrieval, OpenAI web search, source validation, timeout/retry, trace, and persistence paths.
2. Implement the smallest coherent staged research orchestration with explicit budgets and durable fact writes.
3. Verify locally without OpenAI calls using mocks and deterministic timing.
4. Obtain an independent fresh verifier verdict.
5. Commit/push only after explicit authorization, wait for exact production marker, then perform the mandatory widget/admin and memory-reuse audit.

## Done Definition

Every AC is PASS. A single successful web response, prompt assertion, automatic harness PASS, or persisted unverified claim is insufficient.
