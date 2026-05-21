# No New Regex Guard Spec

## Current Behavior

The codebase still contains legacy regex usage across source, tests, eval helpers, or tooling. New regex can be introduced without a mechanical check, which conflicts with the project rule that semantic behavior must not be fixed through regex or keyword patches.

## Structural Improvement

Add a source-code guard that parses JavaScript and TypeScript with the TypeScript compiler API and blocks new regex constructs without relying on regex for the scan itself. Existing regex usage is recorded as a migration baseline by file, construct kind, occurrence, and hash only, not by storing pattern text.

This pass does not remove legacy regex. Removing those usages must happen in later small refactor passes where each replacement can be validated for behavior parity.

## Acceptance Criteria

AC1. The guard scans project code surfaces that can add runtime or eval behavior: `src`, `tests`, `evals`, root JS/TS config files, and repository scripts.

AC2. The guard detects regex literals, `RegExp(...)`, `new RegExp(...)`, and string-method regex arguments such as `match`, `matchAll`, `replace`, `search`, and `split` when the regex expression is syntactically visible.

AC3. Existing findings are captured in a baseline that does not store actual regex pattern text. The normal guard command passes against the current codebase and fails if a new regex construct is added.

AC4. The guard is exposed through an `npm` script and runs without changing product behavior, public APIs, prompt behavior, database schema, or production deployment behavior.

AC5. Evidence records the validation commands, the current legacy count, and the follow-up migration rule: reduce the baseline in later focused passes, never expand it except for correcting guard coverage.
