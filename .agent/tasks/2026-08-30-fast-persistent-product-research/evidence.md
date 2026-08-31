# Evidence

Task: `2026-08-30-fast-persistent-product-research`

Current local verdict: `PASS_AC1_TO_AC10`; production `AC11` is `PENDING_AUTHORIZATION`.

## Builder Evidence

- AC1: exact catalog facts are extracted before verified memory; complete catalog coverage skips both memory and web. Only catalog gaps query verified memory, and only remaining exact product+attribute gaps execute official page/manual before secondary.
- AC2: source requests receive typed exact product names, aliases, canonical attributes, and product+attribute gap slots. No raw buyer-text classifier was added.
- AC3: catalog extraction, concurrent official attempts, secondary fallback, semantic customer-language review, and one reviewed answer repair have bounded calls/deadlines inside the shared wall/provider budget. Source facts and confirmed coverage are validated in one indexed semantic batch per result instead of one provider call per claim. Outer tool retries construct a fresh signal and absolute deadline for each attempt.
- AC4: official page and official manual attempts start independently and race for first completion; complete evidence from either branch cancels the other. Secondary starts only after unresolved official attempts. Off-tier facts, conflicts, and contradicted/ambiguous coverage cannot contaminate the current tier.
- AC5: source acceptance requires per-fact exact model identity, URL, exact verified quote, and semantic product/attribute/value support. A fact labelled for one requested model cannot borrow another model's evidence. Known manufacturer authority uses approved provenance; unknown domains require semantic publisher identity plus an exact excerpt verified against fetched source text. Secondary confidence is capped at medium, and every unread/truncated/source-cap warning blocks source exhaustion.
- AC6: every coverage item now carries typed `productName` ownership (`null` only for genuinely unscoped research). Targeted ownership is canonicalized against exact typed targets; null, unknown, or ambiguous multi-target ownership becomes conservative unresolved slots for every typed target and blocks source exhaustion. All catalog/memory/web coverage merges key and resolve by product+attribute. Persistence independently requires a completed web execution, source title, URL, tier/authority, exact evidence binding, claimed value, no product+attribute conflict, and no unresolved coverage for that exact product+attribute.
- AC7: partial-memory gaps are exact product+attribute slots. Mixed catalog-bound and absent targets retain safe name-only facts for the absent target. Full coverage skips web; partial coverage passes only unresolved slots and merges results. Alias-equivalent catalog, memory, and research product names share one bidirectionally matched exact-model coverage slot, so confirmation removes only the same exact product's stale unresolved item.
- AC8: research stage traces include one actual tier per deterministic attempt, attempt number, elapsed/remaining budget, truthful execution outcome, source count, and accepted fact count. A model-reported confirmed source attempt is downgraded when validation accepts no fact from that tier. Persistence traces include disposition, skip reason, persistable count, and saved count.
- AC9: the production model performs a structured semantic process-disclosure review before send and again after repair; a thrown, timed-out, malformed, or absent reviewer blocks delivery. Product-bound unresolved facts flow into the writer contract only after canonical same-product confirmation precedence removes stale alias-equivalent gaps. A deterministic bilingual fragment guard remains defense in depth and permits ordinary product uses of `инструмент`.
- AC10: focused tests prove orchestrator-level catalog-first short-circuit, fresh outer retry signals/deadlines, bidirectional official concurrency/cancellation, batched fact/coverage validation, fact/conflict tier isolation, unknown-domain publisher proof, secondary fallback, source authority, cross-model rejection, source-cap exhaustion blocking, unknown-owner fail-safe normalization, alias-equivalent product-bound later-confirmed precedence, cross-product catalog/memory/research merge and writer grounding, persistence isolation, failed/timed-out persistence rejection, repeated-write idempotency, mixed/partial memory reuse, truthful source attempts/traces, semantic paraphrase repair, and thrown/absent-reviewer fail-closed behavior.
- AC11: the first production pass failed on deployed commit `ea843b0e3dc4135cfb8cb3373d486cf9028a12db`; the local remediation is not deployed. AC11 requires commit/push, Railway deployment from GitHub, and a fresh adaptive widget/admin dialogue.

## Semantic Boundary Audit

- LLM-owned: buyer intent, typed exact product targets, canonical attributes, semantic source extraction, and natural customer wording.
- Deterministic code-owned: deadlines/signals, source-stage execution, evidence fetch/validation, exact identity, trusted authority, confidence ceiling, conflict handling, persistence, memory coverage, source exhaustion, lead authorization, and output blocking.
- No product-specific customer reply, raw-text semantic classifier, or unsafe generic-brand domain promotion was added.

## Verification

- Focused acceptance set: PASS, 8 files and 252 tests.
- Typecheck: PASS.
- Full release gate: PASS, 863/863 unit tests and 203/203 agentic tests; no-regex, dependency audit, typecheck, and build all PASS.
- `git diff --check`: PASS.
- AC11 Remediation Fresh Verifier 5: PASS for AC1-AC10 with no remaining findings; AC11 remains pending deployment and production proof.

See `raw/commands.md` and `problems.md`.
