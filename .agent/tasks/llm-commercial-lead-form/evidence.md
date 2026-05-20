# Evidence: LLM-driven commercial lead form

## Implementation Summary

- Removed the normal `generateAnswer` short-circuit through proactive `tryFastCommercialHandoff`; commercial turns now go through need extraction, LLM turn planning, and LLM answer generation.
- Kept deterministic safety validators and post-answer verification.
- Changed mixed `product_selection_with_delivery` / `product_selection_with_availability` so the LLM can keep product cards and request the lead form through `leadAllowed=true`.
- Mapped mixed commercial selection to execution/agent V2 `leadPolicy="optional_after_answer"`.
- Added backend `shouldRequestLeadFormForAnswer` so `leadRequested` opens the UI form for both `required_now` and `optional_after_answer`.
- Preserved contact refusal suppression.
- Updated prompt guidance: LLM must produce concise commercial boundary answers and trigger the form through `leadPolicy`/`leadAllowed`, not canned text.
- Added `third_person_manager_role_handoff` to post-answer verification: buyer-visible answers such as "менеджер уточнит/проверит/свяжется" are rejected and sent to LLM rewrite.
- Removed silent pre-verification cleanup for third-person manager wording from answer sanitization, so the LLM verifier/rewrite owns the correction. Deterministic text repair remains only as fallback if LLM rewrite is unavailable.
- Strengthened LLM prompts for fast commercial answers, compact answers, and post-answer rewrite: the assistant must speak as the BAKAUT AI manager in first person, and route stock/logistics checks through "я сверю/посчитаю/передам запрос".

## Acceptance Criteria

- AC1 PASS: `generateAnswer` no longer calls `tryFastCommercialHandoff` before LLM planning.
- AC2 PASS: mixed commercial selection maps to `optional_after_answer`; pure handoff remains `required_now`.
- AC3 PASS: form opens from backend `leadRequested`, derived from lead draft + lead policy.
- AC4 PASS: answer guidance now instructs concise LLM-authored commercial responses and opened-form wording.
- AC5 PASS: post-answer verification now also rejects third-person manager handoff wording and routes it to LLM rewrite before deterministic fallback.
- AC6 PASS: focused tests cover mixed delivery, availability, contact refusal, optional lead policy, suppression, LLM rewrite after third-person manager wording, and recovery rewrite behavior.

## Verification Commands

```bash
npm test -- --run tests/agentTurnContract.test.ts tests/agentRuntimeContractsEval.test.ts tests/remediationCommercialFallback.test.ts
```

Result: PASS, 3 files, 31 tests.

Fresh rerun after evidence artifacts were written: PASS, 3 files, 31 tests.

```bash
npm test -- --run tests/agentTurnContract.test.ts tests/agentRuntimeContractsEval.test.ts tests/recommendationRanking.test.ts tests/assistantControlPlaneGenerate.test.ts tests/prompts.test.ts tests/remediationCommercialFallback.test.ts
```

Result: PASS, 6 files, 238 tests.

```bash
npm run typecheck
```

Result: PASS.

```bash
npm run build
```

Result: PASS.

Fresh rerun after AI-manager voice verification changes:

```bash
npm test -- tests/postAnswerVerifier.test.ts
```

Result: PASS, 1 file, 13 tests.

```bash
npm test -- tests/assistantControlPlaneGenerate.test.ts
```

Result: PASS, 1 file, 11 tests.

```bash
npm test -- tests/assistantFallback.test.ts tests/assistantControlPlaneGenerate.test.ts tests/remediationCommercialFallback.test.ts tests/assistantLegacyWriterGuard.test.ts tests/postAnswerVerifier.test.ts
```

Result: PASS, 5 files, 51 tests.

```bash
npm test -- tests/recommendationRanking.test.ts tests/agentManagerIntegrationSource.test.ts
```

Result: PASS, 2 files, 209 tests.

```bash
npm run typecheck
```

Result: PASS.

```bash
npm test
```

Result: PASS, 58 files, 502 tests.

```bash
npm run build
```

Result: PASS.

## Live Verification

Observed before this fix:

- `2026-05-20-production-diverse-buyer-audit-2026-05-20T07-34-41-926Z.production.md`: failed because production recovery answer did not pass post-answer verification for commercial wording.
- `local-live-tests/production-diverse-buyer-audit-failure.json`: after commit `0f87ade`, the local adaptive buyer could not call OpenAI (`403 Country, region, or territory not supported`) and repeated an old fallback dialogue; the live answer also exposed the remaining "manager/logistics as third person" tone on commercial turns.

Fresh production live gate after the LLM rewrite fix:

```bash
ALLOW_PRODUCTION_LIVE_TESTS=1 FINAL_RELEASE_LIVE_GATE=1 EXPECTED_REMEDIATION_CONTRACT_VERSION=2026-05-19-generator-load-scenarios-recovery-v38 PRODUCTION_LIVE_REQUIRED_REMAINING_TOKENS=0 EXPECTED_PRODUCTION_COMMIT_SHA=b89509245cc3c63006f770d4224179ba8fbbfe8a node local-live-tests/2026-05-20-ai-manager-voice-live-runner.mjs
```

Result: PASS.

- Protocol: `local-live-tests/2026-05-20-ai-manager-voice-2026-05-20T09-00-52-322Z.production.md`
- Admin detail: `local-live-tests/2026-05-20-ai-manager-voice-2026-05-20T09-00-52-322Z.json`
- Production commit tested: `b89509245cc3c63006f770d4224179ba8fbbfe8a` (`ef68b64` is an ancestor and contains the LLM rewrite fix)
- Buyer issues: 0
- Code/metadata issues: 0
- Lead submissions for session: 1
- Lead audit issues: 0
- All turns completed without fallback/recovery.
- `postAnswerVerification.status=pass` on every assistant turn.
- Commercial handoff turn used `answerMode=llm_fast_commercial_handoff`, `commercialAction=explain_manager_required`, `leadRequested=true`, and no `third_person_manager_role_handoff`.

Current status: final for the LLM commercial handoff voice/remediation scope.
