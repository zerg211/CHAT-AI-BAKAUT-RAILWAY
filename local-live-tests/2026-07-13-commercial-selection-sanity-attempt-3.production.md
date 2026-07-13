# Production live protocol: commercial selection sanity, attempt 3

- Date: 2026-07-13
- Site: embedded widget on `https://bakautprof.ru/`
- Production commit: `5c3f0b223588a36b26b3beaee395dc7b1787cb35`
- Session: `9ea0d9b6-2cd3-44e3-8d49-f684f3ffb3a2`
- Verdict: FAIL

## Adaptive buyer transcript and visible audit

### Turn 1

Buyer: needs a dacha generator for a 1.1 kW well pump and 1.5 kW grinder running together; single-phase 220 V; no autostart.

Assistant: calculated a 4.5 kW nominal minimum, advised the 5 kW class, and showed four priced cards:

- TSS SGG 5000N, 5.0 kW, 49,281 RUB;
- FIRMAN RD7910, 5.0 kW, 57,200 RUB;
- EVOline PB 6000, 5.0 kW, 64,990 RUB;
- EVOline PB 6000 E, 5.0 kW, 74,990 RUB.

Verdict: PASS.

### Turn 2

Buyer: asks to reduce the four options to 2-3 best gasoline single-phase products in 5-6 kW, necessarily with prices; pump nameplate is not available.

Assistant: claims that the current search produced no verified cards under those conditions and refuses to show any, despite the four immediately preceding cards satisfying the request.

Verdict: FAIL. This is a direct cross-turn contradiction and a commercially unacceptable refusal.

## Admin metadata audit

- Both turns completed normally; no recovery status explains the failure.
- Turn 2 planner output was semantically correct: `reusePreviousCards=true`, gasoline strict, single-phase strict, 5-6 kW strict, `price_visibility=true` strict, requested quantity 3.
- `historicalSelectionEvidence.reused=true`; prior `catalog.search` evidence was available.
- Current search returned zero product IDs, but previous visible products remained available for revalidation.
- Deterministic strict validation emitted `unsupported_or_unverifiable_strict_hard_constraint:1` for the otherwise valid `price_visibility` requirement and suppressed every answer product and card.
- Selection readiness then became `blocked_by_answer_contract` and the composed answer falsely translated this code limitation into catalog scarcity.
- Pre-send review returned `pass` with no issues.

## Root cause boundary

- LLM responsibility: interpret the buyer's request for visible prices and continuity. It did this correctly.
- Deterministic responsibility: verify that each candidate has a real catalog price. This capability was missing.
- Required general fix: support typed `price_visibility=true` and filter only unpriced products; do not add a phrase-specific response or model exception.
