# Remediation execution log

Date: 2026-05-16
Project: `C:\Projects\chatAI`

## Backup

Created before remediation:

`C:\Projects\chatAI-backups\chatAI-backup-20260516-141548`

Restore path: copy this backup back over `C:\Projects\chatAI` or compare with the backup's `BACKUP-METADATA.json`. The backup excludes generated/heavy folders (`node_modules`, `dist`, `.vite`, `coverage`, `.turbo`, logs) and keeps source, config, docs, tests, git metadata, and local env files that existed at backup time.

## Implemented fixes

### P0: preserved planner/user hard constraints

Problem found:

`applyPlannerSelectionContract` could clear `brandConstraint`, `exactModelConstraint`, `fuel`, and `singlePhase220` when a later planner response omitted those fields. That made a later executor/card pass able to show products outside the buyer's already active constraints.

Changed:

- `src/ai/assistant.ts`
  - only clears brand/exact model/fuel/phase when the prior value came from planner provenance;
  - preserves explicit-user and previous-selection constraints across later planner omissions.

Behavior after fix:

- If the buyer narrows to TSS gasoline 8-10 kW, a later follow-up without repeating "TSS бензин" does not erase those constraints.
- The regression where `other-8` could appear under active `brand=TSS` and `fuel=gasoline` is now covered by tests.

### P0: client turn timeout for stalled stream/recovery

Problem found:

Production live cycle previously failed with `Chat input did not become enabled before timeout`. A stalled SSE/recovery path could leave the widget busy.

Changed:

- `src/client/main.tsx`
  - added a 180 second turn-level abort watchdog;
  - clears the watchdog in `finally`, so normal turns are unaffected.

Behavior after fix:

- If stream/recovery never completes, the client aborts the turn and re-enables the input instead of leaving the buyer stuck.
- This protects UX locally and after deployment. The previous production failure cannot be fully validated against `bakautprof.ru` until this bundle is deployed to Railway.

### P1: ExecutionContract

Problem found:

The runtime had `AgentTurnContract` and `ResolvedTurnContract`, but no single execution policy saved with the answer. Downstream metadata could not clearly show whether a turn was catalog-only, web-required, specialist-required, lead-forbidden, etc.

Changed:

- `src/shared/types.ts`
  - added `ExecutionContract` and policy types.
- `src/ai/executionContract.ts`
  - builds a compact execution policy from `AgentTurnContract`, `ResolvedTurnContract`, active requirements, active hard constraints, and web-search requirement.
- `src/ai/assistant.ts`
  - includes `executionContract` in answer input payload, DB metadata, and returned response metadata.
- `tests/executionContract.test.ts`
  - covers lead-forbidden selection, specialist availability handoff, and web-required factual turns.

Behavior after fix:

- Each answer now has a machine-readable policy:
  - `cardsPolicy`: none / primary / supporting / selected_only;
  - `leadPolicy`: none / forbidden / optional_after_answer / required_now;
  - `factPolicy`: catalog_only / web_required / specialist_required;
  - `activeRequirementIds` and `activeConstraints`.
- Answer generation sees this policy directly, so the model has a stronger single source of truth for the current turn.

### P1: CardManifest

Problem found:

The code returned product cards, but did not persist a structured manifest describing visible/hidden cards, their role, and whether visible cards satisfy hard constraints.

Changed:

- `src/shared/types.ts`
  - added `CardManifest`, `CardManifestItem`, card role, and constraint status types.
- `src/ai/cardManifest.ts`
  - builds visible/hidden card manifest;
  - validates visible cards against high-signal hard constraints: product class, brand, exact model/tokens, fuel, and 220/380 phase;
  - enforces high-confidence visible-card violations before answer generation by removing violating visible cards from the payload.
- `src/ai/assistant.ts`
  - includes `cardManifest` in answer input payload, DB metadata, and returned response metadata.
- `tests/cardManifest.test.ts`
  - covers satisfying cards, violating visible cards, hidden-card non-violations, and pre-render suppression of violating visible cards.

Behavior after fix:

- If the visible card violates active hard constraints, metadata contains:
  - item `constraintStatus=violates_hard_constraints`;
  - concrete `violations`;
  - warning `visible_card_constraint_violation:<productId>`.
- Before answer generation, visible cards with high-confidence hard-constraint violations are removed from the outgoing card payload; metadata records `visible_card_constraint_violations_suppressed:<ids>`.
- This gives production live scripts and admin review a direct way to catch wrong visible cards.

### P1: RequirementLedger

Problem found:

The runtime had semantic memory and selection hard constraints, but no compact ledger showing which requirements were active for the current turn and which hard constraints were derived from them.

Changed:

- `src/shared/types.ts`
  - added `RequirementLedger` types.
- `src/ai/requirementLedger.ts`
  - builds a turn-level ledger from active semantic requirements and selection hard constraints.
- `src/ai/assistant.ts`
  - includes `requirementLedger` in answer input payload, DB metadata, response metadata, and trace metadata.
- `tests/requirementLedger.test.ts`
  - covers active semantic requirements, hard constraints, and warnings when hard constraints have no active semantic mirror.

Behavior after fix:

- Each turn records `activeRequirementIds`, `primaryRequirementIds`, `alternativeMode`, requirement items, hard constraint keys, and warnings.
- Audits can now see when the executor is using a constraint that the current semantic state did not explicitly justify.

### P1: FactClaimPlanner

Problem found:

The answer prompt had many factual guardrails, but no structured policy identifying allowed fact sources and forbidden claim classes for the current turn.

Changed:

- `src/shared/types.ts`
  - added `FactClaimPlanner` types.
- `src/ai/factClaimPlanner.ts`
  - builds allowed sources, required disclaimers, forbidden claims, risk level, and warnings from `ExecutionContract`, `RequirementLedger`, and `CardManifest`;
  - extracts a structured `FactClaimAudit` from the final answer: product references, prices, availability, delivery, discount/terms, technical specs, and current-lineup claims.
- `src/ai/assistant.ts`
  - includes `factClaimPlanner` and final-answer `factClaimAudit` in answer input payload, DB metadata, response metadata, and trace metadata.
- `tests/factClaimPlanner.test.ts`
  - covers catalog-only recommendations, specialist-required facts, visible card constraint violations, grounded product/price/technical claims, unverified availability/delivery claims, and web-required current-lineup claims.

Behavior after fix:

- Catalog-card turns allow catalog/visible-card facts and forbid invented product names/prices/specs.
- Availability/delivery/discount/special-term turns are high risk and require specialist verification wording.
- A visible card violation blocks treating that card as a recommendation in the claim policy.
- `factClaimAudit` now records concrete claim candidates with required source and grounding status, so audits can inspect exactly what the answer asserted.

### P1: LeadStateMachine

Problem found:

Lead behavior was spread across plan flags, lead suppression helpers, auto-lead creation, prompt text, and answer repair.

Changed:

- `src/shared/types.ts`
  - added `LeadStateMachine` types.
- `src/ai/leadStateMachine.ts`
  - derives a single state and next action from `ExecutionContract`, contact presence, requested lead, auto-lead result, and errors.
- `src/ai/assistant.ts`
  - includes `leadStateMachine` in answer input payload, DB metadata, response metadata, and trace metadata.
- `tests/leadStateMachine.test.ts`
  - covers forbidden contact pressure, missing contact for required handoff, and created-lead terminal state.

Behavior after fix:

- `leadPolicy=forbidden` produces `state=not_allowed` and `nextAction=do_not_ask_contact`.
- Required handoff without contact produces `state=required_contact_missing`.
- Created lead produces `state=created`, so answer generation can confirm rather than ask again.

### P1/P2: observability and eval suite

Changed:

- `src/ai/assistant.ts`
  - trace metadata now includes execution policy, requirement count, contract warning count, fact claim risk, and lead state.
- `tests/agentRuntimeContractsEval.test.ts`
  - adds a contract-stack eval for recommendation and specialist-handoff turns.
- `package.json`
  - adds `npm run test:eval:agentic`.
- live scripts now also fail on missing `requirementLedger`, `factClaimPlanner`, or `leadStateMachine`.
- live scripts now also fail on missing `factClaimAudit`.

Behavior after fix:

- Runtime traces and admin metadata can show why a turn was treated as catalog-only, web-required, specialist-required, lead-forbidden, or lead-required.
- The eval suite checks cross-artifact consistency instead of only isolated helper output.

### P2: PostAnswerVerification

Problem found:

`FactClaimPlanner`, `LeadStateMachine`, and `CardManifest` created policies, but the final buyer-facing text still needed an explicit verification pass after all answer repairs.

Changed:

- `src/shared/types.ts`
  - added `PostAnswerVerification` and `PostAnswerVerificationRecovery` types.
- `src/ai/postAnswerVerifier.ts`
  - checks the final answer for forbidden contact asks, unverified live stock/delivery/discount/exact-term promises, and references to visible cards that violate hard constraints;
  - consumes `FactClaimAudit` warnings and elevates ungrounded availability, delivery, terms, and current-lineup claims into verification issues;
  - repairs recoverable text-only violations before persistence: forbidden contact asks and overconfident commercial promises.
- `src/ai/assistant.ts`
  - runs verification after final answer repairs, applies deterministic recovery for recoverable verification errors, verifies again, and stores verification/recovery in DB metadata, response metadata, trace metadata, and `contractWarnings`.
- `tests/postAnswerVerifier.test.ts`
  - covers pass, forbidden contact pressure, recovery of forbidden contact pressure, unverified commercial promises, recovery of commercial promises, and violating-card mentions.
- live scripts now fail when `postAnswerVerification.status=error`.

Behavior after fix:

- A final answer that asks for contact while `leadStateMachine.nextAction=do_not_ask_contact` is marked `error`.
- A final answer that promises availability, delivery, discount, or exact terms without verification wording on specialist-required turns is marked `error`.
- A final answer that names a visible card with hard constraint violations is marked `error`.
- Recoverable text errors are corrected before saving the assistant message; unrecoverable card-contract errors remain visible to live/eval gates.
- Ungrounded claim-level findings from `FactClaimAudit` now affect `PostAnswerVerification`, not only passive metadata.

### P1: production live guards

Changed:

- `tests/liveAgentCycle.production.mjs`
- `tests/liveAgentCycle.876.production.mjs`

Both production scripts now fail if:

- `requirementLedger` is missing;
- `executionContract` is missing;
- product cards exist but `cardManifest` is missing;
- `factClaimPlanner` is missing;
- `factClaimAudit` is missing;
- `leadStateMachine` is missing;
- `postAnswerVerification` is missing or reports `status=error`;
- `cardManifest` reports a visible hard-constraint violation;
- legacy contract fallback or AI fallback diagnostics appear.

### P1/P2: admin observability

Problem found:

The runtime contracts were persisted into metadata and traces, but the admin conversation view still showed only legacy flags: web search, fallback, feedback, and card ranking. Manual dialogue audits could therefore miss a broken execution policy, ungrounded fact claim, hidden card-contract violation, or failed post-answer verification.

Changed:

- `src/client/main.tsx`
  - adds compact admin diagnostic flags for `executionContract`, `requirementLedger`, `cardManifest`, `factClaimPlanner`, `factClaimAudit`, `leadStateMachine`, and `postAnswerVerification`;
  - marks risky artifacts with the existing warning style: contract warnings, ledger warnings, visible card hard-constraint violations, high-risk/ungrounded fact claims, failed lead state, and non-pass post-answer verification;
  - keeps the diagnostics inside the admin message flags, not inside the buyer-facing widget UI.

Behavior after fix:

- A reviewer opening a dialogue in admin can see, per assistant turn, whether the answer was catalog-only, web-required, specialist-required, lead-forbidden, or lead-required.
- Card behavior is now inspectable as `visible/total + policy`, so mismatches between text and shown cards are faster to spot.
- Final-answer safety is visible as `verify: pass|warn|error`, with issue count and recovery status.
- This does not change buyer-facing text; it only improves auditability.

### P1: production validation hardening

Problem found:

The production live-cycle can hang long enough that an external command timeout kills Node before the script writes a fresh failure artifact. That weakens the audit loop: the project knows a live check failed, but the report may still point to an older artifact.

The local full-agent live run also exposed a live-gate gap: the buyer-facing fallback text `Сейчас не смог надежно сформировать ответ. Вопрос сохранен, повторите его через пару минут.` was not caught on the first turn by the critical-text guard, so the script logged `PASS turn 1` and only failed on the next semantic assertion.

Additional deployment check:

- `railway status` failed in this local environment with `invalid_grant`; the Railway CLI needs `railway login` before this workstation can deploy or confirm the service status.
- Because the current local bundle is not deployed, production live checks still exercise the previous Railway deployment, not the new remediation code.

Changed:

- `tests/liveAgentCycle.production.mjs`
  - protocol filename now ends in `.production.md`;
  - added an internal global watchdog with `LIVE_AGENT_GLOBAL_TIMEOUT_MS` override;
  - on timeout, writes `local-live-tests/production-agent-cycle-failure.json` with the current partial steps before exiting.
- `tests/liveAgentCycle.876.production.mjs`
  - added the same global watchdog and timeout artifact behavior.
- `tests/liveAgentCycle.production.mjs`
- `tests/liveAgentCycle.876.production.mjs`
- `tests/liveAgentCycle.local-llm-full.mjs`
  - critical text patterns now also fail on the actual fallback wording: `не смог ... сформировать ответ`, `вопрос сохранен ... повторите`, and `повторите ... через пару минут`.

Behavior after fix:

- A hanging production live run now creates a current failure artifact instead of relying on the shell timeout.
- The failure evidence includes the latest captured buyer-visible turns, so the next audit can see what the customer actually saw before the run stopped.
- Buyer-visible fallback text fails the live script on the same turn where the customer saw it instead of being misclassified as a passed turn.

### P1: predeploy gate

Problem found:

The remediation checks were available as separate commands, but there was no single repeatable predeploy command that runs the static, unit, eval, and live-script syntax gates before Railway deployment.

Changed:

- `package.json`
  - adds `npm run test:remediation:predeploy`.
  - adds `npm run test:live:local:llm`.
- `tests/remediationPredeploy.mjs`
  - runs `npm run typecheck`;
  - runs `npm test`;
  - runs `npm run test:eval:agentic`;
  - runs `npm run build`;
  - runs `node --check` for production, #876 production, diverse production, and local LLM live scripts;
  - runs `node --check` for external readiness, postdeploy, and Railway deploy orchestration scripts;
  - uses `process.execPath` and `npm_execpath` to run npm reliably on Windows without shell warnings.

Behavior after fix:

- Before deploy, the current remediation stack can be checked with one command.
- This command does not replace production live validation; it proves local static/unit/eval readiness and live-script parseability before Railway deploy.

### P1: external readiness diagnostics

Problem found:

External blockers were previously discovered through manual commands (`railway status`, Docker/Postgres startup, OpenAI live calls). That made it too easy to confuse infrastructure failures with bot behavior regressions.

Production health also only exposed model names, so a `200 OK` healthcheck could not prove that Railway was running the remediated build instead of the previous deployment.

Changed:

- `package.json`
  - adds `npm run test:remediation:external-readiness`.
- `src/app.ts`
  - adds `REMEDIATION_CONTRACT_VERSION=2026-05-16-agent-contract-stack-v1`;
  - exposes `remediation.contractVersion` and `remediation.runtimeArtifacts` from `/api/health`.
- `tests/app.test.ts`
  - verifies the health response exposes the remediation marker and required runtime artifact names.
- `tests/remediationExternalReadiness.mjs`
  - checks Railway CLI status;
  - classifies Railway failures as `railway_auth`, `railway_network`, `railway_project_link`, or `railway_unknown`;
  - checks Docker daemon;
  - checks local PostgreSQL connectivity through `DATABASE_URL`;
  - checks OpenAI API reachability without printing the API key;
  - checks Railway production health endpoint and requires the expected remediation marker;
  - writes `local-live-tests/remediation-external-readiness.json` with structured blockers.
- `tests/remediationProductionMarker.mjs`
  - centralizes the expected remediation marker, required runtime artifact list, and production health marker assertion.
- `tests/liveAgentCycle.production.mjs`
- `tests/liveAgentCycle.876.production.mjs`
  - now require the production remediation marker before opening the widget and running the long live scenario.
- `tests/liveAgentCycle.diverse.production.mjs`
  - now require the production remediation marker before opening the widget and running the long live scenario.

Behavior after fix:

- External readiness is now a reproducible command separate from the local code predeploy gate.
- The command is expected to fail while external blockers exist; its artifact explains whether the blocker is Railway, Postgres/Docker, OpenAI provider access, quota/auth, or production health.
- After deployment, `/api/health` can prove that production is running the contract-stack remediation build before production live scripts are trusted.
- Direct production live scripts now also refuse to run against an old Railway deployment; they no longer rely only on the postdeploy wrapper for marker enforcement.
- Production health readiness now requires both the remediation contract version and the complete runtime artifact list.

### P1: postdeploy verification command

Problem found:

After deployment, verification required several manual commands in the right order: check production marker, ensure admin metadata token exists, run the main production live cycle, then run the #876 production live cycle. Running live checks before proving the marker risks auditing an old deployment.

Changed:

- `package.json`
  - adds `npm run test:remediation:postdeploy`.
- `tests/remediationPostdeploy.mjs`
  - checks `/api/health` first and requires `remediation.contractVersion=2026-05-16-agent-contract-stack-v1`;
  - refuses to run production live scripts when the marker is missing or mismatched;
  - requires `ADMIN_PASSWORD` or `ADMIN_API_KEY` before metadata-audited production live checks;
  - runs `npm run test:live:production` and `npm run test:live:production:876` only after marker and admin-token readiness pass;
  - writes `local-live-tests/remediation-postdeploy.json`.

Behavior after fix:

- Production live validation cannot accidentally pass against the old Railway deployment.
- The postdeploy artifact records whether verification stopped at marker, admin-token, live-gate start, or completion.

### P1: one-command Railway remediation deploy workflow

Problem found:

The final deploy flow still required remembering the correct sequence manually: Railway status, predeploy gate, Railway deploy, postdeploy marker check, and production live checks. A missing step could produce weak evidence or run live tests against the wrong build.

Changed:

- `package.json`
  - adds `npm run deploy:remediation:railway`.
- `tests/remediationRailwayDeploy.mjs`
  - checks Railway status first and classifies Railway auth/network/link failures;
  - runs `npm run test:remediation:predeploy` before deployment;
  - runs `railway up --detach --message "agent-contract-stack-v1 remediation"`;
  - runs `npm run test:remediation:postdeploy` after deployment;
  - writes `local-live-tests/remediation-railway-deploy.json`.

Behavior after fix:

- Once Railway CLI is usable, one command executes the full local-predeploy -> deploy -> postdeploy-live verification path.
- In the current environment it stops before deploy and records the Railway blocker instead of partially deploying or running weak checks.

## Verification

Passed:

- Completion audit report created: `docs/reports/2026-05-16-remediation-completion-audit.md`.
- `npm test -- --run tests/agenticCycle876.test.ts tests/agentTurnContract.test.ts tests/recommendationRanking.test.ts tests/turnContract.test.ts`
- `npm test -- --run tests/chatStream.test.ts tests/agenticCycle876.test.ts tests/agentTurnContract.test.ts tests/turnContract.test.ts`
- `npm test -- --run tests/cardManifest.test.ts tests/executionContract.test.ts tests/agenticCycle876.test.ts tests/agentTurnContract.test.ts tests/chatStream.test.ts tests/turnContract.test.ts`
- `npm test -- --run tests/requirementLedger.test.ts tests/factClaimPlanner.test.ts tests/leadStateMachine.test.ts tests/cardManifest.test.ts tests/executionContract.test.ts`
- `npm test -- --run tests/postAnswerVerifier.test.ts tests/factClaimPlanner.test.ts tests/leadStateMachine.test.ts tests/cardManifest.test.ts tests/agentRuntimeContractsEval.test.ts`
- `npm test -- --run tests/postAnswerVerifier.test.ts tests/factClaimPlanner.test.ts tests/agentRuntimeContractsEval.test.ts`
- `npm test -- --run tests/factClaimPlanner.test.ts tests/postAnswerVerifier.test.ts tests/agentRuntimeContractsEval.test.ts`
- `npm test -- --run tests/cardManifest.test.ts tests/factClaimPlanner.test.ts tests/postAnswerVerifier.test.ts tests/agentRuntimeContractsEval.test.ts`
- `npm run test:eval:agentic` - 4 files, 200 tests passed
- `npm test` - 26 files, 285 tests passed
- `npm run typecheck`
- `npm run build`
- `npm run typecheck` after admin observability update
- `npm run build` after admin observability update
- `npm test` after admin observability update - 26 files, 285 tests passed
- `npm run test:eval:agentic` after admin observability update - 4 files, 200 tests passed
- Playwright local admin render check at `http://127.0.0.1:5173/admin` after admin observability update - admin shell rendered, no browser console errors
- `node --check tests/liveAgentCycle.production.mjs`
- `node --check tests/liveAgentCycle.876.production.mjs`
- `node --check tests/liveAgentCycle.diverse.production.mjs`
- `node --check tests/liveAgentCycle.local-llm-full.mjs`
- `node --check tests/liveAgentCycle.production.mjs` after production watchdog update
- `node --check tests/liveAgentCycle.876.production.mjs` after production watchdog update
- `npm run typecheck` after production watchdog update

Production check attempted:

- `npm run test:live:production` against `https://bakautprof.ru/` with the default external command timeout did not finish before the shell killed it.
- Re-run with `LIVE_AGENT_GLOBAL_TIMEOUT_MS=90000` verified the new watchdog behavior: the script failed intentionally and wrote `local-live-tests/production-agent-cycle-failure.json`.
- Current production failure artifact shows the live widget answered the first turn, then the script exceeded the watchdog before completing the full cycle. This is evidence about the current deployed Railway build, not proof that the local remediation is deployed.
- `npm run test:remediation:predeploy` - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 285 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local live scripts passed `node --check`.
- `npm run test:live:local:llm` was attempted after starting Docker Desktop, `chat_ai_postgres`, migrations, and local backend on `http://127.0.0.1:3022`.
  - The test did not pass because OpenAI returned `403 unsupported_country_region_territory`.
  - The updated failure artifact now records `sessionId`, DB `conversation_turns`, and `infrastructureBlocker`.
  - Artifact: `local-live-tests/local-full-agent-cycle-llm.failure.json`.
- `npm run test:remediation:predeploy` after local live diagnostic update - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 285 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local live scripts passed `node --check`.
- `npm run test:remediation:predeploy` after adding production build to the gate - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 285 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local live scripts passed `node --check`.
- `npm run test:remediation:external-readiness` - FAIL by design while blockers exist; artifact written:
  - `local-live-tests/remediation-external-readiness.json`;
  - Docker daemon: pass;
  - Railway production health: pass (`/api/health` returned 200);
  - Railway CLI: failed with Railway GraphQL timeout in the latest run;
  - PostgreSQL: unavailable because the local container was stopped after the live attempt;
  - OpenAI API: failed with `403 unsupported_country_region_territory`.
- `npm run test:remediation:predeploy` after adding external readiness diagnostics - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 285 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local live scripts passed `node --check`.
- `node --check tests/liveAgentCycle.local-llm-full.mjs` after fallback-text guard update
- `node --check tests/liveAgentCycle.production.mjs` after fallback-text guard update
- `node --check tests/liveAgentCycle.876.production.mjs` after fallback-text guard update
- `npm run test:remediation:predeploy` after fallback-text guard update - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 285 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local live scripts passed `node --check`.
- `npm run test:remediation:external-readiness` after Railway classification update - FAIL by design while blockers exist:
  - artifact: `local-live-tests/remediation-external-readiness.json`;
  - Railway CLI blocker is now classified as `railway_network` in the latest run;
  - Docker daemon: pass;
  - Railway production health: pass;
  - PostgreSQL: unavailable because the local container is stopped;
  - OpenAI API: failed with `403 unsupported_country_region_territory`.
- `npm run test:remediation:predeploy` after Railway classification update - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 285 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local live scripts passed `node --check`.
- `npm test -- --run tests/app.test.ts` after health remediation marker update - PASS, 2 tests.
- `node --check tests/remediationExternalReadiness.mjs` after health remediation marker update.
- `npm run test:remediation:external-readiness` after health remediation marker update - FAIL by design while blockers exist:
  - Railway CLI: pass in this run;
  - Docker daemon: pass;
  - PostgreSQL: unavailable because the local container is stopped;
  - OpenAI API: failed with `403 unsupported_country_region_territory`;
  - production health: `200 OK` but failed readiness with `production_remediation_marker_mismatch`;
  - expected marker: `2026-05-16-agent-contract-stack-v1`;
  - actual production marker: `null`.
- `npm run test:remediation:predeploy` after health remediation marker update - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 285 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local live scripts passed `node --check`.
- `node --check tests/remediationPostdeploy.mjs`.
- `npm run test:remediation:postdeploy` - FAIL by design on current old production marker:
  - artifact: `local-live-tests/remediation-postdeploy.json`;
  - stage: `production_marker`;
  - expected marker: `2026-05-16-agent-contract-stack-v1`;
  - actual marker: `null`;
  - production `/api/health` returned 200 but without remediation marker.
- `npm run test:remediation:predeploy` after postdeploy command update - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 285 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local live scripts passed `node --check`.
- `node --check tests/remediationRailwayDeploy.mjs`.
- `npm run deploy:remediation:railway` - FAIL before deploy by design while Railway is inaccessible:
  - artifact: `local-live-tests/remediation-railway-deploy.json`;
  - stage: `railway_status`;
  - Railway class: `railway_network`;
  - stderr included Railway response decode timeout.
- `npm run test:remediation:predeploy` after deploy workflow update - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 285 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local live scripts passed `node --check`.
- `npm run test:remediation:predeploy` after adding orchestration script syntax checks - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 285 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local live scripts passed `node --check`;
  - external readiness, postdeploy, and Railway deploy orchestration scripts passed `node --check`.
- `node --check tests/remediationProductionMarker.mjs`.
- `node --check tests/remediationPostdeploy.mjs`.
- `node --check tests/liveAgentCycle.production.mjs`.
- `node --check tests/liveAgentCycle.876.production.mjs`.
- `npm run test:remediation:predeploy` after adding marker enforcement to direct production live scripts - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 285 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local/remediation scripts passed `node --check`.
- `npm run test:live:production` against current old production now fails fast with `ProductionRemediationMarkerError`:
  - expected marker: `2026-05-16-agent-contract-stack-v1`;
  - actual marker: `null`;
  - browser live scenario was not started against the old deployment.
- `node --check tests/liveAgentCycle.diverse.production.mjs` after adding direct marker enforcement.
- `npm run test:remediation:predeploy` after adding diverse production marker enforcement - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 285 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local/remediation scripts passed `node --check`.
- `node tests/liveAgentCycle.diverse.production.mjs` against current old production now fails fast with `ProductionRemediationMarkerError`:
  - expected marker: `2026-05-16-agent-contract-stack-v1`;
  - actual marker: `null`;
  - diverse browser scenario was not started against the old deployment.
- `node --check tests/remediationExternalReadiness.mjs` after runtime artifact marker update.
- `node --check tests/remediationProductionMarker.mjs` after runtime artifact marker update.
- `node --check tests/remediationPostdeploy.mjs` after runtime artifact marker update.
- `npm test -- --run tests/app.test.ts` after runtime artifact marker update - PASS, 2 tests.
- `npm run test:remediation:external-readiness` after runtime artifact marker update - FAIL by design while blockers exist:
  - Railway CLI: `railway_network` in this run;
  - PostgreSQL: unavailable because the local container is stopped;
  - OpenAI API: failed with `403 unsupported_country_region_territory`;
  - production health: `200 OK` but failed readiness with `production_remediation_marker_mismatch`;
  - actual runtime artifacts: `[]`;
  - missing runtime artifacts: `executionContract`, `requirementLedger`, `cardManifest`, `factClaimPlanner`, `factClaimAudit`, `leadStateMachine`, `postAnswerVerification`.
- `npm run test:remediation:predeploy` after runtime artifact marker update - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 285 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local/remediation scripts passed `node --check`.
- `npm run test:remediation:external-readiness` on 2026-05-16 16:35 MSK - FAIL by design while blockers exist:
  - Railway CLI: scripted readiness hit Railway response decode timeout;
  - direct `railway status` in a separate run showed `invalid_grant`, so Railway OAuth login may need refresh;
  - PostgreSQL: unavailable because the local container is stopped;
  - OpenAI API: failed with `403 unsupported_country_region_territory`;
  - production health: `200 OK` but still failed readiness with `production_remediation_marker_mismatch`;
  - actual runtime artifacts: `[]`;
  - missing runtime artifacts: `executionContract`, `requirementLedger`, `cardManifest`, `factClaimPlanner`, `factClaimAudit`, `leadStateMachine`, `postAnswerVerification`.
- `npm run deploy:remediation:railway` on 2026-05-16 16:36 MSK - FAIL before deploy:
  - artifact: `local-live-tests/remediation-railway-deploy.json`;
  - stage: `railway_status`;
  - Railway class: `railway_network`;
  - no deployment was started.
- `npm run test:remediation:predeploy` on 2026-05-16 16:37 MSK - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 285 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local/remediation scripts passed `node --check`.
- Added post-answer recovery classification:
  - `src/ai/postAnswerVerifier.ts` now exposes `classifyPostAnswerRecovery`;
  - `PostAnswerVerificationRecovery` metadata now records `method`, `repairableIssues`, `unrecoverableIssues`, and `reason`;
  - deterministic repair is limited to recoverable text-only policy errors;
  - current-lineup claims without web policy and hard-constraint card violations remain unrecoverable until regenerated or grounded with the proper tooling.
- `npm test -- --run tests/postAnswerVerifier.test.ts tests/agentRuntimeContractsEval.test.ts` - PASS:
  - 2 files / 11 tests.
- `npm run typecheck` - PASS.
- Added Railway retry handling:
  - `tests/remediationRailwayDeploy.mjs` retries `railway status` and `railway up` only for `railway_network`;
  - `tests/remediationExternalReadiness.mjs` retries `railway status` only for `railway_network`;
  - auth/project-link errors still fail immediately.
- `npm run test:remediation:predeploy` on 2026-05-16 16:50 MSK - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 287 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local/remediation scripts passed `node --check`.
- `npm run deploy:remediation:railway` on 2026-05-16 16:51-16:55 MSK - FAIL at Railway upload:
  - Railway status passed on attempt 3/3;
  - deploy workflow local predeploy passed;
  - `railway up` reached `Indexing...` and `Uploading...`;
  - both upload attempts failed with Railway network disconnect (`os error 10054`);
  - artifact: `local-live-tests/remediation-railway-deploy.json`;
  - stage: `railway_deploy`.
- `npm run test:remediation:postdeploy` after the upload failure - FAIL by design:
  - artifact: `local-live-tests/remediation-postdeploy.json`;
  - stage: `production_marker`;
  - expected marker: `2026-05-16-agent-contract-stack-v1`;
  - actual marker: `null`;
  - missing runtime artifacts: `executionContract`, `requirementLedger`, `cardManifest`, `factClaimPlanner`, `factClaimAudit`, `leadStateMachine`, `postAnswerVerification`.
- `npm run test:remediation:predeploy` on 2026-05-16 16:58 MSK - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 287 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local/remediation scripts passed `node --check`.
- Fixed `tests/remediationProductionMarker.mjs` details payload:
  - marker mismatch now reports `actualRemediationRuntimeArtifacts` correctly instead of throwing a `ReferenceError`.
- `npm run test:remediation:postdeploy` after marker-helper fix - FAIL by design on current old production:
  - stage: `production_marker`;
  - actual marker: `null`;
  - missing runtime artifacts: `executionContract`, `requirementLedger`, `cardManifest`, `factClaimPlanner`, `factClaimAudit`, `leadStateMachine`, `postAnswerVerification`.
- `npm run test:remediation:predeploy` on 2026-05-16 17:00 MSK - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 287 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local/remediation scripts passed `node --check`.
- Added explicit deploy-context exclusions:
  - `.railwayignore` excludes `.git`, `node_modules`, `dist`, local logs, `local-live-tests`, `tmp-live-logs`, `data`, scratch scripts, docs, tests, and secret env files from Railway upload;
  - `.dockerignore` was aligned with the same production context so Docker build does not receive local artifacts that are not needed for `npm run build` or runtime.
- `npm run test:remediation:predeploy` after `.railwayignore` - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 287 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local/remediation scripts passed `node --check`.
- `npm run deploy:remediation:railway` after `.railwayignore` - FAIL before deploy:
  - artifact: `local-live-tests/remediation-railway-deploy.json`;
  - stage: `railway_status`;
  - all three Railway status attempts failed with Railway response decode timeout;
  - no deployment was started in that run.
- `npm run test:remediation:postdeploy` after the failed status run - FAIL by design:
  - production marker is still `null`;
  - all expected runtime artifacts are missing from `/api/health`.
- `npm run test:remediation:external-readiness` after the failed status run - FAIL:
  - Railway: `railway_network`;
  - PostgreSQL: unavailable because local container is stopped;
  - OpenAI: `403 unsupported_country_region_territory`;
  - production health: `production_remediation_marker_mismatch`.
- `npm run test:remediation:predeploy` after `.dockerignore` alignment - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 287 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local/remediation scripts passed `node --check`.
- Enhanced deploy/readiness diagnostics:
  - `tests/remediationRailwayDeploy.mjs` now records Railway CLI version and estimated deploy context before network operations;
  - deploy context after `.railwayignore`: 68 files, 1.14 MiB estimated source context;
  - largest included file is `src/ai/assistant.ts`;
  - `tests/remediationExternalReadiness.mjs` now checks Railway GraphQL POST separately from `railway status`.
- `npm run test:remediation:predeploy` after deploy diagnostics - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 287 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local/remediation scripts passed `node --check`.
- `npm run deploy:remediation:railway` after deploy diagnostics - FAIL before deploy in that run:
  - Railway CLI version: 4.36.1;
  - deploy context: 68 files / 1.14 MiB;
  - stage: `railway_status`;
  - all three status attempts failed with Railway GraphQL connection reset or response decode timeout.
- Manual direct deploy with `RAILWAY_TOKEN` and explicit Railway IDs was attempted to bypass flaky status:
  - command reached `Indexing...` and `Uploading...`;
  - Railway verbose output reported `bytes: 292919`;
  - upload failed with `os error 10054`;
  - this proves the remaining Railway blocker is not source context size.
- `tests/remediationRailwayDeploy.mjs` now supports `RAILWAY_PROJECT` and uses verbose Railway deploy output by default unless `REMEDIATION_RAILWAY_VERBOSE=0`.
- `npm run test:remediation:predeploy` after `RAILWAY_PROJECT`/verbose support - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 287 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local/remediation scripts passed `node --check`.
- Docker production image proof was added:
  - `package.json` now includes `test:remediation:docker-image`;
  - `tests/remediationDockerImageProof.mjs` builds the Docker image and injects `/api/health` inside the compiled production app;
  - artifact: `local-live-tests/remediation-docker-image-proof.json`.
- Manual Docker build with Railway-equivalent Dockerfile - PASS:
  - image: `chat-ai-remediation:local-proof`;
  - build context was 1.21 MB in the first full build after `.dockerignore`;
  - `RUN npm run build` completed inside Docker;
  - container health injection returned `200` and remediation marker.
- `npm run test:remediation:docker-image` - PASS:
  - actual marker: `2026-05-16-agent-contract-stack-v1`;
  - runtime artifacts present: `executionContract`, `requirementLedger`, `cardManifest`, `factClaimPlanner`, `factClaimAudit`, `leadStateMachine`, `postAnswerVerification`;
  - missing runtime artifacts: none.
- `npm run test:remediation:predeploy` after adding Docker image proof syntax check - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 287 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local/remediation scripts passed `node --check`, including `tests/remediationDockerImageProof.mjs`.
- `npm run test:remediation:external-readiness` after Docker proof - FAIL:
  - Railway: `railway_network`;
  - OpenAI: `403 unsupported_country_region_territory`;
  - production health: `production_remediation_marker_mismatch`;
  - PostgreSQL was not a blocker in this run.
- `npm run test:remediation:postdeploy` after Docker proof - FAIL by design:
  - production marker remains `null`;
  - all expected runtime artifacts are absent on current Railway production.
- Added skip-status Railway deploy mode:
  - `tests/remediationRailwayDeploy.mjs` now honors `REMEDIATION_SKIP_RAILWAY_STATUS=1`;
  - this mode is for cases where readiness already proved GraphQL/auth, but `railway status` is flaky.
- `npm run deploy:remediation:railway` with `REMEDIATION_SKIP_RAILWAY_STATUS=1` and explicit `RAILWAY_PROJECT`, `RAILWAY_ENVIRONMENT`, `RAILWAY_SERVICE` - FAIL at upload:
  - `railwayStatus` was intentionally skipped in the artifact;
  - internal local predeploy passed again: 26 files / 287 tests and 4 files / 200 agentic eval tests;
  - deploy context: 68 files / 1.14 MiB;
  - Railway verbose upload size: `bytes: 292980`;
  - both deploy attempts reached `Indexing...` / `Uploading...`;
  - both deploy attempts failed with Railway upload connection reset (`os error 10054`);
  - artifact: `local-live-tests/remediation-railway-deploy.json`;
  - `npm run test:remediation:postdeploy` after this attempt still reports production marker `null` and all runtime artifacts missing.
- Added executable completion audit:
  - `package.json` now includes `test:remediation:completion-audit`;
  - `tests/remediationPredeploy.mjs` now writes `local-live-tests/remediation-predeploy.json` on pass/fail;
  - `tests/remediationCompletionAudit.mjs` aggregates backup, predeploy, Docker image marker, Railway deploy, external readiness, postdeploy, production marker, and fresh production live protocol evidence.
- `npm run test:remediation:predeploy` after completion-audit wiring - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 287 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local/remediation scripts passed `node --check`, including `tests/remediationCompletionAudit.mjs`.
- `npm run test:remediation:completion-audit` - FAIL by design:
  - proven: backup exists, backup metadata exists, predeploy gate passed, Docker image marker passed;
  - missing/failed: Railway deploy completed, external readiness passed, postdeploy live gates passed, fresh 2026-05-16 production live protocol exists, production marker has runtime artifacts;
  - artifact: `local-live-tests/remediation-completion-audit.json`.
- Fixed future production-live protocol evidence:
  - `tests/liveAgentCycle.876.production.mjs` now writes a dated protocol path for the current run instead of the old fixed `2026-05-12...` path;
  - `tests/remediationPostdeploy.mjs` now stores `actualRemediationRuntimeArtifacts` in successful postdeploy artifacts;
  - `tests/remediationCompletionAudit.mjs` now uses `REMEDIATION_COMPLETION_DATE` or the current date for fresh protocol checks instead of a hardcoded date.
- `npm run test:remediation:predeploy` after protocol/completion-audit updates - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 287 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local/remediation scripts passed `node --check`.
- `npm run test:remediation:completion-audit` after the update - FAIL by design on the same true external gaps:
  - Railway deploy completion is not proven;
  - external readiness is not passing;
  - postdeploy live gates are not passing;
  - fresh production live protocol does not exist for this build;
  - production marker does not expose the runtime artifacts.
- Added deployment runbook:
  - `docs/reports/2026-05-16-remediation-deployment-runbook.md`;
  - documents primary Railway deploy, skip-status deploy, GitHub/Railway fallback, manual production verification, and the final completion rule;
  - explicitly states that `npm run test:remediation:completion-audit` must return `ok=true` before the goal can be closed.
- Added postdeploy marker polling:
  - `tests/remediationPostdeploy.mjs` now waits for production marker before failing;
  - defaults: `REMEDIATION_MARKER_WAIT_MS=600000`, `REMEDIATION_MARKER_POLL_MS=15000`;
  - failure artifacts now include `markerAttempts`, each attempt's actual marker, runtime artifacts, missing artifacts, and health body.
- `npm run test:remediation:postdeploy` with short marker wait (`5000ms`) - FAIL by design:
  - artifact: `local-live-tests/remediation-postdeploy.json`;
  - stage: `production_marker`;
  - marker attempts recorded: 5;
  - all attempts still returned marker `null` and missing runtime artifacts.
- `npm run test:remediation:predeploy` after postdeploy polling - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 287 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - `npm run build` passed;
  - production/local/remediation scripts passed `node --check`.
- `npm run test:remediation:completion-audit` after postdeploy polling - FAIL by design on the same true external gaps.
- Runtime dependency security follow-up:
  - `npm audit --omit=dev --json` found one high-severity production vulnerability in transitive `fast-uri@3.1.0`;
  - advisory classes: path traversal via percent-encoded dot segments and host confusion via percent-encoded authority delimiters;
  - dependency path: `fastify -> @fastify/ajv-compiler/ajv/fast-json-stringify -> fast-uri`;
  - `npm audit fix --omit=dev` updated `package-lock.json` from `fast-uri@3.1.0` to `fast-uri@3.1.2`;
  - `npm install` restored local dev dependencies after the omit-dev audit fix pruned `node_modules`;
  - `npm audit --omit=dev` and full `npm install` now report `found 0 vulnerabilities`.
- Verification after the dependency fix:
  - `npm run test:remediation:predeploy` - PASS:
    - typecheck passed;
    - `npm test` passed, 26 files / 287 tests;
    - `npm run test:eval:agentic` passed, 4 files / 200 tests;
    - `npm run build` passed;
    - live/remediation script syntax checks passed.
  - `npm run test:remediation:docker-image` - PASS:
    - Docker `npm ci --omit=dev` reported `found 0 vulnerabilities`;
    - Docker `npm ci` reported `found 0 vulnerabilities`;
    - production image health marker returned `2026-05-16-agent-contract-stack-v1`;
    - missing runtime artifacts: none.
  - `npm run test:remediation:completion-audit` - FAIL by design only on required external evidence:
    - `railway_deploy_completed`;
    - `external_readiness_passed`;
    - `postdeploy_live_gates_passed`;
    - `fresh_production_live_protocol_exists`;
    - `production_marker_has_runtime_artifacts`.
- Latest external/deploy attempt after the dependency fix:
  - `npm run test:remediation:external-readiness` - FAIL:
    - Railway CLI/GraphQL, Docker, and PostgreSQL were not blockers in this run;
    - remaining blockers were OpenAI provider access (`403 unsupported_country_region_territory`) and production marker mismatch on the old Railway build.
  - `npm run deploy:remediation:railway` with explicit Railway IDs and `REMEDIATION_SKIP_RAILWAY_STATUS=1` - FAIL at upload:
    - local predeploy passed inside the deploy workflow;
    - upload reached `Indexing...` / `Uploading...` twice;
    - Railway verbose upload size: `bytes: 293398`;
    - both attempts failed with Railway network disconnect (`os error 10054`);
    - artifact: `local-live-tests/remediation-railway-deploy.json`.
  - Added deploy-mode support to `tests/remediationRailwayDeploy.mjs`:
    - `REMEDIATION_RAILWAY_MODE=detach|ci|json`;
    - `REMEDIATION_RAILWAY_PATH`;
    - `REMEDIATION_RAILWAY_PATH_AS_ROOT=1`;
    - the selected mode/path are stored in `local-live-tests/remediation-railway-deploy.json`.
  - `npm run deploy:remediation:railway` with `REMEDIATION_RAILWAY_MODE=ci`, explicit Railway IDs, and `REMEDIATION_SKIP_RAILWAY_STATUS=1` - FAIL at the same upload phase:
    - local predeploy passed again;
    - upload reached `Indexing...` / `Uploading...` twice;
    - Railway verbose upload size: `bytes: 293398`;
    - both attempts failed with `os error 10054`;
    - this shows detached vs CI mode is not the cause; the failure happens before Railway build logs can start.
  - `npm run deploy:remediation:railway` with `REMEDIATION_RAILWAY_MODE=json`, explicit Railway IDs, and `REMEDIATION_SKIP_RAILWAY_STATUS=1` - FAIL at the same upload phase:
    - local predeploy passed again;
    - Railway reported the same upload context size: `bytes: 293398`;
    - both attempts failed with `os error 10054`;
    - artifact now records `deploymentMode: json`;
    - this shows all tested official `railway up` output modes (`detach`, `ci`, `json`) hit the same transport failure.
  - `npm run test:remediation:completion-audit` after this attempt - FAIL by design on the same required external evidence.
- Added Railway GitHub-source diagnostic:
  - `tests/remediationRailwaySourceReadiness.mjs` queries Railway GraphQL for service source, deployment triggers, and auto-deploy status without exposing tokens;
  - `package.json` now includes `test:remediation:railway-source`;
  - `tests/remediationPredeploy.mjs` now syntax-checks the source diagnostic script;
  - `tests/remediationCompletionAudit.mjs` now includes optional diagnostic check `railway_github_source_known`.
- `npm run test:remediation:railway-source` - FAIL as diagnostic evidence:
  - current `RAILWAY_TOKEN` can reach GraphQL, but service/source fields return `Not Authorized`;
  - artifact: `local-live-tests/remediation-railway-source-readiness.json`;
  - class: `railway_auth_or_scope`;
  - conclusion: GitHub autodeploy fallback branch/source cannot be safely proven with the current token/session.
- `npm run test:remediation:predeploy` after adding the source diagnostic - PASS:
  - typecheck passed;
  - `npm test` passed, 26 files / 287 tests;
  - `npm run test:eval:agentic` passed, 4 files / 200 tests;
  - production build passed;
  - live/remediation script syntax checks passed, including `tests/remediationRailwaySourceReadiness.mjs`.
- `npm run test:remediation:completion-audit` after adding the optional source diagnostic - FAIL by design on the same required external evidence:
  - `railway_deploy_completed`;
  - `external_readiness_passed`;
  - `postdeploy_live_gates_passed`;
  - `fresh_production_live_protocol_exists`;
  - `production_marker_has_runtime_artifacts`.

Not yet validated:

- Live widget on `https://bakautprof.ru/` after these changes, because the local bundle has not been deployed to Railway in this session.
- Production health remediation marker, because current Railway production still returns no `remediation.contractVersion`; external readiness reports `production_remediation_marker_mismatch`.
- Railway deploy/status from this machine, because Railway CLI access is not stable enough to prove deploy readiness here:
  - earlier `railway status` returned `invalid_grant`;
  - the latest external-readiness run reached the CLI but failed against Railway GraphQL with a timeout.
- Local full-agent LLM live test against `http://localhost:3022/widget`, because the local OpenAI API call is blocked by provider access:
  - Docker Desktop, PostgreSQL, migrations, and backend startup were successfully recovered after the earlier DB blocker;
  - the current blocker is `403 unsupported_country_region_territory` from OpenAI;
  - `local-live-tests/local-full-agent-cycle-llm.failure.json` now contains the infrastructure classification and DB turn evidence.

## Remaining high-value steps

1. Refresh Railway auth (`railway login`) or deploy through the configured GitHub/Railway path, then run `npm run test:live:production` and `npm run test:live:production:876`.
2. Extend recovery beyond deterministic text repair into a single constrained LLM rewrite when deterministic repair cannot clear safe text-only verification errors.
3. Expand `FactClaimAudit` from deterministic extraction into optional LLM claim review for ambiguous factual paragraphs.
4. Split `src/ai/assistant.ts` monolith into orchestration modules only after the new contracts are stable in production traces.

## 2026-05-17 continuation: production live blocker

- Current GitHub/Railway production marker reached `2026-05-16-agent-contract-stack-v20` with all expected remediation runtime artifacts exposed by `/api/health`.
- `npm run test:live:production` still fails on the first real widget turn through `https://bakautprof.ru/`.
- The failure is now proven from production admin metadata, not inferred from the UI:
  - failure artifact: `local-live-tests/production-agent-cycle-failure.json`;
  - captured session: `374a2f6d-48f4-4674-89d6-5ed6aad43784`;
  - captured turn: `19fbfb13-4735-4a89-bf5d-38bbc8f19a85`;
  - turn stage: `recovery_failed`;
  - turn error: `AI answer recovery failed: insufficient_quota`;
  - `plannerContract`: `null`;
  - assistant message: not created.
- This means the current blocker is OpenAI quota/billing on the production Railway environment. It is not a catalog ranking, card manifest, lead-state, or ExecutionContract bug.
- The live harness was hardened so future first-turn failures save `sessionId` and admin conversation detail immediately instead of producing `sessionId: null`.
- Required next action outside code: restore OpenAI quota/credits or replace the Railway OpenAI credential with a project key that has quota. After that, rerun:
  - `npm run test:remediation:postdeploy`;
  - `npm run test:remediation:external-readiness`;
  - `npm run test:remediation:completion-audit`.
- Follow-up gates after hardening the audit evidence:
  - `npm run test:remediation:docker-image` - PASS with marker `2026-05-16-agent-contract-stack-v20` and all expected runtime artifacts;
  - `npm run test:remediation:external-readiness` - PASS with no blockers;
  - `npm run test:remediation:predeploy` - PASS after the completion-audit script correction;
  - `npm run test:remediation:completion-audit` - FAIL by design on the single remaining required item: `postdeploy_live_gates_passed`.
- `tests/remediationCompletionAudit.mjs` now evaluates deployment/marker evidence separately from live-dialog success:
  - production marker/runtime artifacts are proven when `remediation-postdeploy.json` contains the expected marker and runtime artifacts, even if live gates fail later;
  - GitHub/Railway deployment is accepted when the production marker proves the expected runtime is live;
  - live behavior remains a separate hard requirement and is still blocked by production OpenAI quota.
