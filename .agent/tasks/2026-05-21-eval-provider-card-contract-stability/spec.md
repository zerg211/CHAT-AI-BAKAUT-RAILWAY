# Eval Provider And Card Contract Stability Spec

## Current Behavior

Production Promptfoo can fail before a chat session exists when `/api/chat/sessions` returns a transient transport error. The message send path already has retries, but session creation is a single attempt.

The context-shift eval can also expose a stale answer contract: `selectionReadiness.productClass` may say `generator/not_applicable` while the actual catalog request, selected products, answer text, and top-level visible intent are `plate`. The current card gate treats that stale `canShowProductCards=false` as authoritative and suppresses valid non-generator cards.

The scorecard still depends on text patterns for final product-class completion even when the runtime metadata already exposes the product class.

## Structural Improvement

- Add retry handling around Promptfoo session creation without changing production chatbot behavior.
- Validate answer-contract card suppression against the visible catalog/card intent. Keep strict generator safety gates, but do not let a stale `not_applicable` answer-contract product class suppress honest non-generator catalog cards.
- Add a structured scorecard product-class check that can use `metadata.selectionReadiness.productClass`, visible cards, and existing task metadata before relying on text matching.

No new regex constructs may be added.

## Acceptance Criteria

AC1. Promptfoo provider retries transient session creation failures and still returns a normal output when a later attempt succeeds.

AC2. Non-generator catalog cards remain visible when the answer contract says `not_applicable` but the visible card intent has valid products.

AC3. Generator card safety remains unchanged: unconfirmed generator load basis still blocks cards.

AC4. `assertAgentTaskCompletion` can pass product-class completion from structured metadata without requiring a fixed word in the final text.

AC5. Focused tests, `npm run lint:no-regex`, `npm run typecheck`, and build pass locally.

AC6. After commit/push and Railway deploy, production Promptfoo is rerun through the production endpoint/widget context and score artifacts are saved.
