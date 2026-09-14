# Dialogue adversarial correctness — frozen specification

Frozen: 2026-09-14. Baseline: `4a8edb186ad7086fb2a302782993ff3713141116`.

## Goal

Remove the systemic correctness gaps exposed by production dialogue 2185 while preserving agentic semantic ownership: the LLM interprets the buyer and writes the answer; deterministic code proves source/value bindings, records incomplete research honestly, degrades read-only failures to a useful partial answer, classifies publisher authority, and shows the seller the real turn state. After merge and Railway deployment, verify the result in one new adaptive dialogue through the widget on `https://bakautprof.ru/` and audit both visible output and internal metadata.

## Acceptance criteria

- **AC1 — honest task outcome.** Missing facts survive every `selectionReadiness` status and continuation status. A `web.researchProductFacts` payload with `researchOutcome=partial`, `searchDisposition=timed_out|failed|aborted|skipped_budget`, or `sourcesExhausted=false` preserves its named `unconfirmedFacts` in `taskOutcome.unresolvedFacts`. A useful answer with unresolved facts is `partially_resolved`; it does not authorize a lead.
- **AC2 — required research success is semantic.** A required research result is not treated as completed merely because the outer tool status is `ok`; incomplete research is visible in `failedRequiredTools`/outcome diagnostics without being misreported as a hard execution failure when usable evidence exists.
- **AC3 — claim-level evidence.** Each numerical factual claim sourced from a tool must bind to a concrete validated fact or coverage evidence item inside that tool result. Reusing the same request ID cannot validate a changed number. Nested stale catalog context inside a web result is not fact-bearing. Validation returns an actionable issue and exact evidence path/binding metadata.
- **AC4 — read-only fail-soft.** Exceeding external-read call allowance produces persisted non-fact-bearing budget-stopped artifacts and proceeds to the writer with prior evidence. It does not fail the whole turn. Side effects and exhausted wall/model/provider/result budgets keep their current hard boundary.
- **AC5 — manufacturer authority.** Manufacturer host bindings live in a curated exact-domain registry. `Fubag` + `fubag.group` (including subdomains) classifies as `manufacturer/official_page`; lookalike suffixes remain secondary. Existing brands retain behavior.
- **AC6 — no unchanged calculator replay.** The semantic planner is explicitly required to omit `calculator.generatorLoad` for an evidence-only technical follow-up when the load scenario did not change and no new selection/card decision is requested. Deterministic semantic validation rejects a new calculator call when the structured current task says `technical_answer` + `answer` and the calculator scenario comes only from prior ledger state; a changed scenario remains allowed.
- **AC7 — truthful seller UI.** Admin detail consumes backend `turns`, shows failed/completed turn rows and error codes, current build SHA, `taskOutcome`, unresolved facts, incomplete/exhausted research, and required tool failures. Readiness uses the current `selectionReadiness.status`, so blocked states cannot render as `ready`. Warning count includes top-level and tool warnings.
- **AC8 — contact visibility follows authorization.** The public widget renders the contact panel only while the latest valid assistant message has `leadRequested=true`. A collapsed permanent “Оставить контакт” control is absent when research is incomplete and no lead offer was authorized.
- **AC9 — meaningful local proof.** Targeted unit/component tests cover AC1–AC8, TypeScript checks pass, and the repository release gate passes without local OpenAI calls.
- **AC10 — publication and production proof.** Changes are committed, pushed, reviewed via PR, merged to `main`, Railway reaches the merged SHA from GitHub, and one new adaptive widget dialogue is audited from both the buyer UI and admin/internal traces. No contact data or lead is submitted.

## Deliberate scope boundaries

- Do not group retries by exact message text or invent a deterministic semantic `goalId`. The current schema has no trustworthy goal-relation signal; H3 removes the observed retry trigger and AC7 exposes every attempt. A future lineage contract must be LLM-declared and persisted before `customerEffortCount` can be exact.
- Do not stream unvalidated factual drafts. Latency improvements in this change come from source authority, skipping unnecessary calculator calls, and read-only fail-soft.
- Do not rewrite per-card rationale in this correctness patch; dialogue 2185 did not expose a false recommendation caused by the shared reason text.
- Do not add phrase-specific regexes for weight, noise, FUBAG, or the tested dialogue. The FUBAG domain entry is provenance data, not language policy.

## Verification commands

Commands will be recorded verbatim in `evidence.md` and machine results in `evidence.json`. Local AI/provider calls are forbidden by repository instructions; only mocked/unit/static checks run before publication.
