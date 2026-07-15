# Confirmed problems — AI manager production audit v16

This file records failures against the frozen specification. A problem is not closed until its regression passes locally and the affected behavior passes again through the embedded widget on `https://bakautprof.ru/` after the GitHub/Railway deployment.

## V1 — changed generator requirements end in a generic failure

- Severity: P0.
- Acceptance criteria: AC3, AC4, AC5, AC9, AC10, AC11, AC12, AC14.
- Production session: `7e531202-dee1-4576-ae88-2aac09b453c0`.
- Failed turn: `00f5d97a-14f4-42d9-980d-71bd81f461de`.
- Buyer message: `Понял. Но я не хочу бегать заводить его вручную: нужен автозапуск при пропадании сети, бюджет максимум 60 тысяч. Что из показанных вариантов тогда остаётся?`
- Prior visible evidence included `ТСС SGG 5000EHNA`, 5 kW, 230 V, automatic start, catalog price 57,247 RUB.
- Buyer-visible result after more than 120 seconds: `Сейчас не смог надежно сформировать ответ. Вопрос сохранен, повторите его через пару минут.` No assistant message was persisted.
- Turn row: `status=failed`, `stage=recovery_failed`, `errorCode=agent_manager_recovery_failed`.

### Trace evidence

1. The planner correctly understood the semantic change. Its structured policy contains:
   - `needAction=refine_current`;
   - `selectionGoal=preliminary_fit`;
   - `reusePreviousCards=true`;
   - strict requirements for single phase, 220 V, automatic start, and `budget_max_rub=60000`.
2. The current load calculator completed in 15 ms, but the planner labelled unchanged unnamed household loads as `estimateBasis=unbounded_guess`. The deterministic calculator kept only the 1.1 kW pump, emitted incomplete/unbounded warnings, and the catalog gate treated that as a reason to deny a read-only search.
3. `catalog.search` completed in 7 ms with `status=denied` and reason `generator_load_unconfirmed_basis`.
4. `web.researchProductFacts` ended after 19,042 ms with `status=error`.
5. The reviewer then blocked the answer. Recovery invalidated only the answer checkpoint, but reused the same calculator, denied catalog result, and failed web result four times. Block reasons evolved from `unsupported_named_product` / hidden preliminary cards to unsupported claims about the previously shown model.

### Root cause and LLM/code boundary

- LLM responsibility: understand that the loads are unchanged, classify the new automatic-start and budget requirements, decide whether the buyer wants filtering of previous cards or a new search, and return that policy structurally. It did this correctly through `selectionPolicy`.
- Deterministic responsibility: execute catalog reads, calculate numeric load facts, enforce price/phase/automatic-start constraints against evidence, and reject unsupported final-fit claims.
- Incorrect deterministic behavior: `generatorLoadBlocksCatalogAccess()` overrides the structured `reusePreviousCards=true` decision and prevents catalog evidence collection because one current preliminary calculation is incomplete. A read-only search is being treated as though it were an unsafe final recommendation.
- Incorrect recovery behavior: persisted denied/error tool artifacts are considered reusable after a semantic review block, even though they cannot resolve the cited missing evidence.
- Required structured execution outcome: preserve `selectionPolicy.reusePreviousCards`, record per-requirement proof for each candidate, and attach a retry disposition to failed/denied tools so recovery can stop or obtain new evidence instead of repeating composition against identical inputs.

### Required fix

- Permit evidence collection for a structured narrowed follow-up with revalidated previous cards even when the new load calculation is preliminary/incomplete; keep final recommendation safety in card/readiness/reviewer checks.
- Preserve or explicitly reuse the last defensible load profile for unchanged loads rather than replacing it with a weaker current artifact.
- Do not reuse denied/error evidence across answer recovery when the reviewer cites missing grounding that the failed tool was meant to provide.
- Enforce one bounded recovery path and a single persisted turn deadline no greater than 60 seconds.
- Add a regression using the same structured facts, but without matching the buyer's literal wording.

## V2 — latency and recovery budgets permit guaranteed AC11 violations

- Severity: P0.
- Acceptance criteria: AC9, AC10, AC11, AC12.
- Current deterministic limits are 110 seconds per orchestrator execution and 120 seconds at the route.
- Route recovery and client transport recovery can create fresh budgets for the same turn.
- The failed production turn ran from `19:15:42.208Z` through at least `19:17:54.768Z`, then showed a generic client failure.
- Required fix: one persisted deadline per turn, an explicit retry classification, no recovery for a deterministic reviewer block with unchanged evidence, and an end-to-end non-lead ceiling of 60 seconds.

## V3 — exhausted research and contact repair can erase the useful answer

- Severity: P0.
- Acceptance criteria: AC6, AC8, AC9, AC12.
- `web.researchProductFacts` may return transport `status=ok` while semantic `completeness=not_answered`; current handoff logic only reacts to non-`ok` status.
- `leadCaptureRepairText()` sets `baseAnswer=''`, discarding the preliminary model, confirmed facts, and exact missing fact before adding a generic contact request.
- Required fix:
  - distinguish `answered`, `partial`, and `exhausted` research outcomes;
  - preserve useful evidence and the exact unresolved fact;
  - only after sources are exhausted, offer technical verification, ask for a number, and offer message or call;
  - never claim that a request has already been transferred before durable lead capture.

## V4 — successful external facts cannot prove most typed hard requirements

- Severity: P0.
- Acceptance criteria: AC5, AC6, AC12.
- Strict requirement kinds are open-ended in the planner contract, but deterministic proof binding is implemented mainly for generator-load calculations. A successful authoritative web fact for engine, tank volume, noise, wheel kit, phase, or compatibility can still end as `unsupported_strict_requirement_kind`.
- Required fix: add a generic `RequirementProof` mapping with `requirementId`, `productId`, `status`, normalized value/unit, and source result IDs; deterministic code compares supported values and conflicts, while the planner owns semantic requirement meaning.

## V5 — changed needs can retain stale selected product IDs

- Severity: P0.
- Acceptance criteria: AC4, AC5, AC12.
- `dialogueLedgerReducer` currently treats an empty `selectedProductIds` list as preservation unless rejected IDs are also listed.
- Required fix: planner emits and reducer applies an explicit `selectionUpdateMode=preserve|replace|clear` plus invalidated IDs. Empty replacement/clear must not silently preserve old selections.

## V6 — lead submission can show a false success

- Severity: P0.
- Acceptance criteria: AC7, AC9, AC10, AC12.
- Backend currently returns HTTP 200 with `saved_without_outbox` when durable outbox enqueue fails; the widget treats every 2xx as success, clears the form, and tells the buyer a specialist will contact them.
- Required fix: buyer-visible success only after durable enqueue, preserve the form on failure, and audit the originating turn and outbox state.

## V7 — production catalog freshness is unknown

- Severity: external operational blocker for availability/freshness claims; P1 for selection confidence.
- Acceptance criteria: AC5, AC7, AC10, AC15.
- Production `/api/admin/catalog/freshness` reported `status=unknown`, `syncHealth=never_synced`, 4,325 active products and all 4,325 stale, with `latestRun=null`.
- The agent may use catalog descriptions and displayed prices as catalog evidence, but must not imply fresh stock or current availability.
- Required operational work: configure and verify the documented external Railway catalog sync schedule, then confirm a successful full run in admin freshness. This cannot be proven by an application-code change alone.

## V8 — catalog conflicts and semantic duplicates can suppress or duplicate valid products

- Severity: P1.
- Acceptance criteria: AC5, AC6, AC12.
- `ИСТОК АД6-О230-ВМ131Э с АВР` is described as single-phase 230 V, while a conflicting table also contains 230/400 V; the current classifier can label it mixed-phase and the strict card filter can remove it even after official evidence confirms 230 V.
- Two active catalog entries have the same model name for `ИСТОК АД6-Т400-ВМ131Э с АВР`; visible-card deduplication uses product ID only.
- Required fix: authoritative requirement proof must override a conflicting lower-authority catalog field for the proved attribute, preserve the conflict caveat, and visible cards must deduplicate by normalized product identity in addition to ID.

## V9 — numeric model index can become a false voltage conflict

- Severity: P0 for selection correctness.
- Acceptance criteria: AC5, AC6, AC12.
- Fresh verifier probes: `TSS SGG 5000A` with catalog spec `220 V`, and name-only `TSS SGG 2200A`/`2300A` under a strict phase requirement.
- Root cause: the first generic proof implementation added the entire model name as a phase/voltage candidate; numeric parsing read `5000` as voltage. The inherited phase classifier also used bare substring terms `220`/`230`, so model indices `2200` and `2300` could become false single-phase evidence.
- Fix: voltage proof now comes from typed product fields or checked external facts. Bare numeric substring terms were removed from the phase classifier; its existing digit-bounded voltage check still recognizes genuine markers such as `О230` without accepting `2200/2300`.
- Local evidence: regressions `does not treat a numeric model index as a conflicting voltage` and `does not treat 220 inside a four-digit model index as proof of single phase`; final release gate `549/549` PASS.
- Status: locally fixed; production card behavior remains pending AC14 live verification.

## V10 — successful partial research can still request a contact

- Severity: P0 for the search-first policy.
- Acceptance criteria: AC6, AC8, AC12.
- Root cause: the deterministic premature-handoff guard only checked `result.status !== 'ok'`; a technically successful tool result with `researchOutcome=partial` and `sourcesExhausted=false` bypassed it.
- Fix: failed, partial, timed-out, aborted, budget-skipped, and internally inconsistent non-exhausted research states all block technical handoff and contact requests. Only an actual exhausted result permits the final specialist offer.
- Local evidence: regression `blocks a technical handoff after a successful but still partial web result`; final release gate `549/549` PASS.
- Status: locally fixed; production wording and metadata remain pending AC14 live verification.

## V11 — public lead form can lose the pending chat-draft context

- Severity: P1.
- Acceptance criteria: AC7, AC8, AC10, AC12.
- Root cause: the form previously enqueued `{leadId, source}` and then consumed the pending draft in a separate best-effort call. The original question, purpose, and preferred contact method could disappear from the specialist email; cleanup failure could leave a duplicate pending handoff.
- Fix: one SQL CTE now verifies the active session, creates/idempotently reuses the lead, queues a dispatchable outbox with draft context, consumes the matched draft, and clears contact PII atomically. Idempotent retry preserves the prior payload via JSONB merge. Unused legacy form-capture methods were removed.
- Local evidence: repository/route/outbox/email regressions and final release gate `549/549` PASS.
- Status: locally fixed; the migration/CTE still requires Railway PostgreSQL deployment proof and a live contact flow.

## V12 — malformed combined ledger output can invalidate its sibling intent

- Severity: P1.
- Acceptance criteria: AC3, AC4, AC9, AC11, AC12.
- Root cause: combined Terra understanding used strict `parse` for `ledgerDelta`; malformed reducer output failed the whole turn while malformed intent already had a safe fallback. Reusing the sibling intent after replacing the delta would also be semantically unsafe because the intent was planned against the rejected state change.
- Fix: use `safeParse`, trace `combined_ledger_delta_rejected`, call the separate reducer, discard the sibling combined intent, and replan against the corrected ledger state before checkpointing.
- Local evidence: focused combined-understanding regressions and final release gate `549/549` PASS.
- Status: locally fixed; production latency/recovery proof remains pending AC11/AC14.

## Requires clarification or external work

- The application cannot create the external Railway cron described by `docs/CATALOG_PIPELINE.md`. Production catalog freshness remains unproven until that schedule is configured and a full sync run is observed.
- Exact commercial availability, discounts, delivery dates, and special terms require an operational source or a durable human handoff; model reasoning and stale catalog data cannot confirm them.
