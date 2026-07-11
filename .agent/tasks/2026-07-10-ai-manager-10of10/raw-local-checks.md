# Raw local checks — 2026-07-11

Workspace: `C:\Projects\chatAI`
Baseline: `2ce1ce43b3804b72e723d403fc355a66331b3358`
Runtime used: Node `v24.14.1`, npm `11.11.0`

## Complete release gate

Command:

```text
npm run verify
```

Final independent-verifier result: exit code `0`.

```text
[release-gate] PASS no new regex constructs relative to HEAD
Legacy baseline: 1623.
Legacy findings removed since baseline: 150.

[release-gate] PASS production dependency audit (high severity)
found 0 vulnerabilities

[release-gate] PASS TypeScript typecheck

Test Files  105 passed (105)
Tests       918 passed (918)

[release-gate] PASS full test suite

Test Files  4 passed (4)
Tests       251 passed (251)

[release-gate] PASS agentic eval suite
[release-gate] PASS production build
[release-gate] PASS: all local release checks succeeded.
```

The Node child-process deprecation warning emitted after success is non-failing and does not change the command verdict.

This final run includes regressions for two identical sequential buyer actions, a 90-message snapshot-plus-tail dialogue, strict per-tool schemas, cross-topic state/card isolation, durable selection resume, answered-question semantic rewrite/recheck, provider token/cost/wall budgets, catalog fact review with `factsUsed=[]`, model-input catalog deduplication, strict ceramic filtering, complete tool-budget artifacts, and fail-closed unsupported strict hard constraints.

## All dependency severities

Command:

```text
npm audit --audit-level=low
```

Result: exit code `0`.

```text
found 0 vulnerabilities
```

## Explicit no-regex guard

Command:

```text
npm run lint:no-regex
```

Result: exit code `0`.

```text
No new regex constructs. Legacy baseline: 1623.
Legacy findings removed since baseline: 150.
```

## Focused migrations and catalog freshness

Command:

```text
npx vitest run tests/migrate.test.ts tests/assistantFeedbackMigration.test.ts tests/catalogFreshness.test.ts tests/catalogRepositoryFreshness.test.ts
```

Result: exit code `0`.

```text
Test Files  4 passed (4)
Tests       25 passed (25)
```

## Patch integrity

Command:

```text
git diff --check
```

Result: exit code `0`. Git printed only expected Windows LF-to-CRLF working-copy notices; no whitespace errors were reported.

## Production behavior restriction

No localhost or direct-API OpenAI behavior run was performed. Per repository policy, live behavior proof is deferred until GitHub push and Railway deployment, then must run through the embedded widget on `https://bakautprof.ru/`.
