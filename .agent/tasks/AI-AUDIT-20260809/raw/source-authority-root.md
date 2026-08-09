# Deterministic web source authority — root evidence

Date: 2026-08-09

## RED

Fresh command:

`npm.cmd test -- --run tests/productComparisonResearch.test.ts tests/agentManagerRequirementProofs.test.ts --testTimeout=20000 --maxWorkers=1 --no-file-parallelism`

Result: 2 failures. Self-reported `official_page` / `official_manual` attempts were accepted even though every actual `web_search_call.action.sources` URL belonged to `marketplace.example`; a high-confidence marketplace fact received `authoritative_web` and overrode conflicting catalog evidence.

## Fix

- The runtime parses the sources actually attached to each completed web-search call.
- It classifies URL host, document kind, and manufacturer binding deterministically; LLM tier labels are only accepted when the actual source descriptor reaches that tier. Explicit zero-result searches remain auditable as `not_found`.
- Accepted facts are annotated with deterministic source tier/authority after source-text validation.
- Requirement proofs independently derive authority from the actual URL and product brand binding. High model confidence alone no longer creates `authoritative_web`.
- An unofficial exact source remains useful as `corroborated_web`, but cannot override contradictory catalog evidence by itself.

## GREEN

Same fresh command after an added direct classifier assertion: 2 files, 52 tests, PASS. The direct contract proves a FIRMAN-hosted PDF is `official_manual/manufacturer`, while a marketplace URL for the same exact model remains `reliable_secondary/secondary`.

The immediately concurrent global typecheck was non-zero only because the session-fencing worker had already added RED test contracts that its production signatures had not yet implemented. No source-authority type error was reported; a fresh integrated typecheck is required after that worker finishes.

## Conservative boundary

Manufacturer authority is granted only when the normalized brand is bound to the source host (plus the reserved `manufacturer.example` test host). Corporate domains that do not visibly bind to the catalog brand remain secondary until the catalog carries an explicit official-domain mapping. This is intentionally fail-closed.
