# Task: consistency guard no regex

## Current behavior

`src/ai/consistencyGuard.ts` records facts already stated by the assistant and checks later answers for contradictions. The current price guard:

- records a product price when the answer names the product and includes the catalog price string;
- checks later product mentions for different RUB price mentions;
- emits a warning when the new RUB price differs from the recorded price by more than 1%.

This is deterministic safety logic, not semantic buyer-intent planning.

## Structural improvement

Replace the regex-based price checks with explicit scanners:

- exact standalone price string detection;
- RUB price mention scanning with spaces inside the number;
- currency suffix recognition for `₽`, `руб`, and `р.`.

Keep public exports stable.

## Acceptance Criteria

AC1. `src/ai/consistencyGuard.ts` contains no regex constructs after the pass.

AC2. No new regex constructs are added anywhere else.

AC3. Focused tests cover fact recording, no warning for the same price, warning for a different RUB price, and no warning for unrelated products.

AC4. Existing public exports remain stable: `ConsistencyGuard`, `getSessionGuard`, and `cleanupSessionGuard`.

AC5. `npm run lint:no-regex` passes after reviewed baseline reduction.

AC6. Focused tests, typecheck, full tests, build, and diff check pass.

AC7. Production eval is not required unless this pass changes prompts, answer policy, product selection, tool policy, or widget-visible behavior beyond deterministic parity.
