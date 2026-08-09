# Tri-state catalog / power qualifier builder

Mode: BUILD. Scope owned by this builder:

- `src/ai/agentManagerCardSelection.ts`
- `src/ai/requirementProofs.ts`
- `tests/agentManagerRequirementProofs.test.ts`

No commit, push, deployment, production API call, or live widget check was performed.

## RED

Command:

```text
npm.cmd test -- tests/agentManagerRequirementProofs.test.ts
```

Initial result: exit 1; 3 new contract tests failed and 11 existing tests passed.

- A plausible generator with no nominal-power field was removed instead of remaining a preliminary candidate.
- Maximum, peak, engine, and apparent-power fields were all accepted as proof of a nominal active-power minimum.
- Requirement proofs had no tri-state eligibility field, and an authoritative conflict was excluded during preliminary selection instead of remaining unknown.

## Implementation

- Added `RequirementEligibilityStatus = satisfied | violated | unknown` and `RequirementProof.eligibilityStatus` while retaining the existing detailed proof status (`unverified` / `conflicted`) for diagnostics and compatibility.
- Added per-requirement authority resolution: an exact authoritative web fact may satisfy or violate; conflicting or missing proof resolves to `unknown`; a proven violation in any strict requirement still wins.
- Made power evidence qualifier-aware. `nominal`, `maximum/peak`, `engine`, and `apparent/kVA` are distinct. Only nominal active kW/W evidence can satisfy a nominal active-power requirement.
- Changed preliminary card eligibility so `unknown` stays eligible and only `violated` is excluded. Final fit remains fail-closed for unknown/conflicted evidence.
- Added an explicit `product_cards_preliminary:needs_evidence:<count>` warning when a required web-covered strict requirement remains unknown.
- Exported `qualifiedNominalActivePowerKw` for the directly coupled orchestrator consumer. It accepts the real Bakaut unitless-value shape when the spec key itself declares nominal kW, and rejects maximum, peak, engine, and kVA fields.

## GREEN and connected checks

```text
npm.cmd test -- tests/agentManagerRequirementProofs.test.ts tests/agentManagerCardSelection.test.ts tests/agentManagerConditionalWebShortCircuit.test.ts
```

Exit 0: 3 files, 154 tests passed. This includes the existing conditional-web checks proving that missing/conflicted candidate evidence does not short-circuit required research.

```text
npm.cmd run typecheck
```

Exit 0: client and server TypeScript projects passed.

```text
npm.cmd run lint:no-regex
```

Exit 0: no new regex constructs; legacy baseline 508.

```text
git diff --check -- src/ai/agentManagerCardSelection.ts src/ai/requirementProofs.ts tests/agentManagerRequirementProofs.test.ts
```

Exit 0. Git emitted only the repository's existing LF-to-CRLF working-copy warnings.

## Boundary and remaining risk

`src/ai/agentManagerOrchestrator.ts` contains a directly coupled duplicate answer-product filter. It was already modified and owned by the parallel semantic-coherence builder, so this builder did not edit it. The owner and parent were notified that the consumer must use `resolvedRequirementEligibilityStatus`, retain preliminary unknown/conflicted products, and remove `nominalKw ?? maxKw` for nominal requirements. Until that integration and its connected tests are complete, the visible-card path is corrected but the end-to-end answer-product path is only partially integrated.

Production behavior is not validated by these local checks. The repository's required GitHub to Railway deployment and adaptive `bakautprof.ru` widget audit remain release-level work for the parent task.
