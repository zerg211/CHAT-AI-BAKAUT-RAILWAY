# Unified post-answer policy gate, 2026-05-17

## Что найдено

После усиления `recoverTurn` в коде оставалось расхождение:

- normal answer path имел собственный inline-блок `auditAnswerFactClaims -> verifyPostAnswer -> repair`;
- recovery answer path использовал новый общий `applyPostAnswerVerificationPolicy`.

Это создавало риск повторного дрейфа: будущая правка могла усилить один путь, но оставить другой слабее.

## Где была проблема

- `src/ai/assistant.ts`, обычная ветка `generateAnswer` перед `finalSelectionMetadata`.
- Логика post-answer verification дублировалась отдельно от recovery.
- Если после deterministic repair оставался `error`, обычная ветка могла продолжить сохранение/стрим вместо того, чтобы блокировать unsafe answer.

## Что изменено

Обычная генерация теперь тоже вызывает `applyPostAnswerVerificationPolicy`.

Единый gate:

1. строит `FactClaimAudit`;
2. выполняет `verifyPostAnswer`;
3. чинит repairable нарушения;
4. повторно проверяет итоговый текст;
5. возвращает единый `postAnswerVerificationRecovery`;
6. блокирует unrecoverable `error` до `onDelta`, `addMessage` и `completed`.

Если остаются unrecoverable ошибки, `generateAnswer` теперь помечает `answerGenerationFallback` причиной `post_answer_verification_failed` и бросает ошибку. Это безопаснее, чем отдавать покупателю непроверенный текст.

## Как это влияет на поведение

Пример repairable:

- LLM добавил контактный призыв, когда `LeadStateMachine.nextAction = do_not_ask_contact`.
- Gate удаляет контактное давление и сохраняет recovery metadata.

Пример unrecoverable:

- Ответ утверждает актуальность текущей заводской линейки без web-grounding.
- Gate не может честно исправить это простой заменой текста.
- Ответ блокируется, вместо того чтобы попасть в чат как нормальный assistant message.

## Проверка

Локально выполнено:

- `npm.cmd run typecheck`
- `npm.cmd test -- tests\assistantFallback.test.ts tests\postAnswerVerifier.test.ts tests\agentRuntimeContractsEval.test.ts`
- `npm.cmd test`
- `npm.cmd run build`

Результат полного suite: 29 test files passed, 319 tests passed.

Production live-диалоги не запускались: текущая политика разрешает их только перед финальным релизным gate.
