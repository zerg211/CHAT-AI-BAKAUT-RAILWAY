# Production planner-only filter relaxation fix

Дата: 2026-05-02
Scope: production RED в генераторном многоходовом сценарии budget/no-pump/kettle, где после уточнения бюджета и нагрузок карточки обнулялись при наличии подходящих моделей в production catalog.

## RED / root cause

Сохранённый production payload показал слой обнуления не в каталоге: прямой smoke и admin/catalog inspection находили подходящие товары, но multi-turn selection возвращал 0 карточек.

Root cause: planner иногда превращал мягкие предпочтения в hard constraints:
- `conventionalGenerator=false` из фразы про нормальную работу электроники;
- `startType=electric` без явного требования покупателя;
- вместе с `budgetMax=90000` и рассчитанной мощностью это отбрасывало подходящие обычные/ручные генераторы.

## Options considered

1. Prompt-only: отклонено. Planner stochastic; промпт не гарантирует production GREEN.
2. Catalog sync/data-only: отклонено. Продукты есть, simple smoke возвращает карточки.
3. Trigger-word patches: отклонено. Не надо ловить конкретные фразы про электронику/электростарт.
4. Выбранный вариант: provenance-aware fallback. Если строгая выборка даёт 0 результатов, ослаблять только planner-only optional generator traits, сохраняя явные ограничения покупателя.

## Fix

В `src/ai/assistant.ts` добавлен fallback:
- если initial selection не нашёл товаров;
- и optional traits (`startType`, `conventionalGenerator`, `enclosure`) пришли из planner provenance;
- повторить scoring без этих optional planner-only traits;
- сохранить hard constraints покупателя: product intent, budget, power/load, fuel/power constraints.

## Regression

В `tests/recommendationRanking.test.ts` добавлен сценарий:
- бюджет до 90 тыс.;
- насоса нет;
- чайник 2 кВт не одновременно с инструментом;
- нужен без лишнего запаса, но чтобы холодильнику/электронике было нормально;
- planner state содержит `startType=electric` и `conventionalGenerator=false` как planner-only;
- expected: подходящие обычные генераторы остаются в карточках, planner-only constraints сняты.

## Verification

GREEN локально:
- `npm test -- --run tests/recommendationRanking.test.ts -t "planner-only inverter"`
- `npm test -- --run tests/turnContract.test.ts tests/recommendationRanking.test.ts`
- `npm run typecheck`
- `npm run build`
- `git diff --check`
- `npm test -- --run`

Latest full result: 13 test files passed, 141 tests passed.

## Remaining gates

- Commit/deploy pending at time of report creation.
- GitHub push may remain blocked until credentials are available.
- Railway/direct deploy and production live dialogue must be repeated after commit.
