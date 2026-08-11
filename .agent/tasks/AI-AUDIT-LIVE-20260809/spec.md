# AI-AUDIT-LIVE-20260809 — frozen specification

Status: **FROZEN before implementation**  
Frozen at: 2026-08-09 (Europe/Moscow)  
Parent task: `AI-AUDIT-20260809`

## Production evidence that opened this task

- Deployed commit `7bf62ef30548666b611aacf76aef5db3ae2cec62`, runtime marker `2026-07-17.gpt-5-6-terra-search-first-v16`.
- Embedded-widget dialogue `#1847`: the assistant first showed Masalta (109,000 RUB) and CHAMPION (76,690 RUB). The buyer then explicitly asked to compare both and changed the budget to 90,000 RUB. Catalog details completed, web research failed, both the initial answer and the one allowed same-turn recovery were blocked by review, and no assistant message was persisted. The widget showed a generic failure.
- Embedded-widget dialogues `#1845` and `#1848`: exact-model technical web research was aborted at 19.5–30 seconds and returned no requested facts.
- Embedded-widget dialogue `#1849`: the buyer requested comparison by weight, compaction force, and price. The planner ran only `catalog.search`; the response admitted that compaction force was missing without a conditional web attempt. Reload during the active turn itself recovered correctly.
- Dialogue `#1850`: no false stock/discount/delivery promise, synthetic lead creation, and reload without reopening the consumed form passed and must not regress.

## Goal

Eliminate the post-deploy comparison dead end and make missing-fact research reachable and bounded, while preserving deterministic catalog eligibility, fact validation, source authority, session fencing, and honest uncertainty.

## Acceptance criteria

### AC1 — Explicit comparison subjects survive eligibility filtering as evidence

When the buyer explicitly compares previously visible products and then adds a hard constraint that one product violates:

- every exact comparison subject remains available to the answer writer/reviewer with its grounded catalog facts;
- the violating product is clearly described as rejected/over the limit, not presented as suitable;
- rejected products are not emitted as recommended cards;
- exact previous-card IDs, names, prices, and current detail artifacts are used instead of fuzzy neighboring models;
- this is implemented as separate factual-evidence and recommendation/card-eligibility roles, not a phrase or model-specific exception.

### AC2 — Numeric rewrite guard distinguishes grounded non-product constraints

The deterministic revised-answer guard accepts a structured, source-backed buyer threshold (for example a 90,000 RUB budget) when it is used to explain fit, even if a product name precedes it in the same sentence. It must still block:

- invented or changed product price/specification numbers;
- raw numeric text from a buyer question that was not promoted to a confirmed structured fact/requirement;
- a requirement/calculator threshold restated as if it were a product specification.

The guard contract must receive structured evidence; keyword/regex interpretation of buyer prose is not acceptable.

### AC3 — Bounded terminal response after the one allowed semantic recovery

If the initial reviewed answer is blocked and the single same-turn semantic recovery is also blocked, the server commits one fenced, useful degraded terminal answer from validated facts/artifacts instead of returning a generic dead end. It must not loop, repeat side effects, invent facts, promise a handoff, or bypass answer/card safety checks.

### AC4 — Catalog-first conditional web repair for requested comparison facts

For selection/comparison turns with structured `grounding.technicalAttributes` that the buyer asked to compare, the runtime repairs a planner omission by adding a typed catalog-first conditional web request when no equivalent request exists.

- full catalog evidence may short-circuit external search;
- missing decisive requested attributes trigger web research for the exact candidates;
- the repair is semantic-contract based, not keyword matching;
- duplicate web calls and web calls for irrelevant context are prohibited;
- failed/partial web remains missing evidence, never a proven conflict.

### AC5 — Web execution window is usable but bounded

An ordinary provider response taking more than 30 seconds can complete while sufficient time remains for composition, review, durable commit, and route terminalization. Timeouts, wall budget, route deadline, terminal reserve, cancellation, and tests must remain mutually consistent. No unbounded wait, blind retry, or manual Railway setting is allowed.

### AC6 — Test-first and regression proof

Retain RED then GREEN evidence for:

1. the exact two-product/changed-budget continuation;
2. rejected comparison evidence versus visible-card eligibility;
3. grounded budget threshold versus invented product numeric claim;
4. second review block terminalization;
5. omitted conditional web repair and catalog short-circuit;
6. updated timeout/deadline/reserve relationships.

Run targeted suites, connected producer/consumer suites, typecheck, no-regex lint, build, production dependency audit, full `verify`, `git diff --check`, and a sanitized secret scan.

### AC7 — GitHub/Railway/live proof

Create a rollback point, commit and push through GitHub, allow Railway GitHub deployment only, and verify exact deployed commit/runtime marker and health. Repeat adaptively through the embedded widget on `https://bakautprof.ru/`:

- the failed Masalta/CHAMPION continuation;
- exact-model missing-fact research;
- a comparison whose catalog result lacks a requested technical attribute;
- reload during an active turn;
- commercial boundary, synthetic lead, and reload without a duplicate form.

For every dialogue, audit visible UI and production admin trace/turn/tools/cards/warnings/recovery. Direct API or localhost is not live proof.

### AC8 — Proof package and final verdict

Create `evidence.md`, `evidence.json`, raw RED/GREEN and live artifacts, `problems.md`, and `verdict.json`. Completion is allowed only when AC1–AC8 are all `PASS`; otherwise the verdict remains `FAIL` with exact blockers.

## Non-goals and invariants

- No model-name, Russian-phrase, keyword, or regex patch for the observed dialogue.
- No weakening of source identity, authority, catalog hard constraints, review validation, auth/capability, execution-owner fencing, or lead durability.
- No direct local OpenAI behavior run and no manual `railway up/deploy`.
- No production dependency addition and no secret/value logging.
- Preserve unrelated user changes; classify every new dirty file before commit.

## Rollback

The already pushed branch `codex/backup-pre-audit-20260809` remains the pre-audit rollback point. Before this follow-up publication, create an additional branch/tag-equivalent Git branch pointing at deployed merge `7bf62ef30548666b611aacf76aef5db3ae2cec62` so the post-live tranche can be reverted independently.
