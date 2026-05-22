# Unconfirmed Generator Load Answer Clause

## Problem

Production Promptfoo after `03e9fcc` has `5/6` with both averages above 90%. The remaining failing case is `vague_generator_no_cards_before_load_profile` with LLM score `0.74`.

The runtime correctly blocked catalog cards because `calculator.generatorLoad` produced `generator_load_bounded_basis_incomplete` and `generator_load_unbounded_guess`, but the final answer still presented a concrete generator power range (`5 kW`, `6-7 kW`) as a practical recommendation. The judge correctly flagged this as overconfident for an unconfirmed load basis.

## Current Behavior

The answer prompt says to suppress cards and ask a useful question when generator load basis is unconfirmed. It does not give the compose/review stages a structured required clause that forbids presenting the computed profile as a recommendation while the basis is unconfirmed.

## Structural Improvement

When tool results include unconfirmed generator load warnings, create a required response clause that:

- marks the generator load profile as not a reliable selection basis;
- forbids presenting `requiredNominalKw` or a kW range as the recommended/minimum generator size;
- requires asking for the missing load power/model/type needed to make the selection safe.

This keeps semantic behavior in the LLM answer/review layer while deterministic code supplies the safety contract from structured tool warnings.

## Acceptance Criteria

- AC1: `requiredResponseClausesForToolResults` includes a generator unconfirmed-load clause when calculator warnings include unbounded/incomplete/invalid load basis.
- AC2: The clause is passed to compose/review input for generator load turns.
- AC3: Existing generator card safety behavior is unchanged.
- AC4: No regex is added.
- AC5: Local non-OpenAI gates pass.
- AC6: After commit/push/Railway, production Promptfoo deterministic and LLM averages stay above 90%; target `6/6`.
