# Verification problems and fixes

## P1 — client helper tests disturbed widget session tests

The first full-suite run after the implementation passed 1491 tests and failed four. Three `widgetSessionBoundary` assertions were caused by the new component test importing `src/client/main.tsx`, which executed the application entry point and changed module/mock state for unrelated tests.

Smallest fix: move the pure admin/contact view-model helpers into `src/client/widgetDiagnostics.ts` and test that module directly. The affected focused suite then passed 114/114.

## P2 — parallel full suite hit unrelated five-second timeouts

The fresh parallel run passed 1499 tests and timed out in three unrelated cases: admin authorization, lead persistence, and the real external PDF parser. No assertion failed. Running exactly those files with one worker passed 20/20 in 3.90 seconds.

The full repository suite was then rerun with one worker and passed 1502/1502 with one intentional skip. The repository release gate independently repeated the suite with serial files and also passed 1502/1502 with one skip.

No product-code change was made for P2 because the failures were process contention against a fixed five-second test timeout, not a reproducible behavior defect.
