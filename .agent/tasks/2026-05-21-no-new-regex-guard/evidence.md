# No New Regex Guard Evidence

## Summary

Status: PASS.

This pass adds a mechanical guard against adding new regex constructs. It does not remove legacy regex and does not change assistant behavior, prompts, public APIs, database schema, or deployment behavior.

Current legacy baseline: 1844 findings.

## Changed Files

- `scripts/no-regex-guard.mjs`
- `scripts/no-regex-baseline.json`
- `package.json`

## Validation

- `npm run lint:no-regex` PASS.
  - Output: `No new regex constructs. Legacy baseline: 1844.`
- `node --check scripts/no-regex-guard.mjs` PASS.
- Fail-path check PASS.
  - Command used a temporary baseline with one known legacy id removed through `NO_REGEX_BASELINE_PATH`.
  - Expected result: guard exits non-zero and reports `New regex constructs detected: 1`.
- `npm run typecheck` PASS.
- `git diff --check` PASS.

## Behavior Parity

No runtime behavior changed. This is a repository tooling pass only, so production widget Promptfoo/live gates are not required for this specific commit.

## Follow-Up Migration Rule

Future regex cleanup must reduce `scripts/no-regex-baseline.json` through focused refactor passes. Do not expand the baseline except when correcting guard coverage, and do not replace old regex with new keyword or phrase rules. Prefer typed parsing, semantic LLM planning, structured contracts, or explicit deterministic checks for factual/catalog/business constraints.
