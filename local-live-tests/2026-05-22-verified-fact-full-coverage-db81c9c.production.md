# Production Live Check: Verified Fact Full Coverage

Date: 2026-05-22T18:34:00+03:00
Site: https://bakautprof.ru/ via embedded widget
Production API marker: https://chat-ai-production-3057.up.railway.app/api/health
Runtime commit: db81c9c346f8945a11b54ff8cc35727a511fbee9
URL: https://bakautprof.ru/?agentHarness=1&codexLive=full-coverage-db81c9c-final

## Scope

Validated the final code after restoring full verified-fact coverage. The agent should reuse local verified facts only when the stored attributes cover all requested structured attributes; partial matches should not suppress web verification.

## Live Dialogue

Buyer: "Podskazhite po SUNREKA G7000iS: est zapusk knopkoy START, ili tolko ruchnoy starter?"

Assistant: "У SUNREKA G7000iS есть и кнопка START, и ручной стартер. То есть заводится не только вручную — есть электростартер. Кнопочный запуск подтверждаю."

Buyer: "A nalichie i dostavku do Tuly na zavtra podtverdite seychas?"

Assistant: "Сейчас точно подтвердить не могу: в этом ответе у меня нет живого статуса склада и доставки. По SUNREKA G7000iS у нас модель в каталоге есть, но наличие на сегодня и доставку в Тулу на завтра нужно отдельно уточнить. Если хотите, оставьте телефон через форму — так сможем быстро проверить и вернуться с точным ответом."

## Audit

- PASS: live check was performed through the embedded widget on `https://bakautprof.ru/`, not localhost or direct API.
- PASS: production marker matched `db81c9c346f8945a11b54ff8cc35727a511fbee9`.
- PASS: no regex, start-family dictionary, or partial-coverage shortcut remains in the final cached fact path.
- PASS: the assistant gave a buyer-facing technical answer instead of a raw attribute list.
- PASS: the assistant did not promise live stock or next-day delivery and routed exact commercial confirmation to contact capture.
- LIMITATION: browser MCP closed during this check, so this final protocol was captured through a headless Playwright session against the real production widget. Admin metadata was not fetched because no admin token was available locally.

## Remaining Risk

Paraphrase-level attribute reuse should be handled by a future LLM normalization or structured semantic fact contract. Until then, exact structured attributes reuse memory; broader paraphrases may perform web verification, which is safer than skipping verification on partial facts.
