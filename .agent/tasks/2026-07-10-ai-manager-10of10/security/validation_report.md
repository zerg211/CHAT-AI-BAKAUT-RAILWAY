# Security candidate validation report

Date: 2026-07-11
Baseline: `2ce1ce43b3804b72e723d403fc355a66331b3358`
Validation target: current remediation worktree before production release

## Method

Every discovery instance is retained even when it is an exact duplicate. A candidate is closed only after all applicable criteria are evidenced:

1. attacker-controlled source and production/admin reachability;
2. nearest trust, authorization, schema, URL/path or size control;
3. concrete side-effect, network, parser, database or buyer-visible sink;
4. baseline-to-current comparison plus a focused regression test or read-only probe;
5. explicit residual gap and current disposition.

`Fixed` means the baseline path existed and the current worktree closes it. `Suppressed` means the candidate cannot reach the sole production runtime or is an exact duplicate retained for traceability. `Mitigated` means a deliberate residual remains but requires an authenticated/operator-controlled action and is disclosed. `Pending revalidation` is not a release-acceptable state.

## Production reachability invariant

`AssistantService` dispatches normal generation and recovery to `AgentManagerOrchestrator` before the legacy assistant writers. `agentManagerRuntime.ts` makes AgentManager the only non-test runtime. Therefore legacy-only findings are suppressed only when both the production dispatch and the concrete legacy call chain were checked; their source rows remain in the ledger below.

## Public/API, budget, lead and feedback candidates

| Candidate ID | Baseline | Current disposition | Primary evidence / residual |
|---|---|---|---|
| `PUB-CORS-PNA-001` | Arbitrary origin reflection, credentials and PNA | Fixed | `src/app.ts`; production exact-origin defaults, credentials off, PNA development-only; `tests/app.test.ts`. Operator-supplied origins remain an explicit deployment responsibility. |
| `PUB-SESSION-STORAGE-DOS-001` | Unbounded persisted session metadata | Fixed | `src/routes/chat.ts` bounds visitor/page/user-agent before repository insert; route and repository tests. Row rate remains globally limited and empty sessions are cleaned. |
| `PUB-OPENAI-COST-001` | Ordinary buyer budget defaulted to disabled | Fixed | Positive global daily budget in `src/config.ts`; guard enforced in `src/ai/openaiUsageGuard.ts`. |
| `OPENAI-BUDGET-ZERO-001` | Same instance as `PUB-OPENAI-COST-001` | Fixed, exact duplicate retained | Same source/control/sink; no row was dropped. |
| `sec_review_provider_legacy-001` | Same instance as `PUB-OPENAI-COST-001` | Fixed, exact duplicate retained | Same source/control/sink; no row was dropped. |
| `PUB-LEAD-EMAIL-AMPLIFICATION-001` | Every public retry created a new lead/email attempt | Fixed | Stable `clientLeadId`, payload hash, active-session check, DB uniqueness, outbox idempotency and route rate limit; migration `015`; route/repository/client tests. Fresh UUID abuse remains rate-limited. |
| `DB-LEAD-IDEMPOTENCY-001` | Same public lead instance | Fixed, exact duplicate retained | Same public instance; agent-origin uniqueness remains separately enforced. |
| `PUB-HEALTH-DISCLOSURE-001` | Models, branch, runtime internals and operational state were public | Fixed | `/api/health` is a minimal commit/runtime deployment marker; models, policy manifest and operational state moved to bearer-protected `/api/admin/health`; `tests/app.test.ts`. Runtime/contract versions remain intentionally public. |
| `OPENAI-BUDGET-SOURCE-SPOOF-001` | Buyer-controlled URL/UA selected a larger quota | Fixed | Canonical exact-host telemetry classification and one shared global budget; negative evil-suffix test. Labels remain telemetry only. |
| `OPENAI-BUDGET-RACE-001` | Non-atomic check and fail-open ledger | Fixed | Transaction, advisory lock and reservation/reconciliation table `016`; migration and guard tests. No real concurrent PostgreSQL load test yet; failures now fail closed. |
| `CHAT-SEC-DISC-ORCH-BUDGET-001` | Nested/retry provider calls escaped per-turn accounting | Fixed | Async-local physical provider-call and reserved-output accounting in shared OpenAI wrapper; turn-budget tests. Future direct SDK clients must use the shared wrapper. |
| `FEEDBACK-EXPORT-PII-001` | Feature absent at baseline; new exporter could retain unknown free-form PII | Fixed for the export boundary | Known values/email/phone/URL redaction, raw DB IDs omitted, honest residual-PII metadata, mandatory acknowledgement, and output confined to git-ignored `.private/` before the first DB read/write. Human review remains required before a trusted operator manually promotes a fixture. |

## Catalog, outbound network and research candidates

| Candidate ID | Baseline | Current disposition | Primary evidence / residual |
|---|---|---|---|
| `CATADMIN-SSRF-SYNC-SITE-START-001` | Absolute start URL reached raw fetch | Fixed | Exact-origin safe outbound fetch, DNS/IP validation and pinning. |
| `CATADMIN-SSRF-SYNC-SITE-REDIRECT-002` | Redirects followed without revalidation | Fixed | Manual redirect loop revalidates every target. |
| `CATADMIN-SSRF-SITEMAP-ROOT-003` | Arbitrary root sitemap URL | Fixed | Exact catalog origin plus safe outbound controls. |
| `CATADMIN-SSRF-SITEMAP-CHILD-004` | Child `<loc>` fetched without destination control | Fixed | Every child uses the same exact-origin/DNS/IP validation. |
| `CATADMIN-SSRF-PRODUCT-PAGE-005` | Product URL lacked resolved-IP validation | Fixed | Safe fetch with DNS pinning and exact origin. |
| `CATADMIN-SSRF-PRODUCT-REDIRECT-006` | Product redirects could change destination | Fixed | Per-hop revalidation. |
| `CATADMIN-SSRF-CONTENT-PAGE-007` | Content URL lacked resolved-IP validation | Fixed | Safe fetch with exact origin. |
| `CATADMIN-SSRF-CONTENT-REDIRECT-008` | Content redirects could change destination | Fixed | Per-hop revalidation. |
| `CATADMIN-DOS-CRAWLER-FETCH-009` | Unbounded crawler response/time | Fixed | Timeout and byte limit before Cheerio. |
| `CATADMIN-DOS-SITEMAP-ROOT-010` | Unbounded root sitemap | Fixed | Per-file bytes, file count and entry count. |
| `CATADMIN-DOS-SITEMAP-CHILD-011` | Unbounded child sitemaps | Fixed | Same bounded inventory controls. |
| `CATADMIN-DOS-PRODUCT-PAGE-012` | Unbounded product HTML | Fixed | Bounded response before parse. |
| `CATADMIN-DOS-CONTENT-PAGE-013` | Unbounded content HTML | Fixed | Bounded response before parse. |
| `CATADMIN-FILE-CSV-READ-014` | Admin path reached arbitrary local file stream | Fixed | Realpath containment, `.csv`, regular file, configured root. Trusted CLI override is explicit and not exposed by admin route. |
| `CATADMIN-DOS-CSV-015` | CSV bytes/records/rows unbounded | Fixed | File, record and row limits. Large authenticated imports remain intentionally finite work. |
| `CATADMIN-INTEGRITY-FULL-SYNC-016` | New deactivation could trust a non-empty incomplete sitemap | Fixed | A full run compares discovered products/pages with prior active inventory before any upsert, using configurable ratio/floor, and fails the run closed; bootstrap remains explicit. |
| `CATALOG-EMPTY-FULL-SYNC-PRODUCTS-001` | Empty product inventory deactivation | Fixed, child instance retained | Positive and matching discovered/imported counts required in code and generated DB eligibility. |
| `CATALOG-EMPTY-FULL-SYNC-PAGES-001` | Empty content inventory deactivation | Fixed, child instance retained | Positive and matching discovered/imported counts required. |
| `CATADMIN-DOS-SYNC-LOCK-017` | Equivalent source aliases could acquire different locks | Fixed | Sitemap, crawler, CSV and inventory `importMissing` mutations share one global advisory lock independent of URL/file aliases. |
| `CHAT-SEC-DISC-SSRF-PCSOURCE-001` | Model-supplied public source reached raw server fetch | Fixed | Safe outbound fetch permits public sources but blocks private/reserved/mapped IPs, credentials, nonstandard ports and redirect changes. |
| `CHAT-SEC-DISC-DOS-PCHTML-001` | Unbounded HTML source/parse | Fixed | Network and Cheerio input limits. |
| `CHAT-SEC-DISC-DOS-PCPDF-001` | Unbounded PDF parse/object graph | Fixed | PDF URLs and MIME responses fail closed; no production PDF parser/dependency remains. |
| `CHAT-SEC-DISC-TRUST-PCGENERIC-001` | Removed generic facts could leave unsupported `directAnswer` | Fixed | High/medium facts and confirmed coverage are source/target/semantic validated, low evidence rejected, and non-starter model-authored direct answer/summary are always removed; completeness is recomputed from surviving evidence. |

Shared outbound evidence: `src/security/outboundHttp.ts`, `tests/outboundHttp.test.ts`. The current implementation additionally rejects hexadecimal IPv4-mapped IPv6 such as `::ffff:7f00:1` via `ipaddr.js`.

## AgentManager, selection and legacy candidates

| Candidate ID | Current disposition | Primary evidence / residual |
|---|---|---|
| `CHAT-SEC-DISC-ORCH-LEGACY-LEAD-001` | Fixed | Lead tool requires structured authorization, exact current-message evidence, purpose and contact extracted from that evidence; regression tests cover denial. |
| `CHAT-SEC-DISC-ORCH-EVIDENCE-LAUNDER-001` | Fixed | Evidence IDs are only deduplicated; unknown IDs are blocked, never replaced with unrelated sources. |
| `CHAT-SEC-DISC-ORCH-FAILED-TOOL-TEXT-001` | Fixed | Failed source/tool references invalidate facts and trigger safe text replacement plus production semantic review. |
| `CHAT-SEC-DISC-ORCH-VERIFIED-MEMORY-001` | Fixed | Every medium/high research fact is source-fetched, target-checked and semantically validated before persistence. |
| `CHAT-SEC-DISC-ORCH-TOOL-ID-001` | Fixed | Duplicate request IDs fail before any tool execution. |
| `SEL-GROUNDING-DEFAULT-001` | Suppressed | Fresh production schema requires grounding; omission exists only for trusted legacy checkpoint/test input. |
| `SEL-SELECTED-IDS-DOWNGRADE-002` | Fixed | Fresh writer schema requires IDs; recovered legacy omission fails cards closed. |
| `SEL-READINESS-MISSING-003` | Fixed | Missing readiness becomes `needs_more_info` and cards false. |
| `SEL-GENERATOR-POWER-UNKNOWN-004` | Fixed | Structured hard-power selection uses fail-closed unknown handling. |
| `SEL-GENERATOR-PHASE-UNKNOWN-005` | Fixed | Unknown phase is rejected under structured hard requirement. |
| `SEL-PLATE-WEIGHT-UNKNOWN-006` | Fixed | Structured numeric hard range rejects missing weight; legacy fallback is production-unreachable. |
| `SEL-CARD-MANIFEST-GAPS-007` | Fixed | IDs must belong to tool-backed pool, be named, satisfy hard constraints and pass readiness. |
| `SEL-FACT-PRICE-008` | Suppressed | Weak legacy fact regex is below production dispatch. |
| `SEL-FACT-TECHSPEC-009` | Suppressed | Same unreachable legacy fact planner. |
| `SEL-FACT-WEB-010` | Suppressed | Same unreachable legacy fact planner. |
| `SEL-GENREF-POISON-011` | Suppressed | Generator overlay caller is legacy-only. |
| `SEL-GENREF-DOS-012` | Suppressed | Generator overlay growth is legacy-only. |
| `chatAI-lead-review-contact-request-lexical-bypass` | Suppressed with compensating control | Mechanical telemetry is lexical, but any current contact content forces semantic review; rewrite is independently rechecked and blocks on failure. |
| `chatAI-lead-repair-unsafe-claim-lexical-bypass` | Fixed | Repair never reuses unreviewed answer text. |
| `LEGACY-CONTRACT-LEAD-ALLOWED-001` | Suppressed | Dangerous legacy default remains below production dispatch. |
| `LEGACY-CONTRACT-AVAILABILITY-OVERRIDE-002` | Suppressed | Legacy semantic availability mutation cannot reach production. |
| `LEGACY-CONTRACT-V2-POLICY-DOWNGRADE-003` | Suppressed | V2-to-legacy information loss cannot reach production. |
| `LEGACY-CONTRACT-FAST-BOOLEAN-004` | Suppressed | Fast legacy families are below dispatch and additionally gated. |
| `LEGACY-CONTRACT-SOURCE-TOOL-DOWNGRADE-005` | Suppressed | Legacy boolean/source/tool downgrade cannot reach production. |

Focused AgentManager validation: 10 files, 157 tests passed. Public/budget validation: 13 files, 82 tests passed. Catalog/network validation before the four pending remediations: 4 files, 22 tests plus typecheck passed.

## Release status

Validation is **final for the current static worktree**: no row remains reportable or deferred. The separate attack-path pass calibrated the baseline families and mechanically assigned `ignore` to every current path because deterministic controls now break the source-to-sink chain. Production deployment and widget behavior remain separate release gates, not part of this static verdict.
