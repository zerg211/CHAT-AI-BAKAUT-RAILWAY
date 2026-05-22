# Evidence: exact catalog description research

Task ID: `2026-05-21-exact-catalog-description-research`
Recorded: `2026-05-21T23:18:53+03:00`

## Summary

The implementation routes exact-model technical questions through structured LLM catalog extraction before web research when the exact product card is available. Product `description` is included as first-party catalog evidence, and web search remains a fallback for incomplete or conflicting catalog facts.

The final local adjustment removes the new phrase-based negative-fact guard. Exact-target acceptance now requires both:

- an exact target fact from an allowed source type; and
- structured `answerGuidance.coverage` from the LLM with `status: "confirmed"`.

This keeps the semantic decision in the LLM output and leaves code responsible for schema validation, source routing, and conflict handling.

## Acceptance Evidence

- AC1 no hard-coded product answer / no regex patch: PASS.
  - `npm run lint:no-regex` passed: `No new regex constructs. Legacy baseline: 1828.`
  - The latest local diff removes the added phrase/keyword negative-fact heuristic and relies on structured LLM coverage status.
- AC2 exact catalog extraction before web: PASS.
  - Focused unit test proves `catalog_product_fact_extraction` runs without web tools and returns without web when catalog description answers.
- AC3 web fallback for incomplete catalog facts: PASS.
  - Focused unit test proves incomplete catalog extraction triggers `product_comparison_research` with web search tools and carries `catalogExtraction`.
- AC4 catalog/web evidence merge: PASS by source review and focused tests.
  - Catalog extraction is preserved when web fills missing details.
- AC5 answer path receives product descriptions and checked guidance can rewrite weak text: PASS.
  - Focused orchestrator test proves checked catalog guidance replaces an answer that says the key/button detail is missing.
- AC6 local non-OpenAI gates: PASS.
  - `npm test -- tests/productComparisonResearch.test.ts tests/agentManagerComparisonResearch.test.ts tests/agentManagerIntegrationSource.test.ts`: 3 files, 17 tests passed.
  - `npm run typecheck`: passed.
  - `npm run build`: passed.
  - `npm test`: 73 files, 593 tests passed.
  - `git diff --check`: passed with CRLF warnings only.
- AC7 production behavior validation: PENDING until the latest no-keyword cleanup commit is pushed and Railway serves it.
  - Railway `/api/health` served commit `1aeae873b1feba3492da26dd2c580f60866515b0`.
  - Production Promptfoo through Railway API + `bakautprof.ru` page URL passed: `6/6`, deterministic average `0.9889444444444445`, LLM average `0.94`, assertion pass rate `1`.
  - Targeted production embedded-widget check on `https://bakautprof.ru/` passed. Protocol: `local-live-tests/2026-05-22-exact-catalog-description-widget.production.md`.
  - The widget answer to `Firman RD3910E - заводится с ключа или с кнопки?` was: `Заводится с ключа, через электростартер; также указан ручной стартер. В каталоге БАКАУТ Firman RD3910E есть.`
  - Local Promptfoo/OpenAI eval was not run by project rule because this environment returns `403 Country, region, or territory not supported`.

## Verification Notes

The behavior-impacting pass has both production Promptfoo and targeted embedded-widget evidence for the exact catalog description path. The broader refactor goal is still active because other structural passes remain to audit and complete.
