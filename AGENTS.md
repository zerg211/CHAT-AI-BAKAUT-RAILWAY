# Инструкции для Codex в проекте `chatAI`

Проект строит AI-чат менеджера для сайта БАКАУТ. Ассистент должен заменять живого менеджера поддержки и продаж: консультировать по строительному и силовому оборудованию, подбирать товар под задачу, объяснять технические характеристики и вести покупателя к заявке.

## Главный принцип

Не превращать ассистента в набор жестких сценариев, фраз и костылей под один неудачный диалог. Любое изменение поведения должно усиливать универсальную агентную логику:

1. понять реплику и контекст;
2. обновить явные и скрытые потребности;
3. найти или проверить факты;
4. выбрать лучший следующий шаг;
5. ответить как живой менеджер.

Жесткие правила допустимы только как бизнес-ограничения: не обещать точное наличие, скидки, доставку, спецусловия и сроки; вместо этого предложить оставить контакты для профильного специалиста.

## Анализ ошибок и граница LLM/кода

При поиске ошибок в поведении ассистента обязательно проверять не только конкретный сломанный диалог, но и места в коде, где поведение сейчас задается жесткими правилами, regex, if-else, keyword matching, fixed thresholds, canned phrases или fallback-логикой вместо семантического решения LLM.

В каждом таком разборе нужно явно ответить:

1. где код ограничивает или подменяет понимание LLM;
2. где правило работает неправильно из-за отсутствия контекста диалога;
3. где решение должно остаться deterministic-кодом, потому что это проверка фактов, каталога, безопасности, бизнес-ограничений или сортировки;
4. где решение нужно перенести в LLM-планировщик, потому что требуется понять смысл реплики, намерение покупателя, смену требований, допустимость альтернатив, роль числа или товара в контексте;
5. какой структурированный результат должна вернуть LLM, чтобы код мог безопасно исполнить решение без костылей.

Запрещено чинить ошибку только добавлением нового частного правила, если причина в том, что код принимает семантическое решение без LLM. В таких случаях нужно проектировать замену: LLM определяет смысл и политику поведения, а код проверяет факты, применяет ограничения каталога и гарантирует согласованность текста с карточками.

## Поведение AI

- Ассистент использует GPT-5.6 Terra (`gpt-5.6-terra`) через OpenAI Responses API.
- Память действует внутри активной сессии виджета до закрытия вкладки или таймаута неактивности.
- Явные потребности, скрытые потребности, ограничения и подтвержденные факты хранятся отдельно.
- Если покупатель меняет вводные, ассистент не смешивает новые требования со старыми, а уточняет или обновляет состояние.
- Если данных в каталоге не хватает или есть конфликт характеристик, ассистент должен использовать web search и не выдавать непроверенное как истину.
- Ответы должны быть конкретными, человеческими, продажными, без канцелярита и без имитации скрипта.

## Обязательная проверка поведения

Любое изменение, влияющее на продовое поведение AI-ассистента, проверяется только через реальный виджет чата на сайте `https://bakautprof.ru/`. Проверки через `localhost`, локальный iframe или прямой API не считаются валидной live-проверкой продового поведения.

1. открыть сайт `https://bakautprof.ru/`;
2. открыть встроенный виджет чата на сайте;
3. провести живой диалог через интерфейс виджета;
4. перед каждой следующей репликой покупателя прочитать фактический ответ ассистента в интерфейсе;
5. тема проверки может быть задана заранее, но реплики покупателя нельзя писать как случайные заготовки: каждый следующий ход должен логично вытекать из ответа ассистента, его карточек, уточняющих вопросов, ошибок или недосказанности;
6. если ассистент спросил уточнение, ответить именно на это уточнение; если ассистент предложил неподходящий товар или ошибся, следующая реплика покупателя должна естественно возразить или уточнить по этой ошибке;
7. не считать валидной проверкой сценарий, где агент сбросил сессию, не прочитал текущую историю диалога или продолжил заранее написанными фразами без учета фактического ответа бота;
8. после диалога обязательно провести аудит каждого хода с двух сторон: что реально видел покупатель в чате и был ли ответ правильным/полезным/согласованным с карточками; что произошло внутри по admin metadata, логам, `turnContract`, карточкам, warnings, recovery/fallback и коду;
9. простой `PASS` автоматического сценария не считается доказательством качества диалога, если не выполнен ручной аудит правильности ответов и аудит технической причины поведения;
10. сохранить протокол в `local-live-tests/*.production.md` или другом `.md` файле с явным указанием, что проверка была проведена через виджет на `bakautprof.ru`.

Без успешной живой проверки через виджет на `bakautprof.ru` изменение поведения не считается готовым.

## Технический стек

- Backend: Fastify + TypeScript.
- Frontend: React iframe-виджет.
- База: PostgreSQL + pgvector локально и на Railway.
- Каталог: crawler `bakautprof.ru` + CSV-импорт.
- Заявки: PostgreSQL + HTTP email endpoint Railway.

## Ограничения разработки

- Не хранить секреты в git.
- Не использовать SMTP, если Railway уже настроен на HTTP email.
- Не добавлять “быстрые” if-else ответы под одну фразу покупателя.
- Для нового поведения добавлять eval/test-сценарий и live-протокол.

## Правило деплоя

- Все изменения кода отправлять только через `git commit` и `git push` в GitHub.
- Railway в этом проекте подтягивает обновления автоматически из GitHub.
- Не запускать ручной деплой через `railway up`, `railway deployment up`, `railway deploy` или похожие команды, если пользователь прямо не попросил именно ручной Railway-деплой.
- После push проверять продовый marker/виджет, но не пытаться деплоить в Railway напрямую.

## Проверка OpenAI поведения

Локальные проверки, которые вызывают OpenAI через localhost или локальный Promptfoo/live harness, в этой среде невалидны: OpenAI стабильно возвращает `403 Country, region, or territory not supported`. Не тратить время на такие локальные прогоны и не считать их сигналом качества бота.

Для поведения AI-ассистента использовать только путь после `git commit` + `git push` в GitHub, дождаться Railway deployment из GitHub и проверять продовый Railway API/виджет на `https://bakautprof.ru/`. Локально допустимы только проверки без OpenAI-вызовов: typecheck, unit tests с моками, статический аудит кода.

<!-- repo-task-proof-loop:start -->
## Repo task proof loop

For substantial features, refactors, and bug fixes, use the repo-task-proof-loop workflow.

Required artifact path:
- Keep all task artifacts in `.agent/tasks/<TASK_ID>/` inside this repository.

Required sequence:
1. Freeze `.agent/tasks/<TASK_ID>/spec.md` before implementation.
2. Implement against explicit acceptance criteria (`AC1`, `AC2`, ...).
3. Create `evidence.md`, `evidence.json`, and raw artifacts.
4. Run a fresh verification pass against the current codebase and rerun checks.
5. If verification is not `PASS`, write `problems.md`, apply the smallest safe fix, and reverify.

Hard rules:
- Do not claim completion unless every acceptance criterion is `PASS`.
- Verifiers judge current code and current command results, not prior chat claims.
- Fixers should make the smallest defensible diff.
- For broad Codex tasks, bounded fan-out is allowed only after `init`, only when the user has explicitly asked for delegation or parallel agent work, and only when task shape warrants it: use bounded `explorer` children before or after spec freeze, use bounded `worker` children only after the spec is frozen, keep the task tree shallow, keep evidence ownership with one builder, and keep verdict ownership with one fresh verifier.
- This root `AGENTS.md` block is the repo-wide Codex baseline. More-specific nested `AGENTS.override.md` or `AGENTS.md` files still take precedence for their directory trees.
- Keep this block lean. If the workflow needs more Codex guidance, prefer nested `AGENTS.md` / `AGENTS.override.md` files or configured fallback guide docs instead of expanding this root block indefinitely.

Installed workflow agents:
- `.codex/agents/task-spec-freezer.toml`
- `.codex/agents/task-builder.toml`
- `.codex/agents/task-verifier.toml`
- `.codex/agents/task-fixer.toml`
<!-- repo-task-proof-loop:end -->
