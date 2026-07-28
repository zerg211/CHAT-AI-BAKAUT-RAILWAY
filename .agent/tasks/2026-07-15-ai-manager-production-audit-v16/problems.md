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

## V13 — combined understanding exhausts the first-turn output and time budget

- Severity: P0.
- Acceptance criteria: AC3, AC5, AC9, AC10, AC11, AC12, AC14.
- Production session: `dc5957d9-32e7-4f6e-8d87-b69ddc9b3868` (`conversationNumber=1783`).
- Failed turn: `a46caa83-cf55-4438-b586-6442cdbc8562`.
- Buyer message: `Нужен дизельный генератор для небольшой мастерской: трёхфазный 380 В, постоянная нагрузка около 8 кВт, нужен автозапуск при отключении сети. Что можете подобрать?`
- Buyer-visible result after 55 seconds: a deterministic terminal timeout with no recommendation, cards, planner contract, ledger update, or tool result.
- Runtime traces contain only `turn.started(recovered=false)`, `turn.started(recovered=true)`, and `terminal_response_committed(reason=turn_work_deadline_exhausted)`.
- Railway logs prove that `agent_turn_understanding` reached the structured-output limit without a balanced JSON object and then launched the same futile JSON retry. Usage records show 8,280 input tokens and exactly 3,200 output tokens for both the original and retry calls.

### Root cause and LLM/code boundary

- LLM responsibility remains semantic: understand the current message and prior state, emit the memory delta, changed-requirement policy, typed tool requests, and grounding plan.
- Deterministic responsibility: enforce a single deadline, checkpoint independent valid model results, execute typed tools, and never repeat a structurally identical call after it has exhausted its output budget.
- Incorrect orchestration: one combined strict schema requires both the ledger delta and the full intent/tool contract in one bounded output. When it truncates, `createStructuredJsonResponse()` repeats the same request at the same cap. The retry consumes the remaining turn budget before either semantic result can be checkpointed.
- Required structured execution outcome: obtain the two semantic contracts through independently bounded Terra outputs, make both available to the planner/runtime without phrase-specific parsing, and preserve whichever valid contract completes first for recovery.

### Required fix

- Remove the over-sized combined structured output from the critical production path; keep Terra for both semantic operations.
- Run the independent reducer and intent planning work with bounded latency and checkpoint valid results independently.
- Do not perform a same-cap structured retry when the response already exhausted the output limit or when the remaining turn budget cannot support a useful retry.
- Add regressions for first-turn concurrent understanding, partial completion/recovery, and no duplicate combined retry.
- Repeat the affected generator dialogue through the embedded production widget after GitHub/Railway deployment.

### Local resolution

- The combined `agent_turn_understanding` path and schema were removed.
- Separate Terra reducer and planner calls start concurrently, serialize the same current message/state/pending-draft context, and checkpoint independently.
- Partial model or checkpoint failure preserves the successful sibling; recovery calls only the missing stage.
- Output-limit exhaustion persists `retryReason=output_limit_exhausted`, skips an identical internal retry, and uses a bounded larger cap on recovery.
- Active-need conflict checks can request one post-delta replan without reacting to resets on a paused sibling need.
- Local release gate after the final implementation: 67 files and 557 tests PASS; agentic eval 191 PASS; typecheck, build, dependency audit, no-new-regex, and `git diff --check` PASS.
- Status: locally fixed; the exact generator dialogue and latency remain pending AC11/AC14 production revalidation.

## V14 — redundant web verification and blocked rewrite discard a useful generator selection

- Severity: P0.
- Acceptance criteria: AC3, AC4, AC5, AC6, AC9, AC10, AC11, AC12, AC14.
- Production session: `877a5c9b-dd36-47b8-8e3c-f17a794106eb` (`conversationNumber=1784`).
- Failed turn: `736c4b01-edc0-41ab-ace0-de5debe94e4c`.
- Deployed commit: `3e98ff40cfd8dfc1f7c2796998eb0ac3082282e3`.
- Buyer message: `Нужен дизельный генератор для небольшой мастерской: трёхфазный 380 В, постоянная нагрузка около 8 кВт, нужен автозапуск при отключении сети. Что можете подобрать?`
- Buyer-visible result after 55 seconds: `Не успел надёжно завершить проверку в пределах этого хода...` No recommendation or cards were shown.

### Trace evidence

1. The separate Terra reducer and planner completed successfully in parallel in 16,664 ms, leaving 38,271 ms. This proves the V13 combined-output bottleneck was removed.
2. `calculator.generatorLoad` completed in 11 ms and `catalog.search` completed successfully in 5,548 ms with preliminary catalog candidates.
3. The planner requested `web.researchProductFacts` only for `req_autostart_1`, while that same requirement was explicitly bound to `verification.mode=product_attribute`; the catalog candidate set was already the deterministic source used to verify automatic start for preliminary selection.
4. The executor nevertheless ran the web request sequentially. It consumed 14,641 ms and timed out, leaving 17,988 ms.
5. A useful answer contract was created at `06:21:55.039Z`. The semantic reviewer then requested a rewrite for `generator_final_fit_at_exact_minimum`; the deterministic rewrite guard correctly rejected the rewritten text because it introduced `review_rewrite_unsupported_numeric_product_claim`.
6. Recovery reused the ledger, intent, calculator, catalog and timed-out web artifacts, but only about nine seconds remained. It could not recompose and review a corrected answer, so the terminal timeout was committed at `06:22:05.016Z`.
7. The planner correctly returned `canonicalProductClass=generator`, but the parallel ledger reducer stored the newly opened active need as `productClass=unknown`. The current conflict check ignores an unknown/known pair, so the weaker class was persisted into the next-turn memory.

### Root cause and LLM/code boundary

- LLM responsibility: understand the generator request, distinguish preliminary from final fit, decide which missing facts are decision-critical, and produce the requirement/source plan. The planner correctly returned `selectionGoal=preliminary_fit`, `canonicalProductClass=generator`, and typed requirements.
- Deterministic responsibility: verify catalog attributes and calculator output, decide whether a planned external read is still necessary after preceding evidence arrives, enforce the absolute deadline, reject unsupported reviewer rewrites, and persist coherent structured state.
- Incorrect deterministic behavior: tool execution treats every planned web request as unconditionally necessary even when a successful catalog result has already satisfied every requirement the web request covers through the requirement's declared `product_attribute` verifier.
- Correct deterministic behavior to preserve: the revised-answer guard must continue blocking invented product identifiers, specifications, prices, and unsupported commercial promises. The fix must not send either the unsafe reviewer rewrite or the original final-fit overclaim.
- Incorrect structured reconciliation: an active need with `productClass=unknown` is allowed to override the parallel planner's known canonical class, even though both outputs describe the same newly opened active need.

### Required fix

- Add an evidence-aware `not_needed` disposition for a supplemental web request in `preliminary_fit` only when successful catalog evidence leaves at least one mechanically valid candidate and every requirement covered by that web request is already verified as a per-product catalog attribute. Do not skip typed web verification, exact-model verification requested by the buyer, final-fit research, conflicts, or an unresolved requirement.
- Persist and trace the `not_needed` tool artifact so recovery remains deterministic and does not rerun the same supplemental web request.
- Keep the semantic reviewer and the deterministic rewrite guard fail-closed; use the recovered answer path with the saved review feedback while enough wall time remains.
- Reconcile `unknown` product class on the newly opened active need from the planner's known `canonicalProductClass`, without changing known conflicting classes or a paused sibling need.
- Add regressions for the conditional web disposition, non-skippable web cases, safe recovery after a blocked rewrite, and active-versus-paused need class reconciliation.
- Repeat the exact generator request through a fresh embedded production widget session after GitHub/Railway deployment.

### Local resolution

- Planner grounding now classifies web evidence as `buyer_requested`, `conditional_on_catalog_gap`, `independent_required`, or `none`.
- The executor records `searchDisposition=not_needed`, `usedWebSearch=false`, `sourcesExhausted=false`, zero attempts, and a dedicated trace only for a preliminary conditional request whose covered per-product attributes are fully proved by catalog evidence.
- Short-circuit is forbidden when another otherwise suitable candidate still has an unverified covered attribute, so a missing catalog field cannot silently remove a plausible product.
- The synthetic web artifact is non-fact-bearing and cannot be cited as checked external evidence. Recovery reuses it without rerunning research.
- One newly opened active `unknown` need is reconciled to the planner's known canonical class; ambiguous/multiple need changes remain untouched.
- Reviewer prompts now keep calculator thresholds in a separate sentence before product names, while the deterministic numeric guard remains fail-closed. Recovery feedback now includes bounded issue evidence.
- Focused V14 suite: 172/172 PASS; full release verification and production widget repetition remain pending.

## V15 — written search-first policy was not fully enforced by runtime research

- Severity: P0 for technical support and sales completeness.
- Acceptance criteria: AC5, AC6, AC8, AC9, AC12, AC14.
- The planner could emit `sourcePolicy=specialist_required` for a technical answer, product selection, or comparison without any web request. The prior premature-handoff guard only worked when a web result already existed.
- General technical research with no exact model and fewer than two catalog products returned `not_needed` before calling web search.
- Official PDF manuals were rejected as unsupported evidence, yet a later retry could still mark the source set exhausted.
- A reviewer rewrite could place a calculator threshold after a product name in the same sentence, causing the correct numeric guard to attribute the calculator number to that product and block the turn.

### Required fix and LLM/code boundary

- LLM remains responsible for interpreting the buyer's technical need and describing the research target.
- Deterministic runtime must convert premature technical `specialist_required` plans into independent web grounding, remove an unexecuted lead side effect, and permit handoff only after an actual `sourcesExhausted=true`/`researchOutcome=exhausted` result. An explicitly authorized continuation of an already offered lead handoff remains operational and is not restarted.
- General technical web grounding must execute even without catalog candidates or a named model.
- Source validation must parse bounded PDF text safely; fetch/parse failure, unread text, truncation, timeout, or abort must never count as source exhaustion.
- Reviewer wording must preserve source attribution: calculator thresholds and buyer requirements precede product names; product numbers follow only their exact product evidence. The deterministic guard must not globally trust calculator numbers as product specifications.

### Local resolution

- Runtime repairs premature specialist plans for `technical_answer`, `product_selection`, and `comparison` into `web_required` plus `independent_required`, removes premature `lead.capture`, and auto-adds the typed web request.
- Pre-send review blocks technical contact/handoff when no genuinely exhausted web artifact exists, including missing, successful-but-answered, partial, failed, timed-out, aborted, and budget-skipped research.
- The one-product/no-target early return was removed; general technical questions now reach web research.
- Official PDF evidence is fetched through outbound URL protections, bounded to 8 MiB and 80 pages, parsed with evaluation disabled, and source-validated like HTML. Unread source warnings force `sourcesExhausted=false`.
- The revised-answer guard now also recognizes catalog numerics stored as a bare value with the unit in the specification key.
- Focused search/PDF/reviewer/orchestrator suite: 172/172 PASS; full release verification and production widget proof remain pending.

## V16 — fresh verification found unsafe proof gaps in the V14/V15 implementation

- Severity: P0/P1 across search-first enforcement, recovery consistency, and runtime isolation.
- Acceptance criteria: AC3–AC6, AC8–AC12, AC14.
- A saved reducer delta could open an active `unknown` need when the sibling planner failed; the recovered planner ran only after the delta was applied, and no second reconciliation repaired the persisted class.
- Any authorized `lead.capture` was incorrectly treated as a continuation, so a first technical message containing a phone number could bypass search-first behavior without proof of a previous exhausted handoff.
- Conditional web skipping compared only the number of attributes and requirements. An unrelated equal-count attribute could replace the covered attribute and still skip research. Mixed web execution metadata also became catalog-only when only one of several web requests was `not_needed`.
- Generic technical research could mark sources exhausted after one unresolved web pass. It did not prove the ordered catalog → official page → official manual → reliable secondary attempts required by policy.
- Numeric rewrite evidence preserved only dimension/value, so maximum power could support a false nominal-power claim.
- In-process PDF parsing was not hard-cancellable and could retain CPU/memory after the turn deadline; a malformed PDF could crash the Node process through the parser's native/runtime path.

### Local resolution

- A deterministic post-plan `need.updated` correction now repairs exactly one newly opened active `unknown` need after partial recovery and persists a stable audit event/checkpoint.
- Technical lead continuation requires prior assistant metadata proving a completed exhausted research result with the same original buyer question, or a matching pending draft. A phone number in the current technical request is not proof.
- Every conditional comparison attribute now has a typed `comparisonAttributeBindings` entry tied to a covered `product_attribute` requirement, and runtime also validates semantic attribute compatibility. Catalog-only source metadata is emitted only when every web artifact is fact-free `not_needed`.
- Research records structured source-tier attempts. Exhaustion requires catalog plus three distinct actually executed web queries for official page, official manual, and another reliable source; missing, duplicate, unread, failed, timed-out, or budget-skipped tiers cannot authorize handoff.
- Product numeric facts and claims carry nominal/maximum qualifiers. A qualified claim matches only the same qualified catalog/web attribute; an unqualified power value cannot be promoted into nominal or maximum power.
- PDF parsing is isolated in a bounded child process with hard kill on timeout/abort, a 256 MiB heap cap, one active parser, a bounded queue matching the four-source research cap, an 8 MiB/80-page/250k-character limit, and content-type/magic-byte routing. Parser crash/OOM cannot execute in the chat server process.
- Focused regressions pass; the final full gate and production widget proof are recorded below after the implementation stabilizes.

## Requires clarification or external work

- The application cannot create the external Railway cron described by `docs/CATALOG_PIPELINE.md`. Production catalog freshness remains unproven until that schedule is configured and a full sync run is observed.
- Exact commercial availability, discounts, delivery dates, and special terms require an operational source or a durable human handoff; model reasoning and stale catalog data cannot confirm them.
