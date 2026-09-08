# Production review and calibration

Export an actual defect through the existing feedback regression-candidate endpoint using an authorized reviewer credential. Review the de-identified candidate before adding it to the acceptance holdout. Keep the production session hash and source feedback/audit reference; never store customer contact information in the dataset. A completed automated audit is not a human label.

Calibration input is an array with `caseId`, `sessionHash`, `split` (`development` or `holdout`), `source: production`, `labelOrigin: human_review`, `auditReference`, `reviewer`, `reviewedAt`, `judgeModel`, `judgePromptHash`, `humanCritical`, `judgeCritical`, and optional `humanNaturalnessRatings` (two independent human ordinal ratings from 1 to 5). The provenance fields must refer to actual source records; setting a JSON flag cannot establish that review happened.

Run `node evals/acceptance/human-calibration.cjs <reviewed-file.json>`. It computes critical recall/precision, Cohen kappa and ordinal Krippendorff alpha, checks session leakage, duplicate case IDs and mixed judge versions. The default minimum is 100 distinct holdout sessions, at least 20 examples of each critical class and 100 paired human ratings. These sample requirements are operational safeguards, not a claim of statistical certainty. The document thresholds are recall .98, precision .90, kappa .80 and alpha .70.

No currently generated fixture establishes actual human agreement. A missing or inadequate reviewed dataset produces NOT_PROVEN. The unit tests use calculator fixtures only.

For conversation outcome metrics, the audited `PATCH /api/admin/conversations/:id/outcome` accepts a completed `turnId` and `resolutionStatus` (`resolved`, `unresolved`, `unknown`). It records an explicit human judgment and does not infer success from an answer or absence of questions.
