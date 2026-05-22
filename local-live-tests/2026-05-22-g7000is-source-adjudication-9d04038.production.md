# G7000iS Source Adjudication Production Widget Check

Date: 2026-05-22  
Site: https://bakautprof.ru/?agentHarness=1&codexLive=g7000is-source-adjudication-9d04038  
Production API: https://chat-ai-production-3057.up.railway.app  
Runtime commit: 9d04038912ff356a714de0ab66cc6bc796541385  
Session: 0ce9eeb5-6999-4896-a334-a1f5b34c67fe  
Scope: one narrow live turn through the embedded production widget after the fix.

## Transcript

Buyer:

> Подскажите, SUNREKA G7000iS нужно каждый раз заводить шнурком или он запускается кнопкой? Жене важно без дерганья.

Assistant:

> Кнопочный запуск подтвержден. Ручной запуск тоже есть. У нас SUNREKA G7000iS есть в каталоге.

## Verdict

PASS for the repaired source-conflict path.

- The visible answer no longer says that electric start is absent or not found.
- The answer closes the buyer's decision-blocking need: button start is confirmed, manual start is also mentioned.
- The answer stays short and human enough for this narrow technical question.
- The production marker was checked before the widget turn and matched the pushed code commit `9d04038`.

## Limits

Admin metadata was not available in this shell because `ADMIN_PASSWORD` / `ADMIN_API_KEY` was not present. This live check verifies the deployed marker and visible widget behavior, not the admin trace.
