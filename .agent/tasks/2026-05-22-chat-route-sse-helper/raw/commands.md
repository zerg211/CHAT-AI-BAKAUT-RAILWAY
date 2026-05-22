# Raw command log

## Focused tests

Command:

```powershell
npm test -- tests/chatSse.test.ts tests/agentManagerIntegrationSource.test.ts
```

Result:

```text
Test Files  2 passed (2)
Tests       12 passed (12)
```

## No-regex guard

Command:

```powershell
npm run lint:no-regex
```

Result:

```text
No new regex constructs. Legacy baseline: 1824.
```

## Typecheck

Command:

```powershell
npm run typecheck
```

Result:

```text
Exit code: 0
```

## Full tests

Command:

```powershell
npm test
```

Result:

```text
Test Files  74 passed (74)
Tests       598 passed (598)
```

## Build

Command:

```powershell
npm run build
```

Result:

```text
vite build passed
tsc -p tsconfig.server.json passed
Exit code: 0
```

## Diff check

Command:

```powershell
git diff --check
```

Result:

```text
Exit code: 0
CRLF warnings only.
```
