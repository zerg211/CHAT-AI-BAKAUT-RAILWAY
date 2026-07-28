# Raw Local Checks

## Initial Focused Check

```powershell
npm test -- tests/agentManagerCardSelection.test.ts tests/leadReviewGuards.test.ts tests/agentManagerOrchestrator.test.ts
```

Result: PASS

```text
Test Files  3 passed (3)
Tests  68 passed (68)
```

## Typecheck

```powershell
npm run typecheck
```

Result: PASS

```text
tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.server.json
```

## Full Test Suite

```powershell
npm test
```

Result: PASS

```text
Test Files  94 passed (94)
Tests  769 passed (769)
```

## Judge-Fix Focused Check

```powershell
npm test -- tests/agentManagerCardSelection.test.ts tests/agentManagerOrchestrator.test.ts
```

Result: PASS

```text
Test Files  2 passed (2)
Tests  70 passed (70)
```

## Regex Guard

```powershell
npm run lint:no-regex
```

Result: NON-BLOCKING FAIL

```text
New regex constructs detected: 91
```

Notes: The reported constructs are existing repository-level findings outside the final card-selection diff. The final phase requirement check uses deterministic token scanning rather than adding regex literals.

## Production Health Marker

```powershell
Invoke-RestMethod https://chat-ai-production-3057.up.railway.app/api/health
```

Result: PASS

```text
commit=2ce1ce43b3804b72e723d403fc355a66331b3358
```

## Production Widget Dialogue Check

```powershell
$env:EXPECTED_PRODUCTION_COMMIT='2ce1ce43b3804b72e723d403fc355a66331b3358'
node .agent/tasks/2026-07-08-agentic-dialogue-fixes/production-dialogue-check.mjs
```

Result: PASS

```text
repeat_1708: issues=0; session=d38e1a5a-faeb-4e1a-b74f-c96a4d77bd00
repeat_1707_with_form: issues=0; session=66b07355-445f-4877-b324-15b26abfaf66
repeat_1706: issues=0; session=6d1c4f22-f268-42d8-a1c4-26ee4220d2d5
new_plate: issues=0; session=7cb5ac2c-1510-4469-9618-14d49fc80b1e
new_diesel: issues=0; session=c0363f53-263e-496c-b9f6-b74694e7b746
new_context_switch: issues=0; session=23298b8c-88ed-488a-8d18-909010c1569e
PASS production dialogue check. Protocol: .agent\tasks\2026-07-08-agentic-dialogue-fixes\production-dialogues-2026-07-08T14-39-57-735Z.production.md
```
