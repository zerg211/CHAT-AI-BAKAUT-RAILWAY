# 2026-05-01 Generator load scenario stability plan

## Root cause

Полноценный buyer dialogue показал не одиночный баг слова `чайник`, а слабое место архитектуры подбора генератора:

1. Extractor нагрузки сейчас ведёт себя как bag-of-mentioned-consumers: если потребитель упомянут в тексте, он попадает в load profile.
2. Модель почти не различает intent mention:
   - active load: `будет подключено`;
   - staged/alternative load: `будет, но не одновременно`;
   - excluded / constraint load: `не буду включать вместе`, `не нужен`;
   - explanation-only mention in follow-up.
3. Follow-up ход пересчитывает профиль из текущего сообщения + прошлых items, но новые упоминания могут раздувать hard constraints без явного решения покупателя.
4. Prompt может объяснить осторожно, но hard constraints формируются в коде; значит устойчивость должна быть в кодовой модели сценариев, не в текстовой инструкции LLM.

## Strong fix direction

Не добавлять trigger-word patch типа `если чайник рядом с не буду`, а ввести явный слой scenario semantics для генераторных нагрузок:

1. Перед добавлением reference load item классифицировать роль упоминания:
   - `active`: участвует в текущем основном сценарии;
   - `staged`: нагрузка допустима, но не вместе с другой мощной нагрузкой;
   - `excluded`: не должна повышать текущий подбор;
   - `context`: только вопрос/обсуждение, не новый demand.
2. При построении profile учитывать только `active` items для hard constraints.
3. `staged` items сохранять как caveat/операционный сценарий, но не суммировать в основной simultaneous profile.
4. Отрицания и ограничения одновременности должны работать классами фраз, а не конкретным словом:
   - `не ... одновременно/вместе/разом`;
   - `не буду включать X и Y одновременно`;
   - `X отдельно от Y`;
   - `по очереди`;
   - `без X` / `X не нужен`.
5. Regression должен проверять поведение через selection/load profile, а не только финальный текст.

## RED test first

Добавить тест: после исходного подбора `свет + холодильник + болгарка/дрель` follow-up `роутер, телевизор, ноутбук; чайник и инструмент одновременно включать не буду` не должен:

- добавлять `чайник` как active heating load;
- повышать `requiredNominalKw` до 7+ кВт;
- перескакивать на 7.5 кВт товары, если 4–5 кВт подходят исходному сценарию.

## Verification gates

1. Focused regression RED -> GREEN.
2. Targeted tests:
   `npm test -- --run tests/answerSanity.test.ts tests/turnContract.test.ts tests/generatorLoadReference.test.ts tests/generatorLoadReferenceEnrichment.test.ts tests/recommendationRanking.test.ts`
3. `npm run typecheck`
4. `npm run build`
5. `git diff --check`
6. Full local Playwright 6–7 buyer dialogue.
7. Save final report with explicit NOT RUN for push/deploy/Railway/live unless actually done.
