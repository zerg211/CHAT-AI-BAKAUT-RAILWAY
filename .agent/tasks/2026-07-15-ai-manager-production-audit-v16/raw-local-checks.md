# Raw local verification — AI manager production audit v16

Verified worktree base: `f41f99ca015cc63c27696becbf1db41dfdefed66` on `main`.

Latest verification timestamp: `2026-07-16T09:11:00+03:00`.

No local OpenAI call, localhost behavior test, direct chat API test, or manual Railway deployment was used.

## Full release gate

Command:

```text
npm run verify
```

Result: `PASS` (exit code 0).

```text
[release-gate] PASS Node.js >=22 runtime (24.14.1)
[release-gate] PASS no new regex constructs relative to HEAD
No new regex constructs. Legacy baseline: 508.
found 0 vulnerabilities
[release-gate] PASS production dependency audit (high severity)
[release-gate] PASS TypeScript typecheck
Test Files 67 passed (67)
Tests 557 passed (557)
[release-gate] PASS full test suite
Test Files 4 passed (4)
Tests 191 passed (191)
[release-gate] PASS agentic eval suite
vite production build: 30 modules transformed
[release-gate] PASS production build
[release-gate] PASS: all local release checks succeeded.
```

## Independent repeated checks

```text
npm test
Test Files 67 passed (67)
Tests 557 passed (557)
```

The first full run exposed one prompt-size regression: the mandatory search-first rule made the generated policy block 3,177 characters against a `< 3,000` limit. The rule was compacted without removing its mandatory semantics. Fresh verification then found four additional gaps: a numeric model index could conflict with real voltage/phase, successful partial research could still permit handoff, the public form could lose pending-draft context, and malformed combined ledger output lacked a coherent fallback. A second probe caught the narrower `SGG 2200A` phase-substring case, so the underlying phase classifier was corrected and covered before the final `549/549` run.

```text
npm run typecheck
PASS: tsconfig.json and tsconfig.server.json

npm run lint:no-regex
PASS: no new regex constructs; legacy baseline 508

npm audit --omit=dev --audit-level=high
PASS: found 0 vulnerabilities

git diff --check
PASS
```

Fresh independent V13 verifier repeated the focused suite (117/117), typecheck, full release gate (557/557 plus 191/191 agentic evals), build, audit, no-new-regex, and `git diff --check`: all PASS. It reported no residual local V13 P0/P1/P2; production AC14 remains pending.

## Targeted regression coverage included in the green suite

- failed, timed-out, aborted, and budget-skipped web execution is not classified as exhausted research;
- completed unresolved research creates the useful technical handoff clause only after exhaustion;
- generator catalog evidence remains readable under a preliminary/incomplete load basis;
- changed hard requirements replace stale selection state;
- one persisted 60-second deadline and one atomic recovery attempt;
- terminal degraded completion does not promise another automatic recovery;
- durable lead success requires a dispatchable outbox row;
- partial contact survives across turns only in a scoped expiring draft and preserves the original buyer question;
- reviewer rewrites are revalidated for unsupported identifiers, numbers, commercial promises, and false lead confirmation;
- general company delivery availability remains allowed while exact delivery promises remain blocked;
- model indices such as `5000`, `2200`, or `2300` are not treated as voltage/phase evidence; a genuine bounded marker such as `О230` remains recognizable;
- successful but partial research with `sourcesExhausted=false` cannot trigger technical handoff;
- the public lead form atomically queues the original draft question/purpose/contact preference and clears draft PII;
- oversized combined understanding was removed; independent reducer and planner calls start in parallel and preserve independent checkpoints;
- a valid sibling semantic contract survives model, validation, or checkpoint failure in the other stage and recovery repeats only the missing work;
- output-cap exhaustion records its exact disposition, never retries the same cap internally, and recovery uses a bounded larger cap;
- pending lead-draft context is serialized in both real reducer and planner model requests without contact PII;
- consistency replan is scoped to the active need, so a paused sibling need cannot consume an unnecessary planner call;
- the exceptional replan plus closed-question repair path has a proven six-call logical budget under the unchanged wall-time limit;
- generic requirement proofs bind a successful source result to the exact product and hard requirement;
- authoritative product proof can override a lower-authority catalog conflict while preserving a caveat;
- visible cards deduplicate semantically identical model entries;
- the reproduced first-turn generator timeout has targeted concurrency, partial-recovery, output-cap, and deadline regressions.

## Remaining mandatory proof

Local verification does not prove production behavior. AC1, AC2, AC10, AC11, and AC14 remain pending until commit/push, Railway deployment, exact runtime-marker verification, and fresh adaptive conversations through the embedded widget at `https://bakautprof.ru/`.
