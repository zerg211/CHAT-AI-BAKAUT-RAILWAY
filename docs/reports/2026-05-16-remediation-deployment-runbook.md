# Remediation Deployment Runbook

Date: 2026-05-16
Project: `C:\Projects\chatAI`
Required marker: `2026-05-16-agent-contract-stack-v1`

## Current state

Local remediation is ready for deployment, but production is not proven.

Proven locally:

- backup exists: `C:\Projects\chatAI-backups\chatAI-backup-20260516-141548`;
- `npm run test:remediation:predeploy` passes;
- `npm run test:remediation:docker-image` passes;
- `npm audit --omit=dev` passes after updating transitive `fast-uri` from `3.1.0` to `3.1.2` in `package-lock.json`;
- production Docker image exposes `/api/health.remediation.contractVersion=2026-05-16-agent-contract-stack-v1`;
- runtime artifacts in the image: `executionContract`, `requirementLedger`, `cardManifest`, `factClaimPlanner`, `factClaimAudit`, `leadStateMachine`, `postAnswerVerification`.

Not proven:

- Railway production still returns no remediation marker;
- `npm run test:remediation:postdeploy` fails at `production_marker`;
- `npm run test:remediation:completion-audit` fails by design;
- no fresh production live protocol exists for this remediation build.

## Primary deploy path

Use this when Railway CLI transport is healthy.

```powershell
npm run test:remediation:predeploy
npm run test:remediation:docker-image
npm run deploy:remediation:railway
npm run test:remediation:completion-audit
```

Expected result:

- `deploy:remediation:railway` reaches postdeploy;
- production `/api/health` exposes the required marker and all runtime artifacts;
- production live scripts create fresh `local-live-tests/*.production.md`;
- completion audit returns `ok=true`.

Railway reference:

- Railway CLI docs: https://docs.railway.com/reference/cli-api
- `railway up` is the correct command for deploying local project code; Railway documents that it uploads and deploys the current directory, while `railway deploy` is for pre-built templates.
- `railway up` supports `--detach`, `--ci`, `--json`, `--service`, `--environment`, `--project`, `.railwayignore`, and `--path-as-root`.
- Railway CLI docs also state that CI/CD should use `RAILWAY_TOKEN` for project-level actions.

## Skip-status deploy path

Use this when `railway status` is flaky but Railway auth and GraphQL readiness are already proven.

```powershell
$env:RAILWAY_PROJECT='5ac0190c-6520-4612-853b-4884c9198fd9'
$env:RAILWAY_ENVIRONMENT='f7b10ae1-f095-4304-832f-3bad1826dd37'
$env:RAILWAY_SERVICE='cb87b747-a33b-41a8-895c-de507a96d5d1'
$env:REMEDIATION_SKIP_RAILWAY_STATUS='1'
npm run deploy:remediation:railway
npm run test:remediation:completion-audit
```

Current failure evidence from this path:

- local predeploy inside the deploy workflow passes;
- Railway upload package is about `292980` bytes;
- upload reaches `Indexing...` and `Uploading...`;
- Railway resets the upload connection with `os error 10054`.

Conclusion: the current blocker is Railway upload/network transport from this environment, not the project size or local build.

CI-mode retry:

```powershell
$env:REMEDIATION_RAILWAY_MODE='ci'
$env:RAILWAY_PROJECT='5ac0190c-6520-4612-853b-4884c9198fd9'
$env:RAILWAY_ENVIRONMENT='f7b10ae1-f095-4304-832f-3bad1826dd37'
$env:RAILWAY_SERVICE='cb87b747-a33b-41a8-895c-de507a96d5d1'
$env:REMEDIATION_SKIP_RAILWAY_STATUS='1'
npm run deploy:remediation:railway
```

Current evidence: CI mode reaches the same upload phase and fails with the same `os error 10054`, before Railway can start build logs.

JSON-mode retry:

```powershell
$env:REMEDIATION_RAILWAY_MODE='json'
$env:RAILWAY_PROJECT='5ac0190c-6520-4612-853b-4884c9198fd9'
$env:RAILWAY_ENVIRONMENT='f7b10ae1-f095-4304-832f-3bad1826dd37'
$env:RAILWAY_SERVICE='cb87b747-a33b-41a8-895c-de507a96d5d1'
$env:REMEDIATION_SKIP_RAILWAY_STATUS='1'
npm run deploy:remediation:railway
```

Current evidence: JSON mode reaches the same upload phase and fails with the same `os error 10054`. All tested official `railway up` output modes (`detach`, `ci`, `json`) fail before Railway starts build logs.

## GitHub/Railway fallback path

Use this only when Railway is configured to auto-deploy from the GitHub repository and a human has approved publishing this worktree.

Railway's GitHub autodeploy documentation states that services linked to a GitHub repository deploy automatically when new commits are pushed to the connected branch: https://docs.railway.com/guides/github-autodeploys. Do not use this path until the connected branch is known, because pushing to `main` may deploy production immediately.

Diagnostic command:

```powershell
npm run test:remediation:railway-source
```

Current evidence:

- the current `RAILWAY_TOKEN` can reach Railway GraphQL;
- source/deployment-trigger fields return `Not Authorized`;
- artifact: `local-live-tests/remediation-railway-source-readiness.json`;
- fallback branch/source is not proven from this session.

Current remotes:

- `origin`: `https://github.com/zerg211/CHAT-AI-BAKAUT-RAILWAY.git`
- `old-origin`: `https://github.com/zerg211/CHAT-AI-BAKAUT.git`

Required safety checks before commit/push:

```powershell
git status --short
npm run test:remediation:predeploy
npm run test:remediation:docker-image
npm run test:remediation:completion-audit
```

The last command must still fail before deploy. It is used to confirm the only remaining failures are production/deploy/live evidence.

After approved commit/push and Railway auto-deploy:

```powershell
npm run test:remediation:external-readiness
npm run test:remediation:postdeploy
npm run test:remediation:completion-audit
```

Do not accept deployment as complete unless:

- `remediation-postdeploy.json` has `ok=true` and `stage=complete`;
- `remediation-completion-audit.json` has `ok=true`;
- fresh `local-live-tests/*.production.md` files exist for the current completion date;
- production admin metadata includes the new runtime artifacts on assistant turns.

## Manual production verification checklist

If automated postdeploy is blocked but the production marker appears:

1. Open `https://bakautprof.ru/`.
2. Use the embedded widget, not localhost or direct API.
3. Run a natural multi-turn buyer dialogue.
4. Read the assistant answer before every next buyer message.
5. Save a dated `.production.md` protocol under `local-live-tests/`.
6. Verify admin metadata for `executionContract`, `requirementLedger`, `cardManifest`, `factClaimPlanner`, `factClaimAudit`, `leadStateMachine`, and `postAnswerVerification`.
7. Run `npm run test:remediation:completion-audit`.

## Completion rule

The goal is not complete until:

```powershell
npm run test:remediation:completion-audit
```

returns `ok=true`.
