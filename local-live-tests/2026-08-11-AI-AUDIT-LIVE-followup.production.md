# AI audit follow-up — production widget — 2026-08-11

Проверка выполнена через встроенный виджет на `https://bakautprof.ru/`, не через localhost или прямой API.

## Deployment evidence

- GitHub `main`: `a9eaaff` (`fix(catalog): resolve exact model mentions before web research`).
- Railway CLI reported the service online, but `/api/health` on both the Railway hostname and the configured widget hostname was unavailable from this environment; exact runtime commit marker therefore could not be independently read back.
- The widget itself loaded and accepted a real adaptive conversation after the push.

## Adaptive dialogue

Buyer request:

> Нужна виброплита Wacker Neuson BPS 1550 Aw с двигателем Honda GX160 QX2. Проверьте по каталогу и официальным данным: какое масло и его объём, свеча и артикулы воздушного фильтра. Если данных не хватит, сначала ищите их, не делайте предположений.

Visible assistant answer after the post-fix push:

> Не буду делать предположения по этой BPS 1550 Aw с Honda GX160 QX2: не подтверждены тип и объём масла, свеча зажигания и артикулы воздушного фильтра. Точную модель в нашем каталоге сейчас не удалось найти. Внешняя проверка официальных данных в этом обращении не завершилась, поэтому использовать её как подтверждение нельзя. Подтверждённых сервисных данных на данный момент нет.

## Verdict

- Safety/grounding: PASS — no invented oil, spark plug, or filter data.
- Exact catalog retrieval: FAIL — public site visibly contains a `BPS 1550 Aw` card, while the AI catalog path reports it absent; current database/catalog synchronization or exact-identity retrieval is still unresolved.
- Autonomous manager behavior: FAIL — the turn ends after an incomplete external check instead of continuing through a source fallback or offering a properly authorized technical handoff after exhaustion.
- Useful answer: FAIL — no confirmed partial facts, product card, source URLs, or preliminary operational conclusion are returned.
- Provenance: FAIL — the user cannot see which official pages/manuals were attempted or why the search stopped.

This artifact is a live regression record, not a completion claim. The next owning-layer fix is catalog synchronization/exact product availability plus a bounded source-fallback/terminal-handoff contract; a canned sentence replacement is not sufficient.
