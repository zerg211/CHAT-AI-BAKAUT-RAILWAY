# Repository security coverage ledger

Date: 2026-07-11
Scan mode: repository-wide standard, risk-ranked runtime inventory
Target: current remediation worktree before production release

This is the finalized coverage artifact, not a findings list. All discovery frontiers below were reviewed against the current source, concrete source-to-sink reachability, deterministic controls and focused tests/read-only probes. There are no remaining temporary, reportable or deferred rows. Baseline weaknesses are retained as `covered_fixed`; paths with no validated weakness are `covered_no_finding`; production-unreachable legacy instances are documented in the validation report as `covered_suppressed`.

| Row | Boundary / shard | Final disposition | Candidate IDs / result | Current evidence and residual |
|---|---|---|---|---|
| SEC-COV-001 | Public chat sessions | covered_no_finding | Turn/session capability and BOLA inventory closed | Strict UUID schemas, session-bound repository predicates, one active turn, payload conflict detection and execution lease; route/repository tests. High-entropy session UUID remains the intentional anonymous widget capability. |
| SEC-COV-002 | Public lead form | covered_fixed | `PUB-LEAD-EMAIL-AMPLIFICATION-001`, `DB-LEAD-IDEMPOTENCY-001` | Stable `clientLeadId`, payload hash, active-session binding, DB uniqueness, outbox idempotency and dedicated rate limit. Fresh-UUID abuse is rate-bounded. |
| SEC-COV-003 | Public API resource/cost controls | covered_fixed | `PUB-SESSION-STORAGE-DOS-001`, `PUB-OPENAI-COST-001`, `OPENAI-BUDGET-ZERO-001`, `sec_review_provider_legacy-001`, `OPENAI-BUDGET-RACE-001`, `CHAT-SEC-DISC-ORCH-BUDGET-001` | Bounded session metadata/body, global route limits, transactional OpenAI reservations and physical per-turn model/tool/web/token/cost/wall/result budgets. No real concurrent PostgreSQL load test; transaction/advisory-lock semantics fail closed. |
| SEC-COV-004 | CORS and browser PNA | covered_fixed | `PUB-CORS-PNA-001` | Exact allowed origins, credentials disabled and PNA development-only; `tests/app.test.ts`. Operator-added origins remain deployment responsibility. |
| SEC-COV-005 | Widget embed and static serving | covered_no_finding | XSS/origin/path inventory closed | Fixed static root, encoded/generated values, bounded query values and tested iframe/widget behavior; no raw template execution or attacker-controlled filesystem root found. |
| SEC-COV-006 | React buyer/admin rendering | covered_no_finding | Stored/reflected XSS and token-storage inventory closed | React text rendering, URL validation and no `dangerouslySetInnerHTML` sink in the active UI. Admin bearer is operator-provided; no public secret response was found. |
| SEC-COV-007 | Admin authentication | covered_no_finding | Authentication bypass inventory closed | Fail-closed configured bearer, timing-safe comparison and a route-wide admin hook; unauthenticated health/read probes return 401. |
| SEC-COV-008 | Admin PII/object operations | covered_no_finding | Protected-object/PII inventory closed | All admin reads/deletes/traces/feedback/health are behind the bearer hook and bounded queries. PII exposure to an authenticated administrator is intentional. |
| SEC-COV-009 | Admin CSV import | covered_fixed | `CATADMIN-FILE-CSV-READ-014`, `CATADMIN-DOS-CSV-015` | Realpath containment beneath configured root, regular `.csv` only, byte/record/row limits. Trusted local CLI override is explicit and not exposed by the route. |
| SEC-COV-010 | Admin crawler start path | covered_fixed | `CATADMIN-SSRF-SYNC-SITE-START-001`, `CATADMIN-SSRF-SYNC-SITE-REDIRECT-002`, `CATADMIN-DOS-CRAWLER-FETCH-009` | Exact catalog origin, resolved-address validation/pinning, per-hop redirect checks, timeout and byte limit through `src/security/outboundHttp.ts`. |
| SEC-COV-011 | Admin sitemap root/index/pages | covered_fixed | `CATADMIN-SSRF-SITEMAP-ROOT-003` through `CATADMIN-SSRF-CONTENT-REDIRECT-008`; `CATADMIN-DOS-SITEMAP-ROOT-010` through `CATADMIN-DOS-CONTENT-PAGE-013` | Every root/child/page fetch uses exact-origin safe outbound controls; file/entry/response limits precede parsing. |
| SEC-COV-012 | Catalog HTML/JSON-LD parser | covered_fixed | Parser/resource instances included in catalog DoS family | Bounded response bytes before Cheerio/JSON parsing; stored fields remain untrusted evidence and React-rendered text. |
| SEC-COV-013 | Catalog destructive synchronization | covered_fixed | `CATADMIN-INTEGRITY-FULL-SYNC-016`, `CATALOG-EMPTY-FULL-SYNC-PRODUCTS-001`, `CATALOG-EMPTY-FULL-SYNC-PAGES-001`, `CATADMIN-DOS-SYNC-LOCK-017` | One global mutation lock for sitemap/crawler/CSV/importMissing, heartbeat/stuck state, prior-inventory ratio/floor before writes, positive/equal coverage and atomic finalize/deactivation. Conservative threshold may retain stale rows, which fails safe. |
| SEC-COV-014 | Public agent web-source retrieval | covered_fixed | `CHAT-SEC-DISC-SSRF-PCSOURCE-001`, `CHAT-SEC-DISC-DOS-PCHTML-001` | Public HTTP(S) destinations only, credentials/nonstandard/private/reserved/mapped/compatible addresses blocked, DNS pinned, redirects/time/bytes bounded. |
| SEC-COV-015 | PDF evidence parsing | covered_fixed | `CHAT-SEC-DISC-DOS-PCPDF-001` | Production PDF parser/dependency removed; PDF URLs/MIME fail closed. |
| SEC-COV-016 | Agent prompt/evidence boundary | covered_fixed | `CHAT-SEC-DISC-ORCH-EVIDENCE-LAUNDER-001`, `CHAT-SEC-DISC-ORCH-FAILED-TOOL-TEXT-001`, `CHAT-SEC-DISC-ORCH-VERIFIED-MEMORY-001`, `CHAT-SEC-DISC-TRUST-PCGENERIC-001` | Shared untrusted-evidence prompt boundary, strict model/tool schemas, exact evidence IDs, source/target/semantic validation, low/conflicting evidence rejection and independent risk review. Third-party sources remain a quality risk, not an instruction authority. |
| SEC-COV-017 | Agent lead side effect | covered_fixed | `CHAT-SEC-DISC-ORCH-LEGACY-LEAD-001` | Structured authorization, exact current-message evidence, deterministic contact extraction, purpose and origin uniqueness; stale/invented contact cannot authorize. |
| SEC-COV-018 | Turn recovery and artifact replay | covered_no_finding | Cross-session/replay inventory closed | Session+turn+request identities, schema-validated checkpoints/artifacts, execution lease, completed-tool reuse, exact final-payload recovery and side-effect uniqueness; focused recovery tests. |
| SEC-COV-019 | PostgreSQL query layer | covered_no_finding | SQL injection/object-isolation inventory closed | Attacker values remain positional parameters; dynamic SQL fragments are developer constants. Session/turn/lead predicates are explicit. |
| SEC-COV-020 | Database migrations and constraints | covered_no_finding | Migration integrity inventory closed | Additive migration ledger, transaction/repair behavior and runtime-equivalent constraints covered by migration tests. Migration files are developer-controlled build inputs. |
| SEC-COV-021 | Lead outbox and HTTP email | covered_fixed | Lead amplification family plus replay state validation | Trusted operator-configured endpoint, bounded HTTP call, auth/idempotency key, `SKIP LOCKED` claim, unique destination and monotonic sent state. Endpoint SSRF is a trusted-configuration boundary. |
| SEC-COV-022 | Feedback/eval export | covered_fixed | `FEEDBACK-EXPORT-PII-001` | Known PII redaction, raw DB IDs omitted, mandatory residual-PII acknowledgement, honest manual-review metadata and path confinement under gitignored `.private/` before DB access. A trusted operator can deliberately promote an artifact after review. |
| SEC-COV-023 | Configuration and secrets | covered_no_finding | Secret/default inventory closed | Zod validation, no secrets in tracked changes, `.env`/`.private` ignored, public health minimized and admin detail protected. Operator environment remains the secret source. |
| SEC-COV-024 | CI/build/deploy | covered_no_finding | Supply-chain/command inventory closed | Read-only workflow permissions, pinned actions, `npm ci`, unified release gate, no manual Railway deploy script/path, production image/source boundary documented. |
| SEC-COV-025 | Runtime command/template/deserialization families | covered_no_finding | Negative sink inventory closed | No public/admin/model/catalog input reaches `eval`, dynamic module execution, shell command or server-side template engine in the deployed runtime. JSON/YAML inputs are developer/config or schema-validated data. |
| SEC-COV-026 | Static/resource and filesystem operations | covered_fixed | CSV path family; feedback export path family | Public static serving uses fixed roots; admin CSV and operator feedback export use explicit containment and limits; no public arbitrary read/write/delete sink found. |
| SEC-COV-027 | Dependencies and parser libraries | covered_fixed | Dependency/parser audit closed | Production PDF parser removed, direct `ipaddr.js` validation added, updated lockfile; fresh `npm audit --audit-level=low` reports 0 vulnerabilities. |

## Production reachability and suppression boundary

The active `AssistantService` dispatches normal generation and recovery to `AgentManagerOrchestrator` before legacy writers. `agentManagerRuntime.ts` makes that runtime mandatory outside tests. Legacy selection/fact/contract candidates retained in `validation_report.md` are suppressed only where both the production dispatch and concrete legacy call chain were checked; they are not silently omitted from validation.

## Explicit inventory exclusions

- `.agent/**`, `.codex/**`, `.claude/**`, `.hermes/**`, local logs, temporary scripts and saved live-test artifacts are not deployed by Dockerfile/Railway and are not privilege-bearing runtime code. Current task security artifacts are evidence only.
- `docs/**`, `local-live-tests/**`, `tmp-live-logs/**` are documentation/evidence only.
- Ordinary `tests/**`, `evals/**`, Playwright/Promptfoo harnesses are test-only and not copied into the runtime image. `tests/aiManagerReleaseGate.mjs` is included as a CI security/release control.
- `dist/**`, `node_modules/**`, caches and generated output are generated/vendored; source and the production dependency graph were reviewed instead.
- `data/**` is local generated/reference data not copied into the production image; runtime-reachable reference loading was reviewed through its code and Docker inclusion boundary.

## Closure references

- `validation_report.md`: 59 unique candidate IDs retained and dispositioned; no current reportable/deferred survivor.
- `attack_path_analysis_report.md`: five baseline attack families calibrated and current source-to-sink paths broken.
- `threat_model.md`: assets, trust boundaries, actors and abuse cases.
- Fresh local proof: final independent full suite 918/918, agentic eval 251/251, typecheck/no-regex/build PASS and audit 0 vulnerabilities.
