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

Not run locally. Project instructions mark local OpenAI/Promptfoo checks invalid in this environment because OpenAI requests return `403 Country, region, or territory not supported`.

## Railway marker

Command:

```powershell
GET https://chat-ai-production-3057.up.railway.app/api/health
```

Result:

```text
runtime.commitSha: 1aeae873b1feba3492da26dd2c580f60866515b0
runtime.branch: main
```

## Production Promptfoo

Command:

```powershell
$env:PROMPTFOO_CHAT_BASE_URL='https://chat-ai-production-3057.up.railway.app'
$env:PROMPTFOO_CHAT_PAGE_URL='https://bakautprof.ru/?agentHarness=1'
npm run evals -- --no-cache -j 1 -o .agent/tasks/2026-05-21-exact-catalog-description-research/production-evals-after-1aeae87.json
```

Result:

```text
6 passed, 0 failed, 0 errors
Deterministic average: 0.9889444444444445
LLM average: 0.94
Assertion pass rate: 1
```

## Production embedded widget

Artifact:

```text
local-live-tests/2026-05-22-exact-catalog-description-widget.production.md
```

Result:

```text
PASS: checked through embedded production iframe on bakautprof.ru.
PASS: answer names the exact RD3910E context and confirms key/electrostarter start mechanism.
Assistant answer: Заводится с ключа, через электростартер; также указан ручной стартер. В каталоге БАКАУТ Firman RD3910E есть.
```
