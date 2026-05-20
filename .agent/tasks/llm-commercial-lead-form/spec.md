# Task: LLM-driven commercial lead form

## Objective

Commercial questions about delivery, live stock, discounts, special terms, deadlines, order processing, or other individual conditions must be handled by the LLM semantic contract, not by a proactive deterministic commercial answer.

The assistant should still answer briefly and naturally, but the runtime must open the lead form whenever the LLM marks the turn as requiring commercial/specialist verification.

## Scope

- Backend AI control plane only.
- No new hardcoded commercial response text for normal turns.
- Keep deterministic safety validators that block unsupported stock, delivery, discount, deadline, or special-term promises.
- Keep contact refusal respected: if the buyer clearly says not to leave contact/call/form, do not open the form.

## Acceptance Criteria

### AC1: Normal commercial turns use the LLM path

For explicit commercial questions, `generateAnswer` must not short-circuit through proactive `tryFastCommercialHandoff` before need extraction and LLM turn planning.

### AC2: LLM contract can open the form for commercial verification

When the LLM/agent contract marks a turn as commercial verification:

- pure delivery / pure availability / lead handoff -> lead policy is `required_now`;
- mixed product selection with delivery or availability -> lead policy is `optional_after_answer`;
- `leadRequested` becomes true unless the buyer refused contact.

### AC3: Form logic is contract-driven, not phrase-driven answer text

The UI form opens from backend `leadRequested`, derived from `agentContractV2.leadPolicy` / lead draft, not from matching answer text.

### AC4: Final answer remains LLM-authored and concise

Answer-generation guidance must tell the LLM to:

- answer the commercial boundary in 1-2 concise sentences;
- say stock/delivery/discount/final terms need verification;
- mention the opened form for name/phone when a lead is requested;
- avoid treating the form as a finalized order.

### AC5: Commercial promises remain forbidden

Existing post-answer verification must still block/repair unsupported claims such as exact live stock, exact delivery cost, exact discounts, special terms, or deadlines.

### AC6: Tests cover the contract behavior

Focused unit tests must cover:

- product-selection-with-delivery can keep product cards and request the lead form;
- product-selection-with-availability can request the lead form;
- explicit contact refusal still suppresses the lead form;
- `leadRequested` condition includes optional commercial lead policy.

## Verification

Run focused tests:

```bash
npm test -- --run tests/agentTurnContract.test.ts tests/agentRuntimeContractsEval.test.ts tests/recommendationRanking.test.ts tests/assistantControlPlaneGenerate.test.ts
```

If the full focused set is too broad for the environment, run the directly affected tests and document any limitation in evidence.
