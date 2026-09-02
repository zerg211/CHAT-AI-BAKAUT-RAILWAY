# Task: LLM candidate authority

## Source Request

Исправить активные production-пути, в которых deterministic-код отменяет семантическое решение LLM при подборе товаров: неизвестная мощность, источник питания, материал, regex-класс товара и строковые requirement proofs.

## Goal

Существующий answer writer должен видеть все найденные релевантные кандидаты и быть семантическим владельцем `selectedProductIds`, `selectionRationale` и `selectionReadiness`. Deterministic-код должен исключать товар только при доказанном конфликте с обязательным требованием, а отсутствие или семантическая неоднозначность данных должны сохранять товар как предварительного кандидата.

## Acceptance Criteria

### AC1: Unknown generator power survives retrieval

При наличии рассчитанного минимального nominal kW каталоговый фильтр удаляет только товар с подтвержденной номинальной активной мощностью ниже минимума. Товар без подтвержденной номинальной мощности остается кандидатом с warning о неподтвержденном fit.

### AC2: Unknown power source survives selection

При `powerSource=battery|fuel` товар с доказанно конфликтующим источником питания исключается, а товар с неизвестным источником остается предварительным кандидатом до решения LLM writer. Это действует и при `selectionGoal=final_fit`.

### AC3: Unknown material is not incompatibility

Отсутствие упоминания керамики/керамогранита или другого материала в карточке не считается доказанной несовместимостью. Regex/keyword material helpers не могут удалить товар до writer или отменить выбранную writer карточку. Доказанный structured proof conflict по-прежнему может исключить товар.

### AC4: Regex product class does not hard-exclude candidates

`productMatchesIntent()` может использоваться для наблюдаемости или безопасного retrieval hint, но его отрицательный результат не удаляет найденный товар из evidence, не блокирует exact target и не отменяет `selectedProductIds` writer. Exact product identity ограничения сохраняются.

### AC5: Semantic string mismatch is tri-state

`requirementProofs` не выдает `violated` только из-за неравенства/отсутствия substring у открытых текстовых характеристик (material, compatibility, purpose и аналогичные). Такие несовпадения дают `unverified`; доказуемые numeric, boolean, phase/fuel enum конфликты остаются deterministic.

### AC6: Writer remains final semantic selector

Writer получает неизвестные и семантически неоднозначные кандидаты, возвращает выбранные ID, rationale и readiness. После writer код проверяет существование ID, evidence, доказанные factual conflicts и бизнес-ограничения, но не повторяет regex/keyword semantic classification.

### AC7: Regression coverage

Unit tests покрывают неизвестную nominal power, неизвестный power source в final fit, неизвестный material, regex class disagreement и semantic text mismatch. Существующие доказанные numeric/source conflicts продолжают исключаться.

### AC8: Static verification

Проходят `npm run typecheck`, релевантные unit/agentic tests, `npm run lint:no-regex` и `npm run build` без локальных OpenAI вызовов.

### AC9: Production verification

После commit и push Railway marker соответствует отправленному commit. Через встроенный widget на `https://bakautprof.ru/` проведен связный живой диалог, проверены фактический ответ, карточки и admin metadata. Протокол сохранен в `local-live-tests/*.production.md`.

## Constraints

- Не добавлять новые keyword/regex правила под частные формулировки.
- Не ослаблять exact identity, numeric/unit, source authority, lead, safety и business gates.
- Не считать missing data доказанным конфликтом.
- Не вводить дополнительный LLM call, если существующий answer writer contract уже достаточен.
- Не запускать OpenAI через localhost.
- Деплой только через commit и push в GitHub; ручной Railway deploy запрещен.

## Non-goals

- Полная ликвидация legacy regex из репозитория.
- Изменение UI карточек.
- Изменение политики lead capture, наличия, скидок или доставки.
- Переписывание crawler/catalog ingestion.

## Verification Plan

1. Добавить focused unit tests на AC1-AC7.
2. Запустить focused tests, затем полный typecheck, agentic suite, no-regex guard и build.
3. Сохранить команды и raw outputs в task evidence.
4. Выполнить свежую verifier-проверку текущего дерева.
5. Commit и push, дождаться Railway marker.
6. Провести production widget dialogue и сохранить двусторонний аудит UI/admin metadata.

## Assumptions

- `AnswerContract.selectedProductIds`, `selectionRationale` и `selectionReadiness` являются достаточным структурированным semantic result для текущей архитектуры.
- Каталоговый продукт без подтвержденного атрибута может быть показан только как предварительный кандидат с честной caveat, если writer считает это полезным.
