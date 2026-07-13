# Task specification: sales-manager progressive selection

Status: FROZEN
Frozen at: 2026-07-13 10:52 Europe/Moscow
Task ID: `2026-07-13-sales-manager-progressive-selection`

## Objective

Исправить системную антисейлс-логику AI-менеджера: неполные технические данные должны снижать уверенность финальной рекомендации, но не закрывать покупателю каталог, цены и предварительные варианты. Ассистент обязан сохранять и повторно использовать ранее подтверждённые товары, автоматически искать точные или ближайшие варианты и вести покупателя к решению без требования держать под рукой шильдик.

## Production failure frozen as evidence

Session `1cac3ca2-472f-4488-b96d-ac920d1ed310`, embedded widget on `https://bakautprof.ru/policy/?codex_chrome_live=20260713`:

1. assistant calculated a preliminary minimum of 5.5 kW;
2. assistant showed validated EVOline KB 9000 E 8.0 kW at 99,990 RUB;
3. for an explicit request for 5.5-6.5 kW it refused to show cards;
4. for nearest one-phase options from 6.5 kW it incorrectly claimed there were no confirmed candidates, forgetting the already shown EVOline;
5. only after the buyer challenged the contradiction did it recover and show three validated cards.

Current public sitemap contains 103 unique generator product URLs whose catalog names specify 5.5-6.0 kW inclusive. Therefore a retrieval miss must not be presented as catalog absence.

## Product contract

- `not needed` means a feature is optional, not forbidden.
- Only an explicit semantic prohibition such as `only without`, `do not show with`, or `must not have` creates a must-not-have constraint.
- Browsing products and prices, preliminary selection, and final fit are different sales stages.
- Missing load/nameplate facts may block a guarantee of final compatibility, but must not block browsing, prices, or clearly labelled preliminary candidates.
- When exact candidates are not returned, the manager must perform one bounded recovery search and offer the nearest useful alternatives when the buyer permits alternatives.
- Previously validated products are durable session facts. They are rechecked against new requirements and remain candidates until a new requirement actually invalidates them.
- The LLM decides intent, sales stage, semantic requirement relation, and alternative policy. Deterministic code validates catalog facts, prices, phase, power, safety, IDs, and answer/card consistency.
- The customer must not be asked to resolve the store's catalog-data conflict. The agent searches or verifies it and states any remaining uncertainty as the store's limitation.

## Acceptance criteria

### AC1 - Correct semantic relation for optional versus forbidden features

`Автозапуск не нужен` / `automatic start is not needed` does not create a strict absence filter. `Только без автозапуска` / `не показывайте с автозапуском` does create an explicit must-not-have constraint. The distinction is represented in structured planner output or an equivalently explicit typed contract, not a new phrase-specific runtime regex.

### AC2 - Sales-stage-aware selection

The structured manager contract distinguishes at least these intents or equivalent semantics: browse catalog/prices, preliminary fit, final fit. Missing final-fit evidence cannot by itself suppress catalog search, prices, or preliminary cards.

### AC3 - Preliminary help before nameplate verification

For a one-phase home load scenario with a 1.1 kW borehole pump, 1.5 kW grinder, simultaneous operation, and no need for autostart, the same response that gives a preliminary power calculation also returns useful validated preliminary product cards and prices when candidates exist. Nameplate verification is a later caveat, not the admission ticket to the catalog.

### AC4 - Exact-range retrieval is not defeated by top-N noise

When matching products exist at 5.5-6.0 kW, phase/power and supported feature constraints are applied early enough, or the search is expanded/repaired, so irrelevant top-N rows cannot make the assistant claim there are no candidates.

### AC5 - Prior validated-product continuity

A previously validated product is included in the next turn's candidate pool and rechecked against changed requirements even when the new raw search returns non-empty but unusable rows. This does not depend on the planner already knowing to set `reusePreviousCards=true`.

### AC6 - Deterministic ownership of validated selection

An LLM ledger delta with an empty `selectedProductIds` array cannot silently erase a system-validated product selection. Removal requires deterministic invalidation against changed requirements or an explicit buyer rejection.

### AC7 - Bounded catalog recovery

If the first validated pool is empty for an explicit product/price request, the harness performs one bounded, observable recovery step using the planner's semantic alternative policy: broaden/nearest-above-or-below/requery/verify. It must not loop indefinitely.

### AC8 - Useful no-exact-match response

When no exact candidates remain after recovery, the answer states what was searched and immediately offers validated nearest alternatives when permitted. `Не покажу карточки` is not acceptable while any compatible preliminary/compromise candidate is available.

### AC9 - Candidate presentation tiers and grounding

The writer receives enough structured evidence to distinguish exact, preliminary, compromise, and rejected candidates (or equivalent typed tiers). It may not present an unresolved candidate as a final exact fit. Every named model and price must correspond to a validated top-level product and rendered card.

### AC10 - Answer/card/context consistency

Named models, prices, power, phase, autostart assertions, cards, remembered requirements, and calculation remain consistent across turns. Previously shown facts cannot disappear merely because a later search misses them.

### AC11 - Regression coverage

Tests cover:

- optional versus forbidden autostart semantics;
- incomplete nameplate does not block preliminary catalog/prices;
- exact 5.5-6.0 kW candidates survive retrieval/top-N behavior;
- prior validated plus new raw candidates are merged and revalidated;
- empty model-selected IDs do not erase deterministic validated state;
- one bounded recovery and no infinite loop;
- the five-turn production contradiction replay;
- reviewer rejection of an avoidable refusal.

### AC12 - No phrase-specific quick fix

`npm run lint:no-regex` passes and the implementation does not add a one-dialogue canned answer, keyword branch, or fixed model list.

### AC13 - Local release gate

Focused tests, typecheck, `npm run test:eval:agentic`, and `npm run verify` pass on the final current codebase.

### AC14 - GitHub/Railway deployment path

Changes are committed and pushed to GitHub `main`; Railway deploys from GitHub automatically. No manual Railway deployment command is used. `/api/health` reports the exact pushed implementation commit.

### AC15 - Embedded production replay

After deployment, an adaptive dialogue is conducted through the real embedded widget on `https://bakautprof.ru/`. Each next buyer message is based on the actual previous assistant response. The assistant shows useful product/price options before demanding a nameplate, preserves previous candidates, handles an exact-range request, and does not contradict itself.

### AC16 - Production evidence and internal audit

The repository contains a production transcript and admin audit with session/turn IDs, planner/selection contract, calculator outputs, raw/recovery searches, validated candidate tiers, previous-product continuity, warnings/recovery traces, rendered cards, deployment marker, and buyer-view verdict. Every AC is `PASS`; otherwise the task remains incomplete and `problems.md` is updated.

## Non-goals

- Do not promise stock, delivery time, discounts, or special commercial terms.
- Do not weaken deterministic checks for catalog facts, prices, safety, phase, power, IDs, or answer/card parity.
- Do not hardcode the specific EVOline/A-iPower models as a behavioral rule.
- Do not retroactively edit the frozen `2026-07-12-recovery-and-validated-selection` specification.
