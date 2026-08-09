# Evidence — AI-AUDIT-20260809

Статус на текущем срезе: **LOCAL REMEDIATION VALIDATED / RELEASE PRIMARY SIGNAL NOT MET**. Production-код, контракты и локальные gates зелёные; commit/deploy/post-fix widget live ещё не выполнены. Зелёные unit/eval/build результаты не заменяют embedded-widget signal и PostgreSQL concurrency proof.

## Frozen inputs и публикационная граница

- Spec был frozen до production source changes: `spec.md`.
- Remediation plan был frozen после read-only audit и baseline live: `remediation-plan.md`.
- Baseline production commit: `9bc454c164869c7f1e2c91e2417a50e3ea10b769`.
- Rollback branch создан и pushed: `origin/codex/backup-pre-audit-20260809`.
- Working branch: `codex/full-ai-audit-remediation-20260809`.
- Commit/push feature changes, GitHub-driven Railway deployment и merge в `main` на этом срезе ещё не выполнялись.

## Baseline primary evidence

Production проверялась через встроенный widget на `https://bakautprof.ru/`, не через localhost/direct API.

- Диалоги: `#1842`, `#1843`, `#1844`, `#1845`.
- Протокол: `local-live-tests/2026-08-09-AI-AUDIT-20260809-baseline.production.md`.
- Bounded exports: `raw/baseline-generator-widget.txt`, `raw/baseline-generator-admin.txt`.
- Railway baseline: `raw/railway-audit-sanitized.md`.

Подтверждённые buyer-visible failures baseline:

1. `catalog.getProductDetails=ok` + web timeout завершились generic failure без сохранённого assistant answer (#1842).
2. Exact product/engine не привели к официальным данным по oil/spark/filter; web снова завершился timeout (#1843).
3. После текущего `details=not_found` assistant отрицал предыдущие видимые product cards/prices (#1844).
4. Navigation во время active turn не восстановила pending state/late answer; второе непринятое сообщение было показано как сохранённое и исчезло после reload (#1845).

External control отдельно подтвердил, что нужные Honda/Husqvarna/STIHL/MAGNUS материалы были доступны; repeated production timeout был execution/budget/extraction defect проекта, а не доказанное отсутствие фактов в сети.

## Архитектурный и кодовый итог

- End-to-end и side-path map: `audit-report.md`, текущий раздел с code references.
- Per-High LLM/code boundary: `audit-report.md`, пятичастная матрица H1–H7 и semantic findings.
- Fresh independent code verdict: `raw/integrated-local-verifier.md` и `raw/final-integrated-verifier-evidence.md`.
- Интегрированная RED→GREEN матрица H1–H7/M1–M4: `raw/final-gap-fixes-root.md`.
- Проблемы, которые ещё блокируют release claim: `problems.md`.

Текущий independent verifier не нашёл подтверждённых незакрытых Critical/High дефектов после полного fix/reverify loop. H1–H7 и M1–M4 structurally resolved. Реальный PostgreSQL последовательно нашёл два скрытых mock-тестами дефекта — message-after-turn sibling CTE и create-first/queued-close old-snapshot turn — оба исправлены на owning repository layer. Atomic replay/readback, обе close-vs-create ordering и ещё три row-lock barrier race теперь PASS. Rendered-widget behavior остаётся внешним live gate AC6/AC7.

### Builder/root raw evidence

| Область | Артефакт | Сохранённый сигнал |
|---|---|---|
| Ledger/provenance | `raw/ledger-builder.md`, `raw/need-provenance-root.md` | RED malformed/epistemic/list-patch/timestamp → reducer 15/15, model 2/2, connected 173/173. |
| Session/turn/client | `raw/session-turn-builder.md`, `raw/client-race-fixer.md`, `raw/server-race-fixer.md`, `raw/durable-fencing-toctou-fixer.md` | RED capability/atomicity/pending/optimistic/stale-writer → targeted 65/65, lifecycle 94/94, connected 225/225 и 230/230. |
| Referents/terminal | `raw/product-referents-builder.md`, `raw/terminal-recovery-root.md` | Baseline #1842/#1844 regressions RED → orchestrator 144/144, затем current 150/150. |
| Tri-state/semantics | `raw/tristate-catalog-builder.md`, `raw/semantic-coherence-builder.md` | Unknown≠violated, nominal qualifiers, removal/replan; connected 207/207 и 313/313. |
| Exact identity | `raw/exact-product-identity-builder.md` | Split/join/suffix/neighbor regressions → 10/10 utility, 73/73 connected. |
| Product page/catalog snapshot | `raw/page-identity-fixer.md`, `raw/catalog-snapshot-root.md` | Listing/category/sparse page RED; transaction fault RED → page identity 17/17, connected catalog checks green. |
| Verified fact memory | `raw/verified-fact-memory-root.md`, `raw/catalog-memory-lifecycle-root.md` | TTL/URL/conflict/fingerprint/supersession/exact-ID RED → memory/research 64/64, catalog+memory 18/18. |
| Source authority | `raw/source-authority-root.md` | Marketplace-as-official 2 RED → authority/research 52/52; independent current product research 38/38. |
| Dependency security | `raw/dependency-audit-root.md` | Production High findings 3 → 0; dev-only transitive residual retained explicitly. |
| Real PostgreSQL session races | `raw/postgres-session-race-proof.ts`, `raw/postgres-close-create-verifier.ts`, `raw/final-gap-fixes-root.md` | Два successive real-DB RED исправлены; idempotent linked turn/message readback, обе close-vs-create ordering и 3 дополнительных row-lock races PASS. |

Промежуточные non-zero результаты не скрыты. В частности, verifier сохранил H7 shared-tree run 35 PASS/3 FAIL до обновления fail-closed fixtures, затем fresh 38/38 PASS; aggregate run с двумя 5-second timeout был повторён последовательно 25/25 PASS. Real PostgreSQL script сначала завершился `ConversationSessionUnavailableError` ещё при создании turn и не дошёл до races; permanent focused test подтвердил RED. После owning fix script и full gate были повторены успешно. Детали находятся в `raw/integrated-local-verifier.md` и `raw/final-gap-fixes-root.md`.

## Dirty-tree evidence

- Полная исходная и финальная классификация: `dirty-tree-disposition.md`.
- Unsafe unreachable web-enrichment удалён после per-file audit; исходные feature files readback-ом отсутствуют.
- Содержимое `.scratch/` удалено; пустая локальная директория ignored; `.scratch/` добавлен в `.gitignore`.
- Независимый PDF child-process test timeout сохранён.
- Свежий видимый status inventory до commit: 51 path — 44 modified + 7 untracked; все перечислены в disposition.
- Исторические ignored `local-live-tests/**`, кроме протоколов именно этой задачи, исключены из release staging set.

Raw initial `git status --short` не был сохранён отдельным immutable artifact до начала builder work. Это ограничение provenance отмечено явно. При этом frozen AC9 требует перечислить и объяснить каждый исходный dirty path, а не сохранить snapshot в конкретном формате: disposition содержит полный contemporaneous initial inventory, verdict каждого path и current absence proof удалённых unsafe paths, поэтому AC9 оценивается PASS.

## Свежий local command ledger

Все результаты ниже относятся к текущему production-code состоянию после последних H1–H7/M1–M4 fixes.

### Единый release gate

Command: `npm.cmd run verify`

Result после последнего close-vs-create owning fix: exit 0, `[release-gate] PASS: all local release checks succeeded.` Внутри gate последовательно выполнены:

- Node.js runtime: PASS, `24.14.1` (требование ≥22).
- No new regex constructs relative to `HEAD`: PASS; legacy baseline 508 не увеличен.
- `npm audit --omit=dev --audit-level=high`: PASS, 0 production vulnerabilities.
- TypeScript typecheck client+server: PASS.
- Full unit/contract suite: 77 files, 834/834 PASS.
- Agentic eval suite: 4 files, 249/249 PASS.
- Production build: PASS; Vite client build + server TypeScript emit завершены.

Release-gate напечатал один non-failing Node `DEP0190` warning из-за Windows shell invocation. Exit остался 0; runtime/test/build failure не было. Warning не скрыт и требует отдельной технической уборки, но не меняет текущий gate result.

### Дополнительные свежие сигналы

- Отдельный fresh `npm.cmd test`: exit 0, 77 files, 834/834 PASS.
- `npm.cmd run typecheck`: exit 0.
- `npm.cmd run lint:no-regex`: exit 0, no new constructs; legacy baseline 508.
- Fresh connected remediation bundle: 7 files, 286/286 PASS.
- После PostgreSQL-discovered fix connected lifecycle bundle: `npm.cmd test -- --run tests/conversationRepository.test.ts tests/chatSessionLifecycle.test.ts tests/chatStream.test.ts tests/chatHistory.test.ts tests/leadRoutes.test.ts tests/leadSubmit.test.ts` → exit 0, 6 files/99 PASS. Первый connected run дал 98 PASS/1 FAIL из-за устаревшей test-only alias assertion; assertion привязана к owning SQL alias, production guard не ослаблялся.
- Independent verifier bundles: 99/99 catalog/memory/source/identity; 115/115 ledger/session/client; 65/65 H1/H6/M1; final connected selection/session bundle 136/136.
- Fresh post-close-fix `git diff --check`: exit 0; только LF→CRLF conversion notices, whitespace errors отсутствуют.

### M4 detached-baseline RED → current GREEN

- Detached baseline worktree, `HEAD=9bc454c`: `npm.cmd test -- --run tests/chatHistory.test.ts -t "does not reopen a consumed latest lead offer after reload"` → exit 1, 1 failed / 13 skipped; actual `leadRequested:true`, expected false.
- Current owning regression: `npm.cmd test -- --run tests/chatHistory.test.ts -t "does not reopen the latest lead offer after a durable lead was submitted for it"` → exit 0, 1 passed / 18 skipped.
- Этот retained pair закрывает последний пробел integrated RED→GREEN chronology: old assistant lead offer не открывается повторно, если после него durable lead уже создан.

### Real PostgreSQL RED → GREEN

Первый запуск real-DB proof обнаружил дефект, который mock query tests не видели: `createTurnWithUserMessage` делал `INSERT conversation_turns`, а затем sibling data-modifying CTE пытался обновить ту же строку. PostgreSQL вернул `ConversationSessionUnavailableError`; barrier cases не запускались.

- Permanent focused RED: `npm.cmd test -- --run tests/conversationRepository.test.ts -t "creates the turn and its user message in one statement"` → exit 1, 1 failed / 38 skipped; `INSERT INTO messages` следовал после `INSERT INTO conversation_turns`, присутствовал sibling `updated_turn`.
- Owning fix: user message вставляется первым; turn сразу получает `user_message_id`; sibling update удалён.
- Тот же focused command после fix → exit 0, 1 passed / 38 skipped.
- Command: `npx.cmd tsx .agent\tasks\AI-AUDIT-20260809\raw\postgres-session-race-proof.ts` → exit 0.
- Для каждого созданного turn identical operation replay подтвердил тот же turn ID, ровно одно persisted user message, non-null linked `user_message_id` и отдельный message readback.
- Four-client PostgreSQL barriers PASS: `close_vs_feedback`, `close_vs_final_answer_commit`, `new_owner_vs_stale_durable_write`; после каждой гонки выполнен state readback, а созданные sessions удалены в cleanup.

### Real PostgreSQL close-vs-create RED → GREEN

Independent verifier выполнил второй четырёхсоединительный barrier test. До fix create-first ordering завершала queued close со `session=closed`, но turn оставался `received/user_message_saved` без error из-за snapshot data-modifying statement, начатого до commit create transaction.

- Owning fix: `closeSession` для real pool использует одну explicit transaction с последовательными statements на одном connection: exact capability + active session row lock; fresh-snapshot turn terminalization; session close; pending draft expiry. Mock/non-pool adapter сохраняет тот же ordered contract.
- Targeted command: `npm.cmd test -- --run tests/conversationRepository.test.ts -t "locks the exact live capability before terminalizing turns in a fresh transaction snapshot|creates the turn and its user message in one statement" --testTimeout=20000 --maxWorkers=1 --no-file-parallelism` → exit 0, 1 file, 2 passed / 37 skipped.
- PG command с локальной loopback test DB, без сохранения/вывода DSN: `npx.cmd tsx .agent\tasks\AI-AUDIT-20260809\raw\postgres-close-create-verifier.ts` → exit 0.
- `close_first_rejects_without_orphans`: create ждёт session lock, после close fail-closed; turn/message counts остаются 0.
- `create_first_links_then_close_revokes`: accepted user message и link сохраняются; queued close после commit terminalize-ит turn как `failed/session_closed` и закрывает session.
- После close fix общий `postgres-session-race-proof.ts` свежо повторён: exit 0, все прежние 3 cases PASS.

### Secret/file-scope hygiene

Sanitized bounded scan использовал `rg -l --hidden`, исключая `node_modules`, `dist`, `.git`, `.scratch`, по целям:

- `src`
- `tests`
- `evals`
- `package.json`
- `package-lock.json`
- `.gitignore`
- `.agent/tasks/AI-AUDIT-20260809`
- `local-live-tests/2026-08-09-AI-AUDIT-20260809-baseline.production.md`

Проверялись только credential-shaped patterns: `sk-(proj-)?`, credential-bearing PostgreSQL DSN, private-key headers и присвоенные значения OPENAI/RAILWAY/RESEND/ADMIN key/token/password. Fresh post-close-fix результат: `unexpected_secret_files=0`, `secret_scan=PASS`, exit 0. Совпавшее содержимое не печаталось.

После добавления real-PG и финальных evidence artifacts тот же credential-shaped `rg -l` pattern повторён для четырёх owned evidence files и обоих PG scripts: `owned_secret_matching_files=0`, exit 0.

Отдельный suspicious-filename scan: count 1 — исключённый historical ignored `local-live-tests/2026-04-27-token-budget-optimization.local.md`. Он не входит в release staging set; содержимое не печаталось.

No raw Railway variable values сохранены в репозитории. Admin credential rotation остаётся security-sensitive external blocker до явного разрешения пользователя; mutation не выполнялась.

### Dev-only dependency residual — non-zero не скрыт

Command: `npm.cmd audit --audit-level=high`

Result: exit 1, пять High transitive findings только в development path `promptfoo -> @huggingface/transformers -> onnxruntime-node` (`adm-zip <0.6.0`, `sharp <0.35.0`). npm предлагает только forced breaking downgrade до `promptfoo@0.120.14`; он осознанно не применён, чтобы не сломать текущий eval contract. Эти packages отсутствуют в Railway `--omit=dev` install и не меняют production audit=0, но риск должен быть пересмотрен при совместимом upstream release. До этого нельзя подавать недоверенные ZIP/image artifacts в optional local transformer features.

## Railway/config baseline evidence

`raw/railway-audit-sanitized.md` подтверждает без вывода values:

- project `laudable-unity`, environment `production`, services `chat-ai` и PostgreSQL healthy;
- GitHub source `zerg211/CHAT-AI-BAKAUT-RAILWAY`, branch `main`, Dockerfile, one replica in Europe west;
- domains `chat.bakautprof.ru` и `bakaut-chat.vexr.dev`;
- требуемые variable names присутствуют; production code принудительно использует Terra несмотря на drift значения `OPENAI_MODEL`;
- baseline deployed commit `9bc454c...`; marker drift v15→v16 исправлен локально;
- manual Railway deploy не выполнялся и не должен выполняться.

AC11 пока FAIL: evidence относится к baseline. После GitHub push нужно доказать exact deployed feature/main commit, runtime marker, health/readiness и только затем считать Railway часть актуальной.

## Acceptance criteria — честный срез до deploy/live

| AC | Builder evidence status | Основание / что отсутствует |
|---|---|---|
| AC1 | PASS | Current end-to-end/side-path map с code references присутствует в audit report. |
| AC2 | PASS | Для всех High заполнена пятичастная LLM/code boundary matrix. |
| AC3 | PASS | Exact/fuzzy/hard/soft/comparison/missing/conflict catalog path и regressions покрыты. |
| AC4 | PASS (local code) | Mandatory web, exact target/source, conflicts, strict exhaustion, timeout и verified memory producer/repository/consumer согласованы. |
| AC5 | PASS | Session/history/ledger/hydrate contracts зелёные; real PostgreSQL подтверждает idempotent atomic turn+message, обе close-vs-create ordering, close-vs-feedback, close-vs-final и stale-owner takeover fencing. Rendered post-fix widget относится к AC6/AC7. |
| AC6 | FAIL | Post-fix adaptive production dialogues ещё не проведены. |
| AC7 | FAIL | Нет post-fix two-sided UI + admin/turnContract/cards/warnings/latency evidence. |
| AC8 | PASS | Для всех implemented behavior changes сохранена owning-layer RED→GREEN chronology; последний M4 подтверждён detached-baseline failure и current focused GREEN. Нового narrow keyword/regex route нет. |
| AC9 | PASS | Disposition перечисляет и объясняет каждый исходный dirty path, доказывает удаление unsafe paths и классифицирует полный current tree. Raw initial status отдельно не сохранён, но frozen criterion не требует конкретного snapshot format. |
| AC10 | PASS | Единый current release gate, full suite/eval/typecheck/build/lint, production audit, diff check и secret/file scan exit 0. Dev-only audit residual отделён. |
| AC11 | FAIL | Baseline Railway audited; post-fix deployed commit/marker/health match отсутствует. |
| AC12 | FAIL | Rollback branch есть, но feature commit/push/deploy/merge ещё не выполнены. |
| AC13 | FAIL | Fresh verifier существует и artifacts созданы, но все AC не могут быть PASS до обязательных external/live gates. |
| AC14 | PASS | Completion не заявляется; primary signal честно `NOT MET`. |

## Следующие обязательные gates

1. Fresh verifier перечитывает текущие artifacts и обновляет verdict; неизвестные/failed AC не маскируются.
2. Intentional staging + bounded staged secret/diff readback; commit/push только через GitHub.
3. Дождаться Railway auto-deploy и exact deployed commit/marker/health/readiness.
4. Провести post-fix adaptive диалоги через embedded `https://bakautprof.ru/`: vague need→cards, exact comparison, changed requirement, missing web fact, maintenance/parts/compatibility, calculation, commercial boundary, authorized synthetic lead, navigation/reload recovery.
5. Для каждого хода сохранить buyer-visible UI и admin `turnContract/tools/cards/warnings/recovery/latency`; следующий buyer turn формировать только после чтения фактического ответа.
6. Defense-in-depth follow-up: при необходимости расширить stale-owner real-PG race с artifact на остальные durable mutation types; текущий independent verifier принимает frozen AC5 как PASS.
7. Merge/push `main` только если release gates достаточны; иначе сохранить feature branch и точную rollback-инструкцию.

Primary signal status: **NOT MET до post-deploy embedded-widget live; локальный code/DB proof, включая AC5, PASS**.
