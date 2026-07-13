# Problems found and resolved

## P1 — rejected answer checkpoint was reusable

The answer checkpoint remained succeeded when semantic review blocked it. All recovery runners therefore reused the same rejected answer. Fixed by invalidating the answer checkpoint, persisting failed review evidence, saving a rejected answer contract, and recomposing with bounded review feedback.

## P2 — planner proof graph had a one-sided typed link

The requirement explicitly referenced the calculator request, but the reverse `coversRequirementIds` link was sometimes placed on catalog search. Fixed by a narrow deterministic normalization that repairs only explicit, required, supported typed generator-load links. Malformed or inferred links remain fail closed.

## P3 — strict autostart requirement was unsupported

The planner emitted `auto_start_required` / `autostart_required`, but the deterministic verifier rejected both. Added typed boolean validation and a shared product verifier for answer evidence and cards.

## P4 — autostart false positives during independent audit

The first implementation used substring matching. It could treat an ATS connector/readiness field as installed autostart, and could treat `не был установлен` as positive because it contained `установлен`. Fixed before commit by accepting only status keys, giving explicit negation precedence, treating option/readiness as unknown, and adding Russian/English regression cases.

## P5 — initial focused test fixtures used non-distinct generic names

Two new card tests initially selected no cards because all fixtures shared a generic product name and therefore did not satisfy the existing grounded-mention gate. The fixtures were corrected to distinct model names; production logic was not weakened.

## P6 — first release gate could not run npm audit inside sandbox

All code checks passed, but npm audit could not access the registry/cache. The read-only audit and then the complete gate were rerun with approved access; both passed with zero vulnerabilities.
