# Evidence — recovery and validated selection

Status: `LOCAL_PASS_DEPLOY_PENDING`

## Local implementation verdict

- AC1: PASS — supported typed generator-load requirements are attached to their explicitly referenced required calculator request; misplaced reverse coverage is removed from foreign requests and traced.
- AC2: PASS — missing/optional/mismatched/unsupported/malformed proof shapes remain unchanged and fail closed in the strict verifier.
- AC3: PASS — both autostart aliases accept typed booleans only; explicit present/absent facts are distinguished from connector/readiness/option facts; unknown and conflict fail closed.
- AC4: PASS — answer evidence and visible cards call the same strict autostart product verifier; the public card selector also applies it when a policy exists without explicit selected ids.
- AC5: PASS — writer and reviewer prompts make top-level validated `products` authoritative and forbid promotion of raw catalog ids.
- AC6: PASS — a blocked answer is marked failed, failed review evidence is persisted, and a rejected answer contract is saved before the exception escapes.
- AC7: PASS — recovery receives bounded structured prior-review feedback; issue count and message length are capped and buyer-facing prompts forbid exposing internal codes.
- AC8: PASS — the existing per-run model/tool budgets remain authoritative; the fresh recovery attempt reuses valid prior artifacts and does not loop inside the orchestrator.
- AC9: PASS — focused tests cover shared calculator proof, malformed proofs, both autostart aliases/directions, unknown/conflict facts, answer/card parity, and fresh recovery after block.
- AC10: PASS — no buyer-sentence branch was added; the no-new-regex release gate passes.
- AC11: PASS — full local release gate, dependency audit, typecheck, tests, eval, build, and diff check pass.
- AC12: PENDING — commit/push and Railway marker are performed after independent verification.
- AC13: PENDING — fresh adaptive embedded-widget replay is required after Railway reports the exact commit.
- AC14: PENDING — production ids, transcript, metadata, marker, and final verdict will be appended after the live replay.

## Local commands and outcomes

- `npm.cmd test -- --run tests/productClassifier.test.ts tests/agentManagerCardSelection.test.ts tests/agentManagerOrchestrator.test.ts` — PASS, 153/153.
- `npm.cmd run verify` — PASS on the final frozen code: 105 files, 957/957 tests; 4 eval files, 251/251; typecheck and production build pass; no new regex constructs; production dependency audit passes.
- `npm.cmd audit --audit-level=low` — PASS, 0 vulnerabilities.
- `git diff --check` — PASS (line-ending warnings only, no whitespace errors).

## Safety observations

- Catalog rows with contradictory generator phase facts remain excluded; this fix does not weaken phase validation.
- A connector, ATS readiness, or optional autostart capability is not treated as an installed autostart system.
- A raw successful catalog call is not permission to name or show a product when validated `products=[]`.
- The first sandboxed release-gate audit failed only because the npm registry/cache was unavailable. The audit was rerun with approved network/cache access and the entire release gate then passed.

## Independent verifier

- Verdict: PASS for AC1–AC11 on the final frozen source/test diff.
- Independent focused run: PASS, 157/157 tests across four files.
- Independent typecheck, `git diff --check`, and canonical `lint:no-regex` guard: PASS.
- No blocking checkpoint loop, unsafe autostart false-positive, raw-catalog recommendation leak, or phrase-specific branch was found.
- Residual non-blocking risk: an unusual but valid autostart spec spelling can remain `unknown` and hide a suitable product. This is the intended fail-closed direction.
- The frozen spec names `test:no-new-regex`; the repository's actual canonical script is `lint:no-regex`, which is also executed by `npm run verify` and passed.
