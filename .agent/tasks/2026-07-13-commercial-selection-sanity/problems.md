# Problems

## Confirmed production failures

1. Search stopped after one formally valid 8.5 kW candidate even though closer 5-6 kW products existed.
2. Canonical structured recovery was gated on zero survivors instead of insufficient/low-quality coverage.
3. Previously validated 6.0 kW products were dropped from the next answer.
4. A no-tool recommendation follow-up lost the prior validation evidence and failed all recovery attempts.
5. The manual verification process initially described a partial behavior improvement before completing the mandatory per-turn audit.

## Current status

## Production attempt 1 on commit `50ee8a5`

Session `9ad5a646-0f86-4bf5-8df2-1984dcd84538` failed the embedded-widget audit:

1. Turn 2 visibly returned valid gasoline products including TSS SGG 5000N 5.0 kW / 49,281 RUB and SUMEC SU8800 6.0 kW / 47,990 RUB.
2. Turn 3 added the buyer's explicit gasoline choice as strict `fuel_type=gasoline` and then suppressed every product with `unsupported_or_unverifiable_strict_hard_constraint:1`.
3. The deterministic strict-requirement validator did not support `fuel_type`, even though the catalog classifier already had deterministic gasoline/diesel facts.
4. The buyer therefore saw the false statement that no suitable gasoline model could be shown and was again asked for a nameplate.
5. The pre-send review returned `pass` despite the direct contradiction with the prior turn.
6. Turns 2-4 had recovered status; under AC13 that independently fails the release.

The smallest architectural fix is in progress: LLM keeps ownership of interpreting the buyer's fuel preference, while deterministic code validates supported fuel values and filters products by catalog fuel facts. A new exact gasoline regression passes locally. A new commit, deployment marker, and complete fresh widget audit are still required.
