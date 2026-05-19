# Raw Command Log

## Focused Tests

```text
npm test -- tests/embeddingRetrieval.test.ts tests/conversationRepository.test.ts tests/migrate.test.ts
Test Files  3 passed (3)
Tests  18 passed (18)
```

## Typecheck

```text
npm run typecheck
tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.server.json
PASS
```

## Selection/Eval Tests

```text
npm test -- tests/recommendationRanking.test.ts tests/agenticCycle876.test.ts tests/agentTurnContract.test.ts tests/agentRuntimeContractsEval.test.ts
Test Files  4 passed (4)
Tests  249 passed (249)
```

## Migration

```text
npm run migrate
Migrations completed
```

## Backfill Dry Run

```json
{
  "model": "text-embedding-3-small",
  "dryRun": true,
  "limit": 3,
  "products": {
    "scanned": 3,
    "planned": 3,
    "updated": 0,
    "skippedFresh": 0,
    "failed": 0
  },
  "catalogPages": {
    "scanned": 3,
    "planned": 3,
    "updated": 0,
    "skippedFresh": 0,
    "failed": 0
  }
}
```

## Full Tests

```text
npm test
Test Files  45 passed (45)
Tests  452 passed (452)
```

## Diff Check

```text
git diff --check
PASS, with Git line-ending warnings only.
```
