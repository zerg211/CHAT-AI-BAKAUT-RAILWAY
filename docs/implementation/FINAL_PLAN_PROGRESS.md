# FINAL_PLAN_PROGRESS (F01–F14) — рабочий журнал

Baseline документа: `c8a8835` (2026-09-08). HEAD на старте сессии: `26eaee4`
(Astra-01, 2026-09-10). Документ-план: `BAKAUT_AUTONOMOUS_AGENT_FINAL_PLAN_AND_MASTER_PROMPT_2026-09-09.md`
(F01–F14 — основной; F01–F25 из второго MD смаплены внутрь как детали).
Среда: локальный win32, PostgreSQL доступен для интеграционных тестов,
OpenAI из этой среды недоступен (403), live-виджет — только после push+Railway.

## Статусы

| F | Суть | Статус | Доказательство |
|---|---|---|---|
| F01 | Baseline, журнал, воспроизводимые провалы | DONE (этот файл) | HEAD/маркер выше; `tests/taskOutcome.test.ts` 14/14 |
| F02 | Универсальные web-search/read | DONE (существовало + связано) | `site.readFirstPartyPage`/`site.searchCompanyKnowledge` в registry+executor+contracts+continuation; `tests/siteFirstParty.test.ts` 6/6 |
| F03 | Identity по имени/артикулу/URL | DONE (существовало + связано) | exact SQL без embeddings (`repositories.ts:3799`), `resolveProductIdentity` + `tests/productIdentityResolver.test.ts` 7/7, `extractEvidenceInput` + тест 7/7 |
| F04 | Управляющий цикл + discovery | DONE (существовало + связано) | `injectFirstPartyPageReads` в оркестраторе, `continuationReadTools` расширен, `firstPartyAnswerReviewIssues`+`stalledRepetitionReviewIssues` в releaseValidator |
| F05 | Границы политики/доказательств | DONE (Astra-01 + ранее) | `grounding.search_before_specialist` с границей web, claim-уровни в releaseValidator, `tests/salesManagerBehaviorPolicy.test.ts` 6/6 |
| F06 | Знания lifecycle | VERIFY-EXISTING | worker/queue/enrichment существовали до плана; сквозной found→worker→reuse тест — gap, см. блокеры |
| F07 | Контекст/подбор | VERIFY-EXISTING | ledger/needState/cardSelection + `tests/agentManagerOrchestrator.test.ts` 182/182 |
| F08 | Короткий handoff | VERIFY-EXISTING | lead capture/outbox/idempotency + тесты; Sunreka-like короткий путь — только live, см. блокеры |
| F09 | Естественность | PARTIAL | Astra-01 (self-contained, result-first); blind human review — см. блокеры |
| F10 | Обрывы/ошибки X01–X18 | VERIFY-EXISTING | recovery/outbox/fencing + тесты; реальный chaos — см. блокеры |
| F11 | Стоимость/скорость | PARTIAL | usage guard/pricing/singleflight существуют; before/after замеры — см. блокеры |
| F12 | Независимая приёмка U/A/X/M | PARTIAL | calibration.cjs+mutations.cjs+judge существуют; semantic-прогоны платные — см. блокеры |
| F13 | Удаление/границы | TODO | delete-манифест не составлен; `tmp-*` файлы в корне — кандидаты |
| F14 | Приёмка/вердикт | IN PROGRESS | этот цикл; финальный вердикт — в отчёте |

## Дельта этой сессии (поверх дерева)

1. `taskOutcome` персистится в метадату хода (`agentManagerOrchestrator.ts`):
   `deriveTaskOutcome` из финального состояния (goal, toolResults, blockedReasons,
   durable lead, offer_form, factsUsed, missingFacts). Наблюдаемость F01/F04.
2. F13 single ownership: executor строит ephemeral identity через
   `bindEphemeralPageIdentity` из `productIdentityResolver.ts` и кладёт
   `ephemeralPageIdentity` в payload (было: только `catalogMatch`, без объекта).
3. Этот журнал + evidence ниже.

## Покрытие U/A/X/M (честно)

- D/I-уровень: U02–U07 (exact identifiers/URL), U20–U29 (constraints/budget/topic),
  U15 (contact без имени), X-lease/idempotency — покрыты unit/integration.
- L/W-уровень (настоящая модель/виджет): U01, U08–U14, U16–U19, U30–U40, A01–A10,
  J-пути — требуют paid semantic + staging, в этой среде NOT_RUN.
- M01–M08: harness (calibration/mutations) существует, прогон требует OpenAI.

## Блокеры вердикта YES

1. Нет paid semantic acceptance (OpenAI 403 из этой среды) — нужен кандидатный
   прогон с разрешённым бюджетом (EVAL_*).
2. Нет live/staging buyer journeys (Tecener/адреса/Sunreka) — только виджет
   `bakautprof.ru` после Railway-деплоя.
3. F06 сквозной enrichment-тест, F13 delete-манифест, F11 before/after замеры.

`END_OF_PROGRESS_SNAPSHOT_V1`
