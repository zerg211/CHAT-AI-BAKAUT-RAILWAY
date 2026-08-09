# План исправлений AI-AUDIT-20260809

Статус: `FROZEN FOR EXECUTION` 2026-08-09 после baseline-аудита production и до изменения исходного кода.

## Принцип приоритета

Сначала устраняются дефекты, из-за которых покупатель теряет вопрос, чужой посетитель может вмешаться в сессию, turn необратимо зависает или ответ противоречит уже показанным карточкам. Затем исправляются полнота и доказательность каталога/web-поиска. Долговременное обогащение каталога не разворачивается, пока не доказаны точная идентичность модели, provenance, атомарность и достижимость production-пути.

## P0. Целостность сессии и turn lifecycle

1. Ввести единый visitor-capability guard для всех session-scoped read/write routes: history, heartbeat, send, recover, close и feedback.
2. Сделать создание turn и сохранение user message единым атомарным repository contract. Turn не должен существовать без связанного сохранённого сообщения.
3. Расширить history/session response типизированным `pendingTurn`, не раскрывая внутренние данные: `turnId`, status/stage, deadline и terminal/result state.
4. Клиент при hydrate должен восстанавливать pending/recovering UI, получать уже завершённый ответ без повторного LLM-запуска и не позволять отправить второй вопрос как будто он сохранён.
5. При `active_conversation_turn_exists` клиент обязан использовать возвращённый `activeTurnId`: poll/read existing result или корректно показать pending; новая реплика остаётся в поле ввода и не появляется в истории как сохранённая.
6. Просроченный active turn атомарно переводится в terminal failed/expired перед созданием нового turn. Lease/deadline crash-path покрывается repository/route тестами; heartbeat не может держать orphan-turn вечно.
7. Убрать ложную общую фразу «Вопрос сохранен» из веток, где сервер не подтвердил persistence. Ошибки должны отражать фактический контракт.

Проверка: RED route/client/repository tests на capability, atomicity, active conflict, reload while answering, completed-after-reload и expired orphan; затем GREEN и production widget navigation test с admin readback.

## P0. Контекст, ledger и непротиворечивость ответа

1. `rejectedProductIds` обновляются как явная операция `merge|replace|clear`, а не случайно стираются пустым массивом следующего `need.updated`.
2. Ledger сохраняет provenance и epistemic state факта (`observed`, `confirmed`, source, confidence, timestamp); compaction не превращает наблюдение в подтверждённый факт с confidence=1.
3. Planner получает state после применения ledger delta либо выполняется явный typed replan для любого затронутого ограничения; reducer и planner не принимают независимые решения по старому state параллельно.
4. Предыдущие выбранные/показанные product IDs становятся typed referents текущего хода. При сравнении «этих двух» orchestrator обязан повторно получить exact details по сохранённым IDs; отсутствие fuzzy-result не означает отсутствие уже показанной карточки.
5. Удалить keyword/fragments override, который переписывает валидный LLM intent. Семантику продолжения/уточнения возвращает LLM contract; deterministic код только валидирует referents, обязательные факты и каталог.
6. Verified web facts получают TTL/fingerprint/source state, конфликт не скрывается memory hit; conflict/expiry требуют reread.

Проверка: последовательные ledger tests, 12+ ходов с compact history, смена требований, отказ от товара, pronoun/exact product follow-up, конфликт web/catalog и повторный fetch exact IDs. Live: повторить #1844 и доказать, что цены/карточки не «исчезают» на следующем ходу.

## P0. Полезный terminal answer при web timeout

1. Web timeout не должен уничтожать catalog evidence и расчёт текущего хода.
2. Final/recovery contract формирует полезный предварительный вывод, перечисляет ровно недостающие decisive facts и не обещает продолжить поиск в будущем без нового исполняемого действия.
3. Если web не завершён, система сохраняет ответ как assistant message либо типизированный terminal failure; UI history не теряет видимый результат.
4. Web research получает бюджет по стоимости задачи и этапам, но остаётся внутри общего deadline; результаты отдельных источников checkpoint-ятся, чтобы recovery продолжал с оставшихся требований.

Проверка: deterministic timeout fixtures с частично найденными facts и catalog cards; production exact-model comparisons по генераторам, бензорезам и расходникам с двухсторонним UI/admin аудитом.

## P1. Каталог: точная модель, missing-data и доказательство пригодности

1. Ввести единый `ExactProductIdentity` для retrieval, details, web facts, persistence и cards. Многокомпонентные коды модели сопоставляются целиком; соседняя модификация не принимается.
2. Hard constraints становятся трёхзначными: `satisfied | violated | unknown`. Исключать товар можно только при доказанном `violated`; `unknown` остаётся кандидатом `needsEvidence` и передаётся в web research.
3. Разделить qualifiers мощности (`nominal`, `maximum`, `engine`, `apparent`). Максимальная мощность не доказывает номинальный минимум.
4. Catalog search/details/cards используют один canonical product ID. Текст не может упомянуть товар, которого нет в validated selection/cards, кроме явно помеченного внешнего варианта.
5. `raw`, документы, статьи, product facts и открытые conflicts становятся доступными через отдельные read-only инструменты с provenance; внешнее содержимое считается данными, а не инструкцией.
6. Sitemap/crawler исключают category/listing URL механически; повторный sync заменяет текущий source snapshot и закрывает исчезнувшие facts/conflicts атомарно.

Проверка: exact/similar models, nominal-vs-max, category HTML, missing decisive attribute, proven conflict, current-source replacement, raw/doc retrieval и cards/text parity.

## P1. Безопасное долговременное web-обогащение

Текущий незакоммиченный пакет не принимается. До новой реализации:

1. Удалить его production schema/tool/prompt/embedding additions; сохранить только независимо подтверждённый timeout PDF-теста.
2. Спроектировать fact-level contract: exact product identity, qualified attribute, normalized value/unit, exact quote, HTTP source URL, source tier/domain authority, fetched/verified timestamps, catalog fingerprint, conflicts, status/failure reason и prompt/model version.
3. Сохранять enrichment + verified facts + conflicts одной транзакцией с CAS fingerprint, run lock и checkpoint/cursor.
4. `complete` возможен только при покрытии требуемых facts и отсутствии unresolved conflict. Failed web + catalog description не становится complete.
5. Raw external prose/URL/warnings/timestamps не входят в основной product embedding. Вектор строится только из нормализованных approved facts; prompt-injection строки не исполняются.
6. Запуск — отдельная bounded operation/job с preview, оценкой стоимости, обязательным `--execute`, batch cap, resume/status и sampled provenance readback. Не server startup и не скрытая миграция.

Проверка: neighbor-model rejection, invalid/no-URL source rejection, rollback, concurrent run, pagination >5000, TTL/revalidation, conflict recall, prompt-injection fixture, embedding determinism и production reachability proof.

## P1. Наблюдаемость и Railway

1. Production marker должен ожидать текущий manifest v16 и конкретный deployed commit, а не устаревший v15 default.
2. Railway variables проверяются без вывода значений. Удаляется/исправляется drift неэффективного `OPENAI_MODEL`; production code и marker подтверждают `gpt-5.6-terra` для answer/planner/fact/deep/review.
3. Health/readiness различают процесс, DB/migrations и runtime contract. Admin показывает pending/orphan turns, web source attempts, decisive missing facts и card/answer parity.
4. Миграция запускается ровно в одном документированном Railway lifecycle path; ручной deploy запрещён.

Проверка: status/variables names/health, GitHub commit → Railway deployment match, marker and widget version readback.

## P2. Диалоговое качество и live eval

После каждого P0/P1 tranche выполняется адаптивная матрица через встроенный виджет `https://bakautprof.ru/`, где следующий ход зависит от фактического ответа:

- неясная потребность → правильные уточнения → полный подбор;
- расчёт генератора и смешанная 230/400 В нагрузка;
- exact comparison с отсутствующими паспортными facts;
- ремонт/масло/свеча/фильтр/совместимость по точной модификации;
- отказ от тяжёлых/дорогих товаров и сохранение новых ограничений;
- «эти две модели» после ранее показанных карточек;
- переход по карточке/reload во время ответа и после него;
- commercial boundary и lead только после явного согласия, с синтетическим контактом.

Каждый протокол включает transcript UI, cards/links, latency, admin turn/intent/tools/warnings/recovery/review, persistence readback и экспертную оценку каждого хода. Автоматический PASS без ручного анализа не принимается.

## Порядок коммитов и release gate

1. `test(chat): reproduce session recovery and context-loss defects`.
2. `fix(chat): secure session turns and restore pending answers`.
3. `fix(memory): preserve typed dialogue facts and product referents`.
4. `fix(catalog): keep unknown candidates and qualify product evidence`.
5. Отдельный bounded commit безопасного enrichment только после всех его gates; иначе он остаётся удалённым и оформляется как последующая задача.
6. Полные local gates → свежий verifier → commit/push feature branch → Railway auto-deploy → marker → post-fix production dialogues → merge/push main только при полном release PASS.

## Решение по объёму текущего исполнения

В текущем release обязательно закрыть P0: capability, atomic user-turn contract, pending/reload recovery, orphan terminalization, честную UI-ошибку, сохранение отказов и exact prior-product referents, а также terminal answer с сохранением catalog evidence. P1 реализуется только небольшими независимыми owning-layer изменениями, прошедшими regression и connected tests. Небезопасный bulk enrichment не разворачивается ради формального охвата.
