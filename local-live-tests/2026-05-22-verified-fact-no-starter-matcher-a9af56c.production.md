# Production Live Check: Verified Fact Memory Without Starter Matcher

Date: 2026-05-22T18:25:00+03:00
Site: https://bakautprof.ru/ via embedded widget
Production API marker: https://chat-ai-production-3057.up.railway.app/api/health
Runtime commit: a9af56c9df99796ccd32c80ed8b95e85507da647
Widget session: a1f800d9-1161-43ba-b83c-be097f1d3f1f

## Scope

Validated the final code after removing the temporary start-family matcher from `AgentManagerOrchestrator`. The matcher used code-level token families such as `button`, `manual`, `recoil`, `pull`, and `cord`; it was removed because semantic equivalence must be handled by LLM normalization or structured fact contracts, not a hidden dictionary in orchestration code.

## Live Dialogue

Buyer: "Подскажите по SUNREKA G7000iS: жене тяжело дергать шнур. У него есть запуск кнопкой START, или только ручной стартер?"

Assistant: "У SUNREKA G7000iS есть и ручной стартер, и запуск кнопкой START. То есть шнур дергать не обязательно — можно заводить электростартером.

Если хотите, могу еще подсказать, подойдёт ли он вам по мощности."

Buyer: "А наличие и доставку до Тулы на завтра подтвердите сейчас?"

Assistant: "Сейчас точно подтвердить не могу — для проверки наличия и доставки до Тулы на завтра нужен контакт в форме. Оставьте, пожалуйста, телефон или имя с телефоном, и мы сразу проверим по SUNREKA G7000iS."

## Audit

- PASS: live check was performed through the embedded widget on `https://bakautprof.ru/`, not localhost or direct API.
- PASS: production marker matched `a9af56c9df99796ccd32c80ed8b95e85507da647`.
- PASS: no regex or start-family dictionary was used in the final code path.
- PASS: the assistant gave a buyer-facing technical answer instead of a raw attribute list.
- PASS: the assistant preserved business boundaries for exact stock and next-day delivery.
- LIMITATION: admin metadata was not fetched because no `ADMIN_PASSWORD` or `ADMIN_API_KEY` was available locally.

## Remaining Risk

The next proper agentic pass should normalize requested technical attributes through the LLM contract or a structured semantic fact layer. Without that, exact cached facts are reused reliably when planner attributes match the stored fact attributes, while broader paraphrases may choose web verification instead of memory reuse. That is acceptable for correctness, but not optimal for cost and latency.
