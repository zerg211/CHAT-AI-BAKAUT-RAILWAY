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

## AC11 Production Pass 1

Command: production Playwright audit through the embedded widget on `https://bakautprof.ru/`, followed by `/api/admin/conversations/:id` audit.

Result: FAIL on deployed commit `ea843b0e3dc4135cfb8cb3373d486cf9028a12db`. Exact official BISON USB facts were extracted but not marked exact/persisted; see `../problems.md`.

## AC11 Remediation Focused Gate

Command:

`npx vitest run tests/productComparisonResearch.test.ts tests/agentManagerComparisonResearch.test.ts`

Result: PASS, 2 files and 84 tests. Separate `npm run typecheck` and `git diff --check`: PASS.

## AC11 Remediation Canonical Focused Gate

Command:

`npx vitest run tests/productComparisonResearch.test.ts tests/verifiedFactMemory.test.ts tests/agentManagerComparisonResearch.test.ts tests/agentManagerHarnessContracts.test.ts tests/agentManagerOrchestrator.test.ts tests/openAIAgentManagerModel.test.ts tests/catalogRepositoryFreshness.test.ts tests/migrate.test.ts`

Result: PASS, 8 files and 247 tests.

## AC11 Remediation Release Gate

Command: `npm run verify`

Result: PASS.

- Node.js runtime: PASS (`24.14.1`)
- No new regex constructs: PASS
- Production dependency audit, high severity: PASS (`0 vulnerabilities`)
- Typecheck: PASS
- Full serial suite: PASS (`84 files`, `858 tests`)
- Agentic suite: PASS (`4 files`, `203 tests`)
- Production build: PASS

## AC11 Remediation Fresh Verifier 1

Result: FAIL (`AC5`, `AC6`, `AC9`, `AC10`). Findings: semantic verification did not independently prove an exact source excerpt; the coverage cap could evict unresolved/contradicted items; focused tests omitted both boundaries. The verifier independently reran the 84-test focused gate, typecheck, `git diff --check`, and the full 858-test release gate; all commands passed.

## AC11 Remediation Corrective Focused Gate

Command: `npx vitest run tests/productComparisonResearch.test.ts tests/agentManagerComparisonResearch.test.ts`

Result: PASS, 2 files and 86 tests. Separate `npm run typecheck`: PASS.

## AC11 Corrective Canonical Focused Gate

Command:

`npx vitest run tests/productComparisonResearch.test.ts tests/verifiedFactMemory.test.ts tests/agentManagerComparisonResearch.test.ts tests/agentManagerHarnessContracts.test.ts tests/agentManagerOrchestrator.test.ts tests/openAIAgentManagerModel.test.ts tests/catalogRepositoryFreshness.test.ts tests/migrate.test.ts`

Result: PASS, 8 files and 249 tests.

## AC11 Corrective Release Gate

Command: `npm run verify`

Result: PASS.

- Node.js runtime: PASS (`24.14.1`)
- No new regex constructs: PASS
- Production dependency audit, high severity: PASS (`0 vulnerabilities`)
- Typecheck: PASS
- Full serial suite: PASS (`84 files`, `860 tests`)
- Agentic suite: PASS (`4 files`, `203 tests`)
- Production build: PASS
- `git diff --check`: PASS

## AC11 Remediation Fresh Verifier 2

Result: FAIL (`AC5`, `AC6`, `AC7`, `AC9`, `AC10`). Findings: literal values bypassed semantic attribute validation; catalog/retry merges could lose coverage or primary facts; 48 reachable fail-closed slots were capped to twelve; persisted excerpt casing was not necessarily the fetched-source casing; focused proof omitted these cases. All verifier commands passed.

## AC11 Remediation Corrective Focused Gate 2

Command: `npx vitest run tests/productComparisonResearch.test.ts tests/agentManagerComparisonResearch.test.ts`

Result: PASS, 2 files and 89 tests. Separate `npm run typecheck` and `git diff --check`: PASS.

## AC11 Corrective Canonical Focused Gate 2

Command:

`npx vitest run tests/productComparisonResearch.test.ts tests/verifiedFactMemory.test.ts tests/agentManagerComparisonResearch.test.ts tests/agentManagerHarnessContracts.test.ts tests/agentManagerOrchestrator.test.ts tests/openAIAgentManagerModel.test.ts tests/catalogRepositoryFreshness.test.ts tests/migrate.test.ts`

Result: PASS, 8 files and 252 tests.

## AC11 Corrective Release Gate 2

Command: `npm run verify`

Result: PASS.

- Node.js runtime: PASS (`24.14.1`)
- No new regex constructs: PASS
- Production dependency audit, high severity: PASS (`0 vulnerabilities`)
- Typecheck: PASS
- Full serial suite: PASS (`84 files`, `863 tests`)
- Agentic suite: PASS (`4 files`, `203 tests`)
- Production build: PASS

## AC11 Remediation Fresh Verifier 3 Initial Batch Attempt

Commands: `npm run typecheck` and `npx vitest run tests/productComparisonResearch.test.ts`.

Result: FAIL. Typecheck reported four undefined-limit errors and one missing exact-target argument. Focused product research reported 30 failed and 28 passed tests, including two timeout cancellations.

## AC11 Remediation Batch Correction

Commands:

- `npm run typecheck`
- `npx vitest run tests/productComparisonResearch.test.ts tests/agentManagerComparisonResearch.test.ts`

Result: PASS. Typecheck passed; focused verification passed 2 files and 89 tests. Batch proof asserts one semantic provider call for four fact/coverage claims with a proportional output-token allowance.

## AC11 Remediation Canonical Focused Gate 3

Command: `npx vitest run tests/productComparisonResearch.test.ts tests/verifiedFactMemory.test.ts tests/agentManagerComparisonResearch.test.ts tests/agentManagerHarnessContracts.test.ts tests/agentManagerOrchestrator.test.ts tests/openAIAgentManagerModel.test.ts tests/catalogRepositoryFreshness.test.ts tests/migrate.test.ts`

Result: PASS, 8 files and 252 tests.

## AC11 Remediation Release Gate 3

Command: `npm run verify`

Result: PASS.

- Node.js runtime: PASS (`24.14.1`)
- No new regex constructs: PASS
- Production dependency audit, high severity: PASS (`0 vulnerabilities`)
- Typecheck: PASS
- Full serial suite: PASS (`84 files`, `863 tests`)
- Agentic suite: PASS (`4 files`, `203 tests`)
- Production build: PASS

## AC11 Remediation Fresh Verifier 4 Correction

Finding: the distinct-source cap warning was not classified as unread evidence and therefore did not independently block source exhaustion.

Fix verification commands:

- `npm run typecheck`
- `npx vitest run tests/productComparisonResearch.test.ts tests/agentManagerComparisonResearch.test.ts`
- `git diff --check`
- canonical 8-file focused command
- `npm run verify`

Result: PASS. Focused 89/89, canonical 252/252, full serial 863/863, agentic 203/203, no-regex, dependency audit, typecheck, build, and whitespace check all passed.

## AC11 Remediation Fresh Verifier 5

Result: PASS for AC1-AC10 after a fresh audit of the current code and current command outputs. AC11 remains pending commit/push and production widget/admin verification.
