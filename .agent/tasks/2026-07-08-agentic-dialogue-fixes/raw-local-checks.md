# Raw Local Checks

## Command

```powershell
npm test -- tests/agentManagerCardSelection.test.ts tests/leadReviewGuards.test.ts tests/agentManagerOrchestrator.test.ts
```

Result: PASS

```text
Test Files  3 passed (3)
Tests  68 passed (68)
```

## Command

```powershell
npm run typecheck
```

Result: PASS

```text
tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.server.json
```

## Command

```powershell
npm test
```

Result: PASS

```text
Test Files  94 passed (94)
Tests  762 passed (762)
```

## Command

```powershell
npm run lint:no-regex
```

Result: NON-BLOCKING FAIL

```text
New regex constructs detected: 90
```

Notes: The reported constructs are existing repository-level findings outside this task diff. This task did not add regex literals.
