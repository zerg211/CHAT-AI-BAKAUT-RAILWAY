# AI sales-manager quality remediation report — local-only

Date: 2026-05-01
Scope: local repository `/mnt/c/Projects/chatAI` only. Railway/GitHub deploy/push were not touched.

## Status

- Local targeted verification: GREEN
- Local typecheck/build/diff-check: GREEN
- Local full test suite: GREEN
- Local UI Playwright dialogue: GREEN for the guarded stage checks
- Railway/GitHub/push/deploy: NOT RUN / NOT TOUCHED

## Problem class

The broader AI-sales-manager failure was not a single phrase bug. It was a turn-contract/scope problem:

1. On current-selection follow-ups, `previousSelectionOnly` could still include hidden matched/candidate ids even when the current visible `selectedProductIds` represented the real main/backup pair.
2. On late handoff/contact turns, the flow could reopen catalog/search behavior instead of staying in sales handoff mode.
3. Generator load state could keep denied inferred loads, and exploratory power-range questions could be misread as a desired range.

The product contract should be: current visible selected ids are authoritative for follow-ups; broader search is allowed only when the buyer explicitly asks for new/cheaper/better alternatives; final handoff should collect/confirm contact without inventing that an order was already created.

## Changes

### Functional changes

- `src/ai/assistant.ts`
  - Anchored `previousSelectionOnly` selection to current visible selected ids first; matched/candidate ids are fallback only when no selected ids exist.
  - Added deterministic lead handoff answer for checkout/contact turns so the assistant does not wait on answer-model wording or reopen catalog in the final sales step.
  - Added fallback lead handoff detection for contact/name/phone plus manager/availability/delivery/confirmation context.
  - Added negated pump/load handling and compatibility-target cleanup so denied inferred loads do not survive state merge.
- `src/ai/needState.ts`
  - `mergeGeneratorLoadProfile()` now respects `removedKinds` and removes denied estimated loads before merging new items.
- `src/shared/types.ts`
  - Added `ProductGeneratorLoadProfile.removedKinds?: string[]`.
- `src/ai/productClassifier.ts`
  - Protected exploratory/interrogative power-range mentions such as “надо переходить на 7–8 кВт?” from becoming hard desired power constraints.

### Tests

- `tests/recommendationRanking.test.ts`
  - Added regression for visible main/backup pair follow-up staying inside the visible pair, not hidden matches.
  - Added regression for denied inferred pump load removal.
  - Added regression for exploratory 7–8 kW question not inflating recommendations.
  - Added regression for deterministic checkout handoff answer.
  - Added regression for contact details after hot selection being treated as lead handoff instead of reopening catalog.

### Docs / local artifacts

- Updated previous P0/P1 report health URL to the actual local endpoint: `http://127.0.0.1:3010/api/health`.
- Created local Playwright live scripts/artifacts:
  - `tmp-p0-live-dialogue-check.mjs`
  - `tmp-live-smoke.mjs`
  - `tmp-short-pump-live.mjs`
- Latest live result saved outside repo:
  - `/tmp/bakaut-ai-seller-stage2-live.json`
  - `/tmp/bakaut-ai-seller-stage2-live.err`

## Verification

### Focused/targeted tests

Command:

```bash
CI=1 npm test -- --run tests/turnContract.test.ts tests/recommendationRanking.test.ts --reporter=dot
```

Result:

- exit 0
- 2 test files passed
- 108 tests passed

### Typecheck/build/diff hygiene

Command:

```bash
npm run typecheck
npm run build
git diff --check
```

Result:

- exit 0
- typecheck/build/diffcheck ok

### Full local test suite

Command:

```bash
CI=1 npm test -- --reporter=dot
```

Result:

- exit 0
- 13 test files passed
- 139 tests passed

### Local UI Playwright dialogue

Command:

```bash
node tmp-p0-live-dialogue-check.mjs > /tmp/bakaut-ai-seller-stage2-live.json 2>/tmp/bakaut-ai-seller-stage2-live.err
```

Result:

- exit 0
- `ok: true`
- turns: 8
- current selection did not open broad search: `false` for `currentSelectionOpenedBroadSearch`
- explicit cheaper request allowed broaden: `true`
- 7–8 kW exploratory question did not inflate selection: `false` for `nonSimInflatedTo78kw`
- impossible kW ranges: `[]`
- lead handoff detected: `true`
- console errors: `[]`

Observed live quality notes:

- The first broad recommendation turns still render many catalog options with “Показать еще” (`50` then `43` total matches). That is acceptable for broad discovery, but the explicit 1+1 turn did not render extra hidden cards and did not reopen broad search on the follow-up.
- The final contact handoff stayed in handoff mode and did not claim that the order had already been created.
- One live turn had a planner JSON recovery warning in backend logs, but the user-facing guarded checks still passed. This should be monitored separately if planner JSON truncation recurs.

## Current git state summary

`git status --short` at verification time:

```text
 M docs/reports/2026-05-01-p0-p1-product-need-remediation-plan.md
 M src/ai/assistant.ts
 M src/ai/needState.ts
 M src/ai/productClassifier.ts
 M src/shared/types.ts
 M tests/recommendationRanking.test.ts
?? .hermes/
?? docs/reports/2026-05-01-ai-sales-manager-quality-remediation-plan.md
?? docs/reports/2026-05-01-independent-product-need-ai-audit.md
?? docs/reports/2026-05-01-p0-local-live-followup-plan.md
?? tmp-live-smoke.mjs
?? tmp-p0-live-dialogue-check.mjs
?? tmp-short-pump-live.mjs
```

`git diff --stat` for tracked modified files:

```text
 ...26-05-01-p0-p1-product-need-remediation-plan.md |   2 +-
 src/ai/assistant.ts                                |  78 ++++++--
 src/ai/needState.ts                                |   3 +-
 src/ai/productClassifier.ts                        |  11 ++
 src/shared/types.ts                                |   1 +
 tests/recommendationRanking.test.ts                | 211 +++++++++++++++++++++
 6 files changed, 292 insertions(+), 14 deletions(-)
```

## Codex background process note

The background Codex task did not modify files. It exited with auth failure:

```text
token was already used. Please log out and sign in again.
HTTP error: 401 Unauthorized
```

All actual fixes/verifications above were performed directly in this local Hermes session, not by Codex.

## Known issues / next steps

1. Railway/GitHub/deploy were intentionally not run.
2. Local dev processes were used for verification on ports 3010/5173 and were stopped after the report (`fuser -k 3010/tcp 5173/tcp`).
3. Planner JSON truncation/recovery appeared once in local backend logs during the 8-turn live dialogue. It did not break guarded checks, but it is a separate reliability issue to track if repeated.
4. The repo has accumulated untracked local artifacts and reports. Do not commit/push until the user chooses what should be included.
