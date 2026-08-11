# Remaining problems / release blockers

## P0 — live catalog and autonomous completion regression

- Status: `OPEN`; acceptance criterion: AC7.
- Reproduction: after push of `a9eaaff`, the real widget answered the BPS 1550 Aw/Honda GX160 QX2 request without invented facts, but reported the exact model absent, returned no partial service data or source provenance, and stopped after an incomplete external check.
- Expected: exact catalog identity must resolve to the public BPS 1550 Aw card; catalog facts and official-source attempts must be preserved; only a truly exhausted search may offer a specialist handoff.
- Next action: verify or synchronize the AI catalog dataset, add a bounded source fallback for timed-out research, and rerun the same adaptive widget scenario after an exact Railway marker readback.

## P1 — fresh PostgreSQL barrier unavailable in this environment

- Status: `UNAVAILABLE`, not a hidden code failure.
- Reproduction: `npx.cmd tsx .agent/tasks/AI-AUDIT-20260809/raw/postgres-close-create-verifier.ts` returned `ECONNREFUSED` for local 5432; `psql` is missing and `docker info` cannot connect to the daemon.
- Existing mitigation: repository SQL contract tests and prior independent barrier evidence remain; a fresh live database run is still required for release confidence.

## P2 — exact Railway marker unavailable

- Status: `UNVERIFIED`.
- Reproduction: both `https://chat-ai-production-3057.up.railway.app/api/health` and `https://bakaut-chat.vexr.dev/api/health` were unavailable from this environment; Railway CLI status was intermittent/unauthorized.
- Impact: the visible widget is real production, but its runtime commit cannot be cryptographically tied to `a9eaaff` from this environment.

## P3 — rollback

- Existing immutable rollback branch: `codex/backup-pre-audit-20260809` at pre-audit commit `9bc454c`.
- No destructive history operation was attempted.
