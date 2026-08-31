# Command Evidence

## Focused Research Gate

Command:

`npx vitest run tests/productComparisonResearch.test.ts tests/verifiedFactMemory.test.ts tests/agentManagerComparisonResearch.test.ts tests/agentManagerHarnessContracts.test.ts tests/agentManagerOrchestrator.test.ts tests/openAIAgentManagerModel.test.ts tests/catalogRepositoryFreshness.test.ts tests/migrate.test.ts`

Result: PASS, 8 files and 229 tests.

## Typecheck

Command: `npm run typecheck`

Result: PASS for client and server TypeScript projects.

## No Regex

Command: `npm run lint:no-regex`

Result: PASS, no new regex constructs relative to HEAD.

## Release Gate Pass 1

Command: `npm run verify`

Result: FAIL because two assertions in one existing research test still expected environment-derived `none` reasoning after the intentional bounded `low` research profile change. All implementation checks, 909 other tests, agentic suite, build, typecheck, dependency audit, and no-regex guard passed. See `../problems.md`.

## Focused Fix Verification

Command: `npx vitest run tests/productComparisonResearch.test.ts`

Result: PASS, 43 tests.

## Release Gate Pass 2

Command: `npm run verify`

Result: PASS.

- Node.js runtime: PASS (`24.14.1`)
- No new regex constructs: PASS
- Production dependency audit, high severity: PASS (`0 vulnerabilities`)
- Typecheck: PASS
- Full serial suite: PASS (`88 files`, `910 tests`)
- Agentic suite: PASS (`4 files`, `203 tests`)
- Production build: PASS

## Fresh-Verifier Fix Focused Gate

Command:

`npx vitest run tests/productComparisonResearch.test.ts tests/verifiedFactMemory.test.ts tests/agentManagerHarnessContracts.test.ts tests/agentManagerComparisonResearch.test.ts tests/catalogRepositoryFreshness.test.ts tests/migrate.test.ts`

Result: PASS, 6 files and 111 tests. Separate `npm run typecheck`: PASS.

## Release Gate Pass 3

Command: `npm run verify`

Result: FAIL, one existing mocked buyer answer contained `web-поиск завершился ошибкой`; the new last-mile guard correctly rejected it. 914/915 unit tests and 202/203 agentic tests passed; all other gates passed.

## Fixture Repair Verification

Command: `npx vitest run tests/agentManagerOrchestrator.test.ts -t "keeps an over-budget explicit comparison subject"`

Result: PASS. The fixture now states the concrete unresolved information without execution-process wording.

## Release Gate Pass 4

Command: `npm run verify`

Result: PASS.

- Node.js runtime: PASS (`24.14.1`)
- No new regex constructs: PASS
- Production dependency audit, high severity: PASS (`0 vulnerabilities`)
- Typecheck: PASS
- Full serial suite: PASS (`88 files`, `915 tests`)
- Agentic suite: PASS (`4 files`, `203 tests`)
- Production build: PASS

## Fresh-Verifier-2 Remediation Focused Gate

Command:

`npx vitest run tests/productComparisonResearch.test.ts tests/verifiedFactMemory.test.ts tests/agentManagerComparisonResearch.test.ts tests/agentManagerHarnessContracts.test.ts tests/agentManagerOrchestrator.test.ts tests/openAIAgentManagerModel.test.ts tests/catalogRepositoryFreshness.test.ts tests/migrate.test.ts`

Result: PASS, 8 files and 238 tests.

## Release Gate Pass 5

Command: `npm run verify`

Result: PASS.

- Node.js runtime: PASS (`24.14.1`)
- No new regex constructs: PASS
- Production dependency audit, high severity: PASS (`0 vulnerabilities`)
- Typecheck: PASS
- Full serial suite: PASS (`88 files`, `918 tests`)
- Agentic suite: PASS (`4 files`, `203 tests`)
- Production build: PASS

## Fresh-Verifier-3 Remediation Focused Gate

Command:

`npx vitest run tests/productComparisonResearch.test.ts tests/verifiedFactMemory.test.ts tests/agentManagerComparisonResearch.test.ts tests/agentManagerHarnessContracts.test.ts tests/agentManagerOrchestrator.test.ts tests/openAIAgentManagerModel.test.ts tests/catalogRepositoryFreshness.test.ts tests/migrate.test.ts`

Result: PASS, 8 files and 239 tests.

## Release Gate Pass 6

Command: `npm run verify`

Result: PASS.

- Node.js runtime: PASS (`24.14.1`)
- No new regex constructs: PASS
- Production dependency audit, high severity: PASS (`0 vulnerabilities`)
- Typecheck: PASS
- Full serial suite: PASS (`88 files`, `919 tests`)
- Agentic suite: PASS (`4 files`, `203 tests`)
- Production build: PASS

## Fresh-Verifier-4 Remediation Focused Gate

Command:

`npx vitest run tests/productComparisonResearch.test.ts tests/verifiedFactMemory.test.ts tests/agentManagerComparisonResearch.test.ts tests/agentManagerHarnessContracts.test.ts tests/agentManagerOrchestrator.test.ts tests/openAIAgentManagerModel.test.ts tests/catalogRepositoryFreshness.test.ts tests/migrate.test.ts`

Result: PASS, 8 files and 241 tests.

## Release Gate Pass 7

Command: `npm run verify`

Result: PASS.

- Node.js runtime: PASS (`24.14.1`)
- No new regex constructs: PASS
- Production dependency audit, high severity: PASS (`0 vulnerabilities`)
- Typecheck: PASS
- Full serial suite: PASS (`88 files`, `921 tests`)
- Agentic suite: PASS (`4 files`, `203 tests`)
- Production build: PASS

## Fresh-Verifier-5 Remediation Focused Gate

Command:

`npx vitest run tests/productComparisonResearch.test.ts tests/verifiedFactMemory.test.ts tests/agentManagerComparisonResearch.test.ts tests/agentManagerHarnessContracts.test.ts tests/agentManagerOrchestrator.test.ts tests/openAIAgentManagerModel.test.ts tests/catalogRepositoryFreshness.test.ts tests/migrate.test.ts`

Result: PASS, 8 files and 242 tests. Separate `npm run typecheck`: PASS.

## Release Gate Pass 8

Command: `npm run verify`

Result: PASS.

- Node.js runtime: PASS (`24.14.1`)
- No new regex constructs: PASS
- Production dependency audit, high severity: PASS (`0 vulnerabilities`)
- Typecheck: PASS
- Full serial suite: PASS (`88 files`, `922 tests`)
- Agentic suite: PASS (`4 files`, `203 tests`)
- Production build: PASS

## Fresh-Verifier-6 Remediation Focused Gate

Command:

`npx vitest run tests/productComparisonResearch.test.ts tests/verifiedFactMemory.test.ts tests/agentManagerComparisonResearch.test.ts tests/agentManagerHarnessContracts.test.ts tests/agentManagerOrchestrator.test.ts tests/openAIAgentManagerModel.test.ts tests/catalogRepositoryFreshness.test.ts tests/migrate.test.ts`

Result: PASS, 8 files and 243 tests. Separate `npm run typecheck`: PASS.

## Release Gate Pass 9

Command: `npm run verify`

Result: PASS.

- Node.js runtime: PASS (`24.14.1`)
- No new regex constructs: PASS
- Production dependency audit, high severity: PASS (`0 vulnerabilities`)
- Typecheck: PASS
- Full serial suite: PASS (`88 files`, `923 tests`)
- Agentic suite: PASS (`4 files`, `203 tests`)
- Production build: PASS

## Fresh-Verifier-7 Remediation Focused Gate

Command:

`npx vitest run tests/productComparisonResearch.test.ts tests/verifiedFactMemory.test.ts tests/agentManagerComparisonResearch.test.ts tests/agentManagerHarnessContracts.test.ts tests/agentManagerOrchestrator.test.ts tests/openAIAgentManagerModel.test.ts tests/catalogRepositoryFreshness.test.ts tests/migrate.test.ts`

Result: PASS, 8 files and 245 tests. Separate `npm run typecheck`: PASS.

## Release Gate Pass 10

Command: `npm run verify`

Result: PASS.

- Node.js runtime: PASS (`24.14.1`)
- No new regex constructs: PASS
- Production dependency audit, high severity: PASS (`0 vulnerabilities`)
- Typecheck: PASS
- Full serial suite: PASS (`88 files`, `925 tests`)
- Agentic suite: PASS (`4 files`, `203 tests`)
- Production build: PASS

## Fresh-Verifier-8 Remediation Focused Gate

Command:

`npx vitest run tests/productComparisonResearch.test.ts tests/verifiedFactMemory.test.ts tests/agentManagerComparisonResearch.test.ts tests/agentManagerHarnessContracts.test.ts tests/agentManagerOrchestrator.test.ts tests/openAIAgentManagerModel.test.ts tests/catalogRepositoryFreshness.test.ts tests/migrate.test.ts`

Result: PASS, 8 files and 245 tests. Separate `npm run typecheck`: PASS.

## Release Gate Pass 11

Command: `npm run verify`

Result: PASS.

- Node.js runtime: PASS (`24.14.1`)
- No new regex constructs: PASS
- Production dependency audit, high severity: PASS (`0 vulnerabilities`)
- Typecheck: PASS
- Full serial suite: PASS (`88 files`, `925 tests`)
- Agentic suite: PASS (`4 files`, `203 tests`)
- Production build: PASS

## Post-Cleanup Focused Gate

Command:

`npx vitest run tests/productComparisonResearch.test.ts tests/verifiedFactMemory.test.ts tests/agentManagerComparisonResearch.test.ts tests/agentManagerHarnessContracts.test.ts tests/agentManagerOrchestrator.test.ts tests/openAIAgentManagerModel.test.ts tests/catalogRepositoryFreshness.test.ts tests/migrate.test.ts`

Result: PASS, 8 files and 245 tests. Separate `npm run typecheck`: PASS.

## Release Gate Pass 12

Command: `npm run verify`

Result: PASS after removing all unrelated tracked and untracked worktree changes.

- Node.js runtime: PASS (`24.14.1`)
- No new regex constructs: PASS
- Production dependency audit, high severity: PASS (`0 vulnerabilities`)
- Typecheck: PASS
- Full serial suite: PASS (`84 files`, `856 tests`)
- Agentic suite: PASS (`4 files`, `203 tests`)
- Production build: PASS
