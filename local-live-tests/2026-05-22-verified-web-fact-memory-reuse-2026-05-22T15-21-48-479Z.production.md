# Verified Web Fact Memory Reuse Production Check

Date: 2026-05-22T15:21:48.479Z
Site: https://bakautprof.ru/ via embedded widget
Production API: https://chat-ai-production-3057.up.railway.app
Runtime commit: 997aacc6e419b6dae573c5a77beb83507db17167
Verdict: PASS

Session: fe325b5b-3fef-4bca-80f9-7ff3c05d7fa5

Buyer: One more G7000iS question: is there START button start, or do you still pull the cord?

Assistant: Консультант18:21Да, у G7000iS есть кнопка START и электростартер. Но ручной стартер тоже есть — то есть можно и дернуть шнуром.КопироватьХорошоПлохоКарточки

Trace events: ["assistant_message_saved","completed","contract_created","artifacts_saved","verified_fact_memory_used","contract_created","delta_applied","started"]
Tool warnings: ["verified_product_fact_memory_used","web_search_skipped_verified_fact_memory"]

## Audit

- PASS: answer reused verified product fact memory.
- PASS: answer did not copy raw attribute/value labels.
- Detail JSON: local-live-tests\2026-05-22-verified-web-fact-memory-reuse-2026-05-22T15-21-48-479Z.json