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
node .agent/tasks/2026-07-08-agentic-dialogue-fixes/production-dialogue-check.mjs
```

Result: FAIL

```text
repeat_1708: issues=1; session=e3b70ff4-3520-422f-89a6-735627ba1d77
FAIL repeat_1708/repeat_1708_battery_1_8kw: no visible product cards for direct battery station request
```

## Command

```powershell
npm test -- tests/recommendationRanking.test.ts tests/agentManagerCardSelection.test.ts
```

Result: PASS after fix

```text
Test Files  2 passed (2)
Tests  234 passed (234)
```

## Command

```powershell
npm test
```

Result: PASS after fix

```text
Test Files  94 passed (94)
Tests  763 passed (763)
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
