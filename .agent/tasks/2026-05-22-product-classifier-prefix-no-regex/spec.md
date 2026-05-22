# Product Classifier Prefix No Regex

## Problem

`src/ai/productClassifier.ts` uses a dynamic `new RegExp` inside `startsWithAnyWord` only to check whether a product title starts with one of several known machine words. This is deterministic product classification, not semantic intent planning, so it can be implemented without regex.

## Current Behavior

The classifier treats a title as a core machine title when it starts with a known word and the next character is a word boundary, whitespace, or the end of the string.

## Structural Improvement

Replace the dynamic regex with explicit string normalization and delimiter checks:

- normalize the title and configured words with locale-aware lowercasing;
- use `startsWith`;
- accept the match only when the title ends at the word or the next character is whitespace, a separator, or a digit.

Public product classification behavior should stay stable for current tests.

## Acceptance Criteria

- AC1: `startsWithAnyWord` no longer constructs or invokes regex.
- AC2: Core machine title classification remains stable for known title prefixes such as generator/vibroplita/cutter/rammer/roller/trowel.
- AC3: The no-regex guard reports at least one removed legacy finding and no new regex constructs.
- AC4: Focused product classifier tests and full local non-OpenAI gates pass.
- AC5: Changes are committed and pushed through GitHub; no manual Railway deploy.
