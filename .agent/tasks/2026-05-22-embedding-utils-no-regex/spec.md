# Task: embedding utils no regex

## Current behavior

`src/ai/embeddingUtils.ts` prepares embedding input text by:

- truncating input to 8000 characters;
- converting CRLF newlines to LF;
- preserving the normalized text for source hash generation.

The CRLF normalization currently uses regex.

## Structural improvement

Replace CRLF regex replacement with an explicit scanner that preserves the same behavior:

- replace `\r\n` pairs with `\n`;
- preserve lone `\r`;
- preserve the existing "slice before normalize" order.

This is deterministic infrastructure code and does not affect prompts, answer policy, product selection, or user-visible behavior.

## Acceptance Criteria

AC1. `src/ai/embeddingUtils.ts` contains no regex constructs after the pass.

AC2. No new regex constructs are added anywhere else.

AC3. Focused tests cover CRLF normalization, lone CR preservation, truncation-before-normalization, and source-hash parity for CRLF versus LF input.

AC4. Existing public exports remain stable: `embeddingInputText`, `embeddingSourceHash`, and `embeddingMetadataForText`.

AC5. `npm run lint:no-regex` passes after reviewed baseline reduction.

AC6. Focused tests, typecheck, full tests, build, and diff check pass or any unrelated failure is explicitly attributed to pre-existing dirty worktree changes.

AC7. Production eval is not required because this pass only changes deterministic embedding input normalization with parity tests.
