# Problems from fresh verifier — AI-AUDIT-20260809

Дата среза: 2026-08-09. Общий verdict: `FAIL`.

Подтверждённых текущих Critical/High production-code дефектов после последней интеграции нет: исходные H1–H7 и M1–M4 повторно проверены как структурно исправленные, включая real-PostgreSQL turn/message readback и row-lock races. Task остаётся `FAIL`, потому что обязательные publication, Railway и post-fix live критерии не доказаны.

Полный current-code разбор и команды: `raw/integrated-local-verifier.md`, раздел «Финальный повторный local-проход»; краткий вклад в evidence: `raw/final-integrated-verifier-evidence.md`.

## AC6 — dialogues

**Criterion:** Baseline and post-fix adaptive production dialogues together cover multiple personas/categories and the required vague need, comparison, changed requirement, missing-web-fact, maintenance/parts/compatibility, calculation, cards, commercial boundary and authorized-lead matrix; every next buyer turn follows the visible answer.
**Status:** `FAIL`.

- Почему не доказано: существует только baseline protocol; post-fix code ещё не развёрнут и adaptive matrix после fixes не выполнялась.
- Минимальное воспроизведение: перечислить `local-live-tests/*AI-AUDIT-20260809*.production.md`; найден только baseline файл, который заканчивается release `FAIL`.
- Expected: baseline + post-fix embedded-widget protocols вместе закрывают всю frozen matrix.
- Actual: только baseline #1842–#1845; post-fix диалогов нет.
- Affected files: `local-live-tests/2026-08-09-AI-AUDIT-20260809-baseline.production.md`, `.agent/tasks/AI-AUDIT-20260809/evidence.md`.
- Самый маленький безопасный fix: после GitHub→Railway deploy провести недостающие adaptive dialogues через embedded `bakautprof.ru` widget и сохранить отдельный post-fix protocol.
- Corrective hint: следующая реплика должна строиться после чтения фактического ответа. Не использовать localhost/direct API как live evidence.

## AC7 — two-sided live evidence

**Criterion:** Every counted live dialogue has buyer-visible transcript/screenshot or extracted UI evidence plus internal admin metadata/turnContract/tools/cards/warnings/recovery/latency audit; protocols state the embedded `bakautprof.ru` widget was used.
**Status:** `FAIL`.

- Почему не доказано: baseline протокол подтверждает embedded widget, но complete raw admin evidence сохранено не для каждого counted диалога; post-fix UI/admin evidence отсутствует полностью.
- Минимальное воспроизведение: сопоставить #1842–#1845 из baseline protocol с raw widget/admin artifacts. Полный парный набор для каждого ID отсутствует; post-fix IDs отсутствуют.
- Expected: на каждый counted dialogue есть UI transcript/cards/latency и соответствующий admin turnContract/tools/warnings/recovery review.
- Actual: baseline evidence неполон, post-fix evidence отсутствует.
- Affected files: `local-live-tests/2026-08-09-AI-AUDIT-20260809-baseline.production.md`, `.agent/tasks/AI-AUDIT-20260809/raw/baseline-*`, `.agent/tasks/AI-AUDIT-20260809/evidence.md`.
- Самый маленький безопасный fix: сохранить парные sanitized UI/admin artifacts для каждого нового dialogue и дать явную таблицу dialogue ID → оба evidence paths.
- Corrective hint: не засчитывать автоматический PASS без ручной оценки текста, cards и internal cause каждого хода.

## AC11 — Railway/configuration

**Criterion:** Without exposing values, evidence records project/service/environment, GitHub deployment path, build/start/migration contract, production model/runtime marker, required variable-name presence/contradictions, health endpoint and deployed commit match.
**Status:** `FAIL`.

- Почему не доказано: sanitized Railway audit относится к baseline commit `9bc454c`; health probe завершился DNS failure. Текущий post-fix tree не deployed, marker/health/deployed commit match отсутствуют.
- Минимальное воспроизведение: открыть `raw/railway-audit-sanitized.md`; увидеть baseline commit и failed health probe. Сопоставить с current dirty tree — match невозможен.
- Expected: deployed feature commit точно совпадает с проверенным commit, marker/health/readiness и config contract прочитаны после deploy.
- Actual: доказан только baseline operational state, не task build.
- Affected files: `.agent/tasks/AI-AUDIT-20260809/raw/railway-audit-sanitized.md`, `.agent/tasks/AI-AUDIT-20260809/evidence.md`.
- Самый маленький безопасный fix: после GitHub auto-deploy выполнить sanitized status/marker/health/config-name readback и сохранить exact commit match.
- Corrective hint: не выводить variable values и не запускать manual Railway deploy. Проверять только после intentional commit/push через GitHub.

## AC12 — publication and rollback

**Criterion:** Task changes are intentionally committed/pushed from the feature branch; deployment is awaited and matched by marker; merge/push to main occurs only after local gates and feature-deploy/live evidence are sufficient, or the report explicitly stops before merge with reason; rollback branch remains documented.
**Status:** `FAIL`.

- Почему не доказано: current changes остаются uncommitted; push/deploy/marker/live не выполнялись. Rollback branch документирован, но этого недостаточно.
- Минимальное воспроизведение: `git status --short` показывает modified/untracked task files; Railway artifact показывает baseline, не feature commit.
- Expected: intentional feature commit/push, auto-deploy exact match, live gate, затем обоснованное merge или явная остановка.
- Actual: workflow остановлен до publication.
- Affected files: current git worktree, `.agent/tasks/AI-AUDIT-20260809/evidence.md`, `audit-report.md`.
- Самый маленький безопасный fix: только после local evidence closure выполнить согласованный commit/push feature branch, дождаться auto-deploy и записать decision; не merge main при non-PASS live.
- Corrective hint: manual `railway up/deploy` запрещён. Не объединять documentation completion с разрешением на публикацию до закрытия AC6/AC7/AC11.

## AC13 — fresh independent verification

**Criterion:** A fresh verifier judges current repository/current command/live artifacts, writes `evidence.md` and `evidence.json`, and returns PASS for every AC; any failure produces `problems.md`, a smallest safe fix and re-verification.
**Status:** `FAIL`.

- Почему не доказано: fresh verifier, `evidence.md`, `evidence.json`, `problems.md` и `verdict.json` существуют, но несколько AC законно non-PASS. AC13 прямо требует PASS каждого AC.
- Минимальное воспроизведение: проверить required artifact list и текущую AC matrix в `verdict.json`.
- Expected: оба evidence artifacts существуют и все AC имеют PASS после fresh verification.
- Actual: external publication/live AC остаются FAIL; наличие evidence artifacts само по себе не закрывает AC13.
- Affected files: `.agent/tasks/AI-AUDIT-20260809/evidence.md`, `.agent/tasks/AI-AUDIT-20260809/evidence.json`, `verdict.json`, `problems.md`.
- Самый маленький безопасный fix: после фактического устранения всех non-PASS выполнить ещё один independent verifier pass и обновить verdict по новым current artifacts.
- Corrective hint: нельзя сделать AC13 PASS редактированием статусов. Он становится PASS только после фактического закрытия остальных критериев.

## Non-blocking residual risk

Manufacturer authority registry сейчас fail-closed и покрывает только четыре brand groups (`src/ai/productComparisonResearch.ts:556-560`). Для unmapped brands официальный источник понижается до secondary; это безопасный false-negative, но может оставить conflict `unknown`. Расширять registry следует только проверенными доменами и regression fixtures, предпочтительно после production live evidence конкретного false-negative.
