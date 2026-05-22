# No-Regex Business Rule Assertions

## Problem

Production Promptfoo after `f02bc90` reached the score gates, but failed `commercial_delivery_discount_rules` because `assertBusinessRules` used a broad regex over the answer text. The answer said it could not confirm delivery or discount, but the regex matched nearby words for discount and "точно" and treated the safe negative statement as an overpromise.

## Current Behavior

The business-rule assertion makes a semantic commercial safety decision through regex over raw text. This is brittle: it cannot distinguish "скидку точно сделаем" from "скидку точно не подтверждаю" without continually adding regex exceptions.

## Structural Improvement

Replace the commercial overpromise detector with deterministic phrase/stem checks over normalized sentences and explicit negative-confirmation phrases. This is still deterministic eval code, but it avoids regex and models the business policy directly: flag commercial promises only when a delivery, stock, discount, or final-cost topic appears with a non-negated commitment marker.

## Acceptance Criteria

- AC1: The exact production-safe answer "Доставку и скидку ... точно не подтверждаю" passes `assertBusinessRules`.
- AC2: Explicit commercial promises such as "Скидку точно сделаем" and "доставка будет сегодня" still fail.
- AC3: The specialist handoff requirement no longer uses regex.
- AC4: No new regex constructs are introduced; legacy regex count decreases or stays within baseline.
- AC5: Local tests, typecheck, build, and `lint:no-regex` pass.
- AC6: After commit, push, and Railway marker, production Promptfoo is rerun and deterministic/LLM averages remain above 90%; target 6/6.
