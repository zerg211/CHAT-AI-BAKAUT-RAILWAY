# Completion audit evidence model update, 2026-05-17

## Что найдено

`tests/remediationCompletionAudit.mjs` давал несколько ложных failures после последних изменений:

- Docker proof был старым (`v20`) и не отражал текущий `v21`.
- Production marker брался только из `local-live-tests/remediation-postdeploy.json`, где остался старый `v20`.
- Более свежее доказательство уже было в `local-live-tests/remediation-external-readiness.json`: production `/api/health` показывал `2026-05-16-agent-contract-stack-v21` и полный список runtime artifacts.
- Railway network/GraphQL failures оставались в external readiness artifact, но production marker уже доказывал, что GitHub/Railway deployment дошел до running production.

В результате audit смешивал три разных класса фактов:

1. локальная готовность build/tests;
2. факт deployed production marker/runtime artifacts;
3. финальная live-проверка widget через `bakautprof.ru`.

## Что изменено

`tests/remediationCompletionAudit.mjs` теперь:

- выбирает лучшее marker-доказательство из нескольких источников:
  - `remediation-postdeploy.json`;
  - `remediation-external-readiness.json -> checks.productionHealth`;
- считает Railway deploy доказанным, если production marker текущей версии реально доступен;
- не считает старые Railway network/GraphQL diagnostics блокером, когда production marker уже доказан;
- сохраняет production OpenAI quota blocker как evidence для live gate;
- делает `fresh_production_live_protocol_exists` optional diagnostic, а не отдельным дублирующим required failure;
- оставляет hard required failure на `postdeploy_live_gates_passed`.

## Текущий результат

После обновления Docker proof:

- backup доказан;
- predeploy artifact доказан;
- Docker image proof доказан на `v21`;
- production marker/runtime artifacts доказаны на `v21`;
- Railway deploy считается доказанным через production marker;
- completion audit теперь падает только на `postdeploy_live_gates_passed`.

Это правильная модель текущего состояния: проект не считается завершенным, потому что финальный production widget dialogue не доказан. При этом аудит больше не маскирует единственный реальный remaining blocker шумом от старых artifacts.

## Проверка

Выполнено:

- `npm.cmd run test:remediation:docker-image`
- `node --check tests\remediationCompletionAudit.mjs`
- `npm.cmd run test:remediation:completion-audit`

Ожидаемый результат completion audit сейчас: `ok=false`, required failure только `postdeploy_live_gates_passed`.

Production live-диалоги не запускались: они остаются отложенными до финального release gate с неповторяющимися формулировками.
