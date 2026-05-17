# Recovery post-answer verification guard, 2026-05-17

## Что найдено

Обычная ветка `generateAnswer` после генерации текста выполняла полный post-answer цикл:

1. `auditAnswerFactClaims`;
2. `verifyPostAnswer`;
3. deterministic repair для repairable нарушений;
4. повторную проверку;
5. сохранение metadata с `postAnswerVerification` и `postAnswerVerificationRecovery`.

Ветка `recoverTurn` тоже строила `RequirementLedger`, `ExecutionContract`, `CardManifest`, `FactClaimPlanner` и `LeadStateMachine`, но фактически использовала `postAnswerVerification` как диагностический metadata-слой. Если восстановленный LLM-ответ нарушал политику, он мог быть отправлен покупателю и сохранен как `recovered`.

Это особенно опасно для recovery, потому что recovery запускается после сбоя основного ответа и не должен быть более слабым путем обхода контрактов.

## Где проблема была в коде

- `src/ai/assistant.ts`, `recoverTurn`, nested `completeRecoveredAnswer`.
- Проверка `verifyPostAnswer` была, но не было обязательного repair/block перед `onDelta`, `addMessage` и `updateTurn`.

## Исправление

Добавлен единый helper `applyPostAnswerVerificationPolicy`:

- строит `factClaimAudit`;
- выполняет `verifyPostAnswer`;
- применяет `repairAnswerForPostAnswerVerification` для repairable нарушений;
- повторно строит audit/verification;
- возвращает итоговые `answer`, `factClaimAudit`, `postAnswerVerification`, `postAnswerVerificationRecovery`.

`recoverTurn` теперь использует этот helper до стрима и сохранения. Если после repair статус остается `error`, recovery падает и не отправляет небезопасный recovered answer.

## Как изменится поведение

Пример: покупатель отказался от звонка, а recovery-LLM при восстановлении добавил “оставьте телефон”.

Было:

- ответ мог уйти покупателю;
- metadata показывала проблему, но уже после факта;
- turn становился `recovered`.

Стало:

- repairable контактное давление удаляется до `onDelta`;
- покупатель видит только безопасную часть ответа;
- metadata сохраняет `postAnswerVerificationRecovery`;
- unrecoverable нарушение блокирует recovery вместо сохранения плохого ответа.

## Проверка

Локально выполнено:

- `npm.cmd run typecheck`
- `npm.cmd test -- tests\assistantFallback.test.ts tests\postAnswerVerifier.test.ts tests\chatStream.test.ts`
- `npm.cmd test`
- `npm.cmd run build`

Результат полного suite: 29 test files passed, 318 tests passed.

Production live-диалоги не запускались по текущей политике: они выполняются только один раз перед финальным релизом, с неповторяющимися формулировками и ручным аудитом widget + admin metadata.
