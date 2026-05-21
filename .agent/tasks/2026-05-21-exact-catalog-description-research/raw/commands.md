# Raw command log

## Focused tests

Command:

```powershell
npm test -- tests/productComparisonResearch.test.ts tests/agentManagerComparisonResearch.test.ts tests/agentManagerIntegrationSource.test.ts
```

Result:

```text
Test Files  3 passed (3)
Tests       17 passed (17)
```

## Typecheck

Command:

```powershell
npm run typecheck
```

Result:

```text
tsc --noEmit -p tsconfig.json
tsc --noEmit -p tsconfig.server.json
Exit code: 0
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

## Full unit suite

Command:

```powershell
npm test
```

Result:

```text
Test Files  73 passed (73)
Tests       593 passed (593)
```

## No-regex guard

Command:

```powershell
npm run lint:no-regex
```

Result:

```text
No new regex constructs. Legacy baseline: 1828.
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

## Promptfoo/OpenAI

Not run locally. Project instructions mark local OpenAI/Promptfoo checks invalid in this environment because OpenAI requests return `403 Country, region, or territory not supported`. Production validation must happen after push and Railway deployment through the production API/widget path.
