# Remediation Completion Audit

Date: 2026-05-16
Project: `C:\Projects\chatAI`
Goal: backup current project state, then execute the audit remediation plan: P0 constraints and live/recovery stabilization, then `ExecutionContract`, `RequirementLedger`, `CardManifest`, `FactClaimPlanner`, `LeadStateMachine`, observability, and eval suite checks.

## Status summary

Overall status: not complete.

Local remediation implementation and local predeploy gates are complete enough to deploy. Final completion is blocked by production deployment and live verification evidence:

- current Railway production does not expose `remediation.contractVersion`;
- current local OpenAI API calls fail with `403 unsupported_country_region_territory`;
- Railway CLI access has been unstable (`invalid_grant` and Railway network/timeouts in separate runs);
- `bakautprof.ru` live widget validation has not passed after deploying this local remediation build.

## Requirement evidence

### 1. Backup current project state

Status: proven.

Evidence:

- Backup path exists: `C:\Projects\chatAI-backups\chatAI-backup-20260516-141548`.
- Backup metadata exists in that backup directory.

Residual risk:

- The backup is filesystem-level evidence, not a git tag or remote snapshot. It is still sufficient for rollback to the pre-remediation local state.

### 2. P0 constraints stabilization

Status: locally implemented and test-covered.

Evidence:

- `src/ai/assistant.ts`
  - planner selection contract now preserves user/previous-selection constraints when applying planner-derived criteria.
  - visible product cards with hard-constraint violations are suppressed before final answer generation.
- `tests/agentTurnContract.test.ts`
- `tests/agenticCycle876.test.ts`
- `tests/recommendationRanking.test.ts`
- `tests/cardManifest.test.ts`

Verification:

- `npm run test:remediation:predeploy` passed after these changes.
- `npm run test:eval:agentic` passed: 4 files / 200 tests.

Missing evidence:

- Production live proof after Railway deploy.

### 3. P0 live/recovery stabilization

Status: locally implemented and guarded; production proof missing.

Evidence:

- `src/client/main.tsx`
  - client-side turn watchdog aborts a hanging turn after `CHAT_TURN_TIMEOUT_MS`.
- `tests/liveAgentCycle.production.mjs`
- `tests/liveAgentCycle.876.production.mjs`
- `tests/liveAgentCycle.diverse.production.mjs`
  - live scripts now enforce remediation marker before browser scenario;
  - global watchdogs write failure artifacts instead of relying on external command timeouts;
  - buyer-facing fallback text is treated as a critical failure.
- `tests/liveAgentCycle.local-llm-full.mjs`
  - captures DB diagnostics and classifies OpenAI provider blockers.

Verification:

- Direct production live scripts fail fast with `ProductionRemediationMarkerError` against current old production.
- `node --check` for all live scripts passes through `npm run test:remediation:predeploy`.

Missing evidence:

- Successful post-deploy live scenario through `https://bakautprof.ru/`.

### 4. ExecutionContract

Status: implemented and test-covered.

Evidence:

- `src/shared/types.ts`
- `src/ai/executionContract.ts`
- `src/ai/assistant.ts`
- `tests/executionContract.test.ts`
- `tests/agentRuntimeContractsEval.test.ts`

Behavior now expected:

- Each assistant turn can expose catalog policy, cards policy, lead policy, fact policy, active constraints, postconditions, and warnings.

Verification:

- `npm run test:remediation:predeploy` passed.

### 5. RequirementLedger

Status: implemented and test-covered.

Evidence:

- `src/shared/types.ts`
- `src/ai/requirementLedger.ts`
- `src/ai/assistant.ts`
- `tests/requirementLedger.test.ts`

Behavior now expected:

- Active requirements, hard constraints, primary requirement IDs, alternative mode, and warning state are persisted in metadata.

Verification:

- `npm run test:remediation:predeploy` passed.

### 6. CardManifest

Status: implemented and test-covered.

Evidence:

- `src/shared/types.ts`
- `src/ai/cardManifest.ts`
- `src/ai/assistant.ts`
- `tests/cardManifest.test.ts`

Behavior now expected:

- Product cards have visible/hidden state, role, rank, and hard-constraint status.
- Visible hard-constraint violations are blocked from being treated as recommendations.

Verification:

- `npm run test:remediation:predeploy` passed.

### 7. FactClaimPlanner and FactClaimAudit

Status: implemented and test-covered.

Evidence:

- `src/shared/types.ts`
- `src/ai/factClaimPlanner.ts`
- `src/ai/postAnswerVerifier.ts`
- `src/ai/assistant.ts`
- `tests/factClaimPlanner.test.ts`
- `tests/postAnswerVerifier.test.ts`

Behavior now expected:

- Answers are audited for product references, prices, availability, delivery, discounts/terms, technical specs, and current-lineup claims.
- Ungrounded commercial/current-lineup findings feed final post-answer verification.

Verification:

- `npm run test:remediation:predeploy` passed.

### 8. LeadStateMachine

Status: implemented and test-covered.

Evidence:

- `src/shared/types.ts`
- `src/ai/leadStateMachine.ts`
- `src/ai/assistant.ts`
- `tests/leadStateMachine.test.ts`

Behavior now expected:

- Lead behavior is represented as state and next action instead of scattered boolean pressure.
- Contact refusal and forbidden lead policy are explicitly represented.

Verification:

- `npm run test:remediation:predeploy` passed.

### 9. PostAnswerVerification

Status: implemented and test-covered.

Evidence:

- `src/shared/types.ts`
- `src/ai/postAnswerVerifier.ts`
- `src/ai/assistant.ts`
- `tests/postAnswerVerifier.test.ts`
- live scripts fail on `postAnswerVerification.status=error`.

Behavior now expected:

- Final buyer-facing text is checked after answer repairs.
- Recoverable text-only violations are repaired before persistence.
- Unrecoverable violations remain visible to metadata and live/eval gates.
- Recovery metadata now separates `repairableIssues` from `unrecoverableIssues`; unsafe errors such as current-lineup claims without web policy and hard-constraint card violations are not marked as recoverable by deterministic text repair.

Verification:

- `npm run test:remediation:predeploy` passed.

### 10. Observability

Status: implemented locally.

Evidence:

- `src/client/main.tsx`
  - admin message flags now show compact runtime diagnostics for execution, requirements, cards, fact claims, lead state, post-answer verification, and warning counts.
- `src/app.ts`
  - `/api/health` exposes remediation marker and runtime artifact names.
- `tests/app.test.ts`

Verification:

- `npm test -- --run tests/app.test.ts` passed.
- Playwright local admin render check was performed and recorded in `docs/reports/2026-05-16-remediation-execution-log.md`.

Missing evidence:

- Admin UI on deployed Railway build after marker update.

### 11. Eval suite and gates

Status: implemented and passing locally.

Evidence:

- `package.json`
  - `test:eval:agentic`
  - `test:remediation:predeploy`
  - `test:remediation:external-readiness`
  - `test:remediation:postdeploy`
  - `deploy:remediation:railway`
  - `test:live:local:llm`
  - `test:live:production`
  - `test:live:production:876`
- `tests/remediationPredeploy.mjs`
- `tests/remediationExternalReadiness.mjs`
- `tests/remediationProductionMarker.mjs`
- `tests/remediationPostdeploy.mjs`
- `tests/remediationRailwayDeploy.mjs`
- production live scripts require remediation marker before long browser execution.

Latest strong local gate:

- `npm run test:remediation:predeploy` passed.
- It includes:
  - typecheck;
  - full Vitest suite;
  - agentic eval suite;
  - production build;
  - syntax checks for live and remediation orchestration scripts.

### 12. Production deployment and live validation

Status: blocked.

Evidence:

- Current production health returns `200` but no remediation marker.
- `local-live-tests/remediation-postdeploy.json`
  - stage: `production_marker`;
  - expected marker: `2026-05-16-agent-contract-stack-v1`;
  - actual marker: `null`.
- `local-live-tests/remediation-external-readiness.json`
  - OpenAI local API check: `403 unsupported_country_region_territory`;
  - production marker mismatch on current Railway build;
  - Railway CLI status has alternated between `invalid_grant` and Railway network/timeouts.
- `local-live-tests/remediation-railway-deploy.json`
  - latest one-command deploy workflow passed Railway status after retries and passed local predeploy;
  - deployment reached Railway `Indexing...` / `Uploading...`;
  - upload failed with Railway network disconnect (`os error 10054`), so no completed deployment was proven.

Required evidence before completion:

1. `npm run deploy:remediation:railway` completes, or an equivalent Railway/GitHub deployment updates production to this build.
2. `npm run test:remediation:external-readiness` passes at least for Railway status, production health marker, and OpenAI access in the environment used for live tests.
3. `npm run test:remediation:postdeploy` passes.
4. Live protocol files are saved under `local-live-tests/*.production.md` after the real `bakautprof.ru` widget run.
5. Production admin metadata confirms the new runtime artifacts on assistant turns.

## Current final decision

Do not mark the goal complete.

The implementation, local gates, and deployment verification tooling are in place. The remaining gap is external and evidentiary: current Railway production is still the old build, and production live behavior through `bakautprof.ru` has not been proven after deploying this remediation build.

## Latest execution update

Time: 2026-05-16 18:24 MSK.

Latest local gate:

- `npm run test:remediation:predeploy` - PASS.
- Included checks:
  - TypeScript typecheck;
  - full Vitest suite: 26 files / 287 tests;
  - agentic eval suite: 4 files / 200 tests;
  - production build;
  - syntax checks for production live, local LLM live, readiness, postdeploy, Docker proof, completion audit, marker, and Railway deploy scripts.
- `local-live-tests/remediation-predeploy.json` is now written by the predeploy gate and currently reports `ok=true`.
- `npm run test:remediation:docker-image` - PASS:
  - Docker image `chat-ai-remediation:local-proof` builds with the same Dockerfile Railway uses;
  - Docker `npm ci --omit=dev` reports `found 0 vulnerabilities`;
  - `/api/health` injected inside the compiled production image returns `200`;
  - actual marker: `2026-05-16-agent-contract-stack-v1`;
  - all expected runtime artifacts are present;
  - artifact: `local-live-tests/remediation-docker-image-proof.json`.
- Runtime dependency security follow-up:
  - `npm audit --omit=dev` initially found one high-severity production vulnerability in transitive `fast-uri@3.1.0`;
  - `package-lock.json` now resolves `fast-uri@3.1.2`;
  - `npm audit --omit=dev` now reports zero vulnerabilities;
  - full `npm install` now reports zero vulnerabilities.
- `npm run test:remediation:completion-audit` - FAIL by design and is now the authoritative local completion gate:
  - proven: backup exists, backup metadata exists, predeploy gate passed, Docker image marker passed;
  - not proven: Railway deploy completed, external readiness passed, postdeploy/live gates passed, fresh 2026-05-16 production live protocol exists, production marker has runtime artifacts;
  - artifact: `local-live-tests/remediation-completion-audit.json`.
- Future live protocol evidence was hardened:
  - `tests/liveAgentCycle.876.production.mjs` now writes a current dated protocol path instead of the fixed `2026-05-12...` path;
  - completion audit now uses `REMEDIATION_COMPLETION_DATE` or current date for fresh protocol validation;
  - successful postdeploy artifacts now include `actualRemediationRuntimeArtifacts`, so production marker completion can be verified from the artifact.
- Deployment fallback is documented in `docs/reports/2026-05-16-remediation-deployment-runbook.md`.
- Postdeploy marker verification now polls instead of checking once:
  - default marker wait: 600000 ms;
  - default poll interval: 15000 ms;
  - failure artifacts include `markerAttempts`;
  - a short-window verification on current old production recorded 5 attempts, all with marker `null`.

Latest external/deploy gates:

- `npm run test:remediation:external-readiness` - FAIL.
- Current blockers:
  - Railway CLI remains unstable: status can pass after retries, but scripted readiness/deploy still hit Railway network timeouts;
  - local OpenAI API check still returns `403 unsupported_country_region_territory`;
  - current production `/api/health` still has no remediation marker and no runtime artifact list;
  - local PostgreSQL was not running for the readiness check.
- `npm run deploy:remediation:railway` - FAIL at `railway_deploy`:
  - Railway status can be skipped with `REMEDIATION_SKIP_RAILWAY_STATUS=1` after readiness proves GraphQL/auth;
  - local predeploy passed inside the deploy workflow;
  - deploy context is 68 files / 1.14 MiB;
  - `railway up` reached indexing/uploading;
  - Railway verbose upload size was `bytes: 292980`;
  - both upload attempts failed with Railway network disconnect (`os error 10054`);
  - postdeploy still fails with `actualRemediationContractVersion=null` and all expected runtime artifacts missing.
- `.railwayignore` was added and `.dockerignore` was aligned to exclude local-only artifacts from deploy/build context:
  - `.git`, `node_modules`, `dist`, local logs, `local-live-tests`, `tmp-live-logs`, `data`, scratch scripts, docs, tests, and secret env files.
- After reducing deploy context:
  - `npm run test:remediation:predeploy` - PASS;
  - `npm run deploy:remediation:railway` - FAIL before deploy at `railway_status`, because all three Railway status attempts timed out;
  - `npm run test:remediation:postdeploy` - FAIL by design because production marker remains `null` and all expected runtime artifacts are absent.
- Deploy diagnostics were strengthened:
  - Railway CLI version in current environment: `railway 4.36.1`;
  - estimated deploy context: 68 files / 1.14 MiB;
  - direct verbose `railway up` with `RAILWAY_TOKEN` and explicit project/environment/service IDs reached `Indexing...` and `Uploading...`;
  - Railway verbose output reported only `bytes: 292980`;
  - upload still failed with `os error 10054`;
  - conclusion: remaining Railway blocker is GraphQL/upload connection reset from this environment, not project size.
- Latest deploy artifact was produced by the normal npm deploy workflow with:
  - `REMEDIATION_SKIP_RAILWAY_STATUS=1`;
  - explicit `RAILWAY_PROJECT`, `RAILWAY_ENVIRONMENT`, and `RAILWAY_SERVICE`;
  - the deploy still failed at upload, not at local tests or build.
- External readiness now separates Railway CLI status from Railway GraphQL POST:
  - in the latest readiness artifact, Railway status passed on retry and GraphQL POST returned 200;
  - deploy still failed minutes later, showing the Railway path is flaky rather than consistently unavailable.
- `tests/remediationRailwayDeploy.mjs` now supports `RAILWAY_PROJECT` and verbose deploy output by default.
- `tests/remediationProductionMarker.mjs` was corrected after this attempt so marker mismatch artifacts now report `actualRemediationRuntimeArtifacts` without an internal `ReferenceError`.
- Latest `npm run test:remediation:postdeploy` still fails by design on the current old production marker:
  - actual marker: `null`;
  - missing runtime artifacts: `executionContract`, `requirementLedger`, `cardManifest`, `factClaimPlanner`, `factClaimAudit`, `leadStateMachine`, `postAnswerVerification`.
- Latest `npm run test:remediation:external-readiness` still fails:
  - Railway CLI/GraphQL was not a blocker in the latest run;
  - OpenAI: `403 unsupported_country_region_territory`;
  - production health: `production_remediation_marker_mismatch`;
  - PostgreSQL was not a blocker in the latest captured readiness artifact.
- Latest `npm run deploy:remediation:railway` with explicit Railway IDs and `REMEDIATION_SKIP_RAILWAY_STATUS=1` still fails at upload:
  - local predeploy passed inside the deploy workflow;
  - Railway upload reached `Indexing...` / `Uploading...` twice;
  - Railway verbose upload size: `bytes: 293398`;
  - both attempts failed with Railway network disconnect (`os error 10054`);
  - deploy artifact: `local-live-tests/remediation-railway-deploy.json`.
- `tests/remediationRailwayDeploy.mjs` now supports `REMEDIATION_RAILWAY_MODE=detach|ci|json`, `REMEDIATION_RAILWAY_PATH`, and `REMEDIATION_RAILWAY_PATH_AS_ROOT=1`.
- Latest retry with `REMEDIATION_RAILWAY_MODE=ci` also failed at the same upload phase:
  - local predeploy passed inside the deploy workflow;
  - Railway upload reached `Indexing...` / `Uploading...` twice;
  - Railway verbose upload size: `bytes: 293398`;
  - both attempts failed with Railway network disconnect (`os error 10054`);
  - therefore the blocker is not detached-mode log streaming.
- Latest retry with `REMEDIATION_RAILWAY_MODE=json` also failed at the same upload phase:
  - local predeploy passed inside the deploy workflow;
  - Railway reported the same upload context size: `bytes: 293398`;
  - both attempts failed with Railway network disconnect (`os error 10054`);
  - deploy artifact now records `deploymentMode: json`.
- All tested official `railway up` modes (`detach`, `ci`, `json`) fail before Railway build logs start.
- Latest `npm run test:remediation:completion-audit` still fails by design on:
  - `railway_deploy_completed`;
  - `external_readiness_passed`;
  - `postdeploy_live_gates_passed`;
  - `fresh_production_live_protocol_exists`;
  - `production_marker_has_runtime_artifacts`.
- Railway GitHub-source fallback is now checked by `npm run test:remediation:railway-source`:
  - the current `RAILWAY_TOKEN` reaches GraphQL, but service/source/deployment-trigger fields return `Not Authorized`;
  - artifact: `local-live-tests/remediation-railway-source-readiness.json`;
  - class: `railway_auth_or_scope`;
  - completion audit includes this as optional diagnostic check `railway_github_source_known`, so the final gate records why GitHub autodeploy fallback is not proven without adding a false required blocker.
- Latest `npm run test:remediation:predeploy` after this diagnostic change still passes:
  - 26 Vitest files / 287 tests;
  - 4 agentic eval files / 200 tests;
  - production build;
  - syntax checks including `tests/remediationRailwaySourceReadiness.mjs`.

Operational conclusion:

- The local implementation remains deploy-ready.
- Production cannot be considered remediated until Railway upload/network access is stable enough to complete deployment, `/api/health` exposes `remediation.contractVersion=2026-05-16-agent-contract-stack-v1` with all expected runtime artifacts, and the postdeploy/live widget checks pass.

## External architecture sources used

The remediation design was checked against these current public references:

- OpenAI Agents SDK docs: agents are LLMs configured with instructions, model, tools, structured output, composition patterns, handoffs, sessions, guardrails, and tracing: https://openai.github.io/openai-agents-js/guides/agents/
- OpenAI Agents SDK guardrails docs: final output and tool-level guardrails are separate control points, which matches this project's post-answer verifier and fact/card enforcement: https://openai.github.io/openai-agents-js/guides/guardrails/
- OpenAI Agents SDK tracing docs: production agent runs should preserve LLM/tool/guardrail/handoff traces or equivalent local metadata for debugging: https://openai.github.io/openai-agents-js/guides/tracing/
- OpenAI Responses API web search docs: web search should be used when the model needs up-to-date external facts, with citations visible when web results are shown to users: https://developers.openai.com/api/docs/guides/tools-web-search
- Anthropic "Building effective agents": keep agent design simple and composable; use agents when flexibility and model-driven decisions are needed; rely on ground truth from tools/environment and strong evals/guardrails: https://www.anthropic.com/engineering/building-effective-agents
- Google ADK agents docs: separate LLM agents, workflow agents, and custom deterministic logic by responsibility: https://adk.dev/agents/
- Google ADK callbacks and evaluation docs: production agents need callbacks/inspection points, session state, trajectory/tool-use evaluation, and CI-suitable agent eval criteria: https://adk.dev/callbacks/ and https://adk.dev/evaluate/
- GitHub reference repos reviewed: `openai/openai-agents-js` (https://github.com/openai/openai-agents-js), `openai/openai-agents-python` (https://github.com/openai/openai-agents-python), `google/adk-python` (https://github.com/google/adk-python), and `anthropics/claude-cookbooks` (https://github.com/anthropics/claude-cookbooks).
