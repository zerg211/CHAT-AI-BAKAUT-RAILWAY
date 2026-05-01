# 2026-05-01 — LLM selection scope + generator load audit

## Статус

LOCAL GREEN по targeted tests/build и локальному 10-ходовому browser dialogue.

НЕ выполнено: commit, push, Railway deploy, production/live проверка.

## Что было исправлено

### Root cause

Проблема была не в отдельной фразе `из двух`, а в том, что подбор мог снова открыть весь каталог на follow-up, даже когда LLM-план уже классифицировал ход как обсуждение предыдущего selected set.

До фикса `searchScope: 'previousSelectionOnly'` ограничивал часть источников, но при наличии каталога и совпадающих structured constraints в selection могли попасть новые товары из `allProducts`.

### Архитектурное изменение

В `src/ai/assistant.ts` selection теперь сначала берёт LLM-derived turn plan:

- `contextScope: 'previousSelection'`;
- `searchScope: 'previousSelectionOnly'`.

Если LLM классифицировал ход как обсуждение текущего selected set, source pool ограничивается текущими selected/matched/candidate product ids из state. Новый поиск/переранжирование по всему каталогу разрешается только когда LLM-план не `previousSelectionOnly`, например при явном intent заменить, посмотреть дешевле, улучшить или расширить варианты.

В `src/ai/prompts.ts` уточнён prompt planner-а: `previousSelectionOnly` — это семантический выбор по смыслу реплики и текущему этапу, а не список ключевых слов. Примеры вроде `из этих`, `второй`, `запасной` перечислены только как иллюстрации; решение должен принимать LLM по intent/scope.

## RED/GREEN regression

Добавлен test в `tests/recommendationRanking.test.ts`:

`keeps LLM previous-selection scope from introducing new catalogue products`

Сценарий:

- state содержит текущую выбранную пару `current-main`, `current-backup`;
- каталог также содержит более дешёвый и более мощный новый товар;
- LLM-план говорит `contextScope: previousSelection`, `searchScope: previousSelectionOnly`;
- buyer follow-up: `А из этих двух какой сначала брать, а какой оставить запасным?`;
- expected: matched/visible/selected остаются только текущей парой, новые товары не подтягиваются.

До implementation test падал, после fix проходит.

## Аудит расчёта нагрузки генератора

Текущая цепочка источников мощности:

1. Явные данные покупателя: Вт/кВт рядом с потребителем или модель/паспортная мощность.
2. Controlled reference в `src/ai/generatorLoadReference.ts`: curated classes/aliases с running watts, starting watts, confidence, source/sourceNote.
3. Runtime overlay / persisted enrichment: `GENERATOR_LOAD_REFERENCE_PATH` или `RAILWAY_VOLUME_MOUNT_PATH/data/generator-load-reference-overrides.json`.
4. Web-derived entries допускаются только как `source: 'web_average'` с provenance/sourceNote/confidence и `canEstimate`.
5. Unknown/high-risk consumers не становятся финальной основой подбора: они сохраняют preliminary question/caveat или требуют уточнение типа/модели/фазы.

Расчёт профиля:

- только detections с role `active` попадают в immediate load profile;
- `staged`, `excluded`, `context` не раздувают текущую одновременную нагрузку;
- `hasAffirmativeSimultaneousStarting()` включает all-starting model только при утвердительном контексте, а не при `одновременно не буду`;
- explicit buyer values сильнее reference/web average;
- output проверяется sanitation-слоем на невозможные диапазоны кВт.

## Verification commands

Focused regression:

```bash
npm test -- --run tests/recommendationRanking.test.ts -t "keeps LLM previous-selection scope"
```

Result: exit 0.

Targeted regression bundle:

```bash
npm test -- --run tests/answerSanity.test.ts tests/turnContract.test.ts tests/generatorLoadReference.test.ts tests/generatorLoadReferenceEnrichment.test.ts tests/recommendationRanking.test.ts 2>&1 | tee /tmp/bakaut-selection-scope-targeted.log; exit ${PIPESTATUS[0]}
```

Result: exit 0.

Typecheck/build/diff:

```bash
npm run typecheck && npm run build && git diff --check
```

Result: exit 0.

Final diff check after browser script cleanup:

```bash
git diff --check
```

Result: exit 0.

## Local browser dialogue

Driver: temporary `tmp-10turn-dialogue-check.mjs`, removed after run.

Command:

```bash
node tmp-10turn-dialogue-check.mjs 2>&1 | tee /tmp/bakaut-10turn-selection-scope.log; exit ${PIPESTATUS[0]}
```

Result: exit 0.

Scenario shape: 10 buyer turns were generated from the assistant's previous answer, not from an internal fixture phrase about UI implementation. The buyer asked for a daчa generator, narrowed to one main + one backup, asked natural follow-ups about current variants, added non-simultaneous kettle/tool constraint, then explicitly asked about cheaper replacement and finally left contact details.

Checks from `/tmp/bakaut-10turn-selection-scope.log`:

- `turns`: 10;
- `impossibleRanges`: [];
- `inflatedAfterNonSimultaneous`: false;
- `introducedOnCurrentFollowup`: false;
- `hasLeadSaved`: true;
- `showMoreButtons`: `Показать еще 43` present;
- `totalProductCards`: 18 across whole chat history.

Important observations:

- Turn 3 current-selection follow-up did not introduce a new catalogue item; it continued with SUMEC SU4500i / SUMEC SU7700.
- Turn 4 `Чайник и инструмент одновременно включать не буду` did not inflate recommendation to 7.5 kW.
- Turn 6 explicitly asked about cheaper replacement; only then the assistant opened cheaper/new options, which is expected under the new contract.
- Contact handoff path completed: lead saved.

Known caveat: total `.product-card` count is across full chat history, so it accumulates old cards. Per-turn current selected scope was verified by latest assistant responses and card introductions; UI history accumulation itself was not changed in this task.

## Diff / workspace note

`git status --short` shows many modified files from the broader ongoing Bakaut remediation workspace. The active selection-scope patch touched the current task files:

- `src/ai/assistant.ts`;
- `src/ai/prompts.ts`;
- `tests/recommendationRanking.test.ts`;
- this report.

Other modified/new files belong to the earlier generator load/card-contract work in the same workspace and were not deployed in this step.

## Final honest status

Local task is complete and verified locally. Production is not updated until a clean commit/push/deploy/Railway/live check is performed.
