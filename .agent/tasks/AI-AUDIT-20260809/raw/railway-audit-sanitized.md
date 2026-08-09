# Railway production audit (sanitized)

Checked: 2026-08-09 MSK. No variable values, credentials or raw `.env` content are recorded here.

## Project/deployment

- Project: `laudable-unity`.
- Environment: `production`.
- Services: `chat-ai`, PostgreSQL.
- `chat-ai`: deployment `SUCCESS`, instance `RUNNING`.
- Active source commit: `9bc454c164869c7f1e2c91e2417a50e3ea10b769`, branch `main`.
- GitHub repository: `zerg211/CHAT-AI-BAKAUT-RAILWAY`.
- Builder: Dockerfile.
- Replica: 1, Europe west region.
- Domains: custom chat domains and Railway app domain present.
- PostgreSQL: running; volume ready, approximately 679 MB used of 5000 MB at check time.

## Lifecycle contract

- `railway.json` preDeploy: `node dist/server/db/migrate.js`.
- Railway start command: `node dist/server/server.js`.
- Dockerfile CMD also contains migration before server; Railway start override means the effective service path is separate, but the repository has duplicated declarative migration intent.
- Health path: `/api/health`; timeout 100 seconds; restart on failure, max 10.
- Manual `railway up/deploy` was not used.

## Variable-name/policy audit

31 variable names were inspected by presence/format only.

- Present: production NODE_ENV, DATABASE_URL, HTTPS PUBLIC_BASE_URL, OpenAI credential name, admin-auth name, HTTP email transport names, lead recipient name.
- `OPENAI_MODEL` exists but does not equal required `gpt-5.6-terra`.
- Production `src/config.ts` overrides answer/planner/fact/deep/review models to `gpt-5.6-terra`, so this is configuration drift rather than evidence that a different model currently serves answers.
- Separate answer/planner/fact/deep model variables were absent.
- Explicit review-mode variable absent; production code enforces risk mode when configured off.
- Explicit CORS origins variable absent; effective default must be assessed from code and custom domains.

## Marker drift

- Current runtime manifest/app health contract: `2026-07-17.gpt-5-6-terra-search-first-v16`.
- Default production checker before remediation expected v15.
- Therefore the previous default live gate could fail against current healthy production or be overridden without proving the checked source version.

## Network/admin observations

- `railway status --json` succeeded.
- Shell `curl` to custom chat health domain failed DNS from the execution sandbox even after an approved network attempt; this is not evidence of production downtime.
- The Railway-domain production admin UI loaded and returned conversations/traces.
- The public embedded widget on `bakautprof.ru` loaded and completed live conversations.

## Security incident and required operation

The protected admin form rendered its password-field value into a private browser-tool output. It was not copied into this repository or any user-facing response. The credential must be treated as compromised. Rotation of Railway `ADMIN_PASSWORD` and local `.env` requires an explicit user authorization because it mutates a security-sensitive external setting and triggers a configuration redeploy. Rotation has not been performed at the time of this artifact.
