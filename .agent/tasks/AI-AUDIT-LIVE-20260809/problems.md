# Remaining problems / release blockers

## P0 — post-fix release and live proof missing

- Status: `OPEN`; acceptance criterion: AC7.
- Reproduction: the working tree contains the follow-up fixes, but `main`/`origin/main` still point to `7bf62ef30548666b611aacf76aef5db3ae2cec62`; no Railway deployment exists for the follow-up commit.
- Expected: exact GitHub commit deployed by Railway, health and runtime marker verified, then adaptive widget dialogues recorded on `https://bakautprof.ru/`.
- Next action: stage the classified tracked changes, commit, push, wait for Railway's GitHub deployment, verify marker, and run the required live protocol.

## P1 — fresh PostgreSQL barrier unavailable in this environment

- Status: `UNAVAILABLE`, not a hidden code failure.
- Reproduction: `npx.cmd tsx .agent/tasks/AI-AUDIT-20260809/raw/postgres-close-create-verifier.ts` returned `ECONNREFUSED` for local 5432; `psql` is missing and `docker info` cannot connect to the daemon.
- Expected: two-client close/create and owner-fencing barriers pass against PostgreSQL after the release environment is available.
- Existing mitigation: repository SQL contract tests and the prior independent barrier evidence remain; a fresh live/CI database run is still required for release confidence.

## P2 — frozen extra backup branch requirement

- Status: `DEFERRED`; existing immutable rollback branch `codex/backup-pre-audit-20260809` points to the pre-audit commit `9bc454c` and the deployed merge SHA is recorded.
- A second branch/tag-equivalent backup was not created because the earlier branch-creation escalation was rejected. No destructive history operation was attempted.

