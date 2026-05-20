# Remaining Problems: agent-manager-harness

Status after 2026-05-20 local implementation: code, tests, build, migration, and diff checks pass locally. Full done definition is not complete because production widget verification has not been run with the new harness enabled.

## Remaining Before Production Activation

- Push branch to GitHub and let Railway auto-deploy. Do not use manual Railway deploy commands unless explicitly requested.
- Confirm production `/api/health` shows the pushed commit and `agentManagerUrlOptInParam`.
- Run production widget live checks through `https://bakautprof.ru/?agentHarness=1`, not direct API/local iframe.
- Save live protocols under `local-live-tests/*.production.md`.
- Verify admin metadata/traces for every production live dialogue.
- After opt-in verification passes, decide whether to enable flags globally in a controlled order, starting with `AGENT_MANAGER_HARNESS_ENABLED=true`.

## Remaining Product/Operations Work

- Prompt quality with real OpenAI planner/answer/reviewer outputs needs live/eval monitoring after flags are enabled.
- Latency/token usage need production measurement because the harness uses more LLM calls than legacy fast paths.
- Physical deletion of legacy paths should wait until the enabled harness passes production live checks for the same capability.

## Not Remaining As Code Gaps

- Lead outbox retry is implemented.
- Same-turn checkpoint recovery is implemented for the harness route.
- Final answer contract resume is implemented.
- Ledger-derived read-only `needState` snapshot is implemented.
- Product comparison web research and conflict recording are implemented.
- Reviewer blocks unsupported sources, unexecuted tools, bad lead confirmation, and high-risk adjudication cases.
- Admin trace API and compact admin trace rendering are implemented.
- Production widget URL opt-in is implemented locally so the harness can be tested in production without exposing it to all buyers.
- Legacy catalog/commercial fast-path deterministic answer writers are replaced by LLM route/answer contracts locally.
- Local lead creation now forces a buyer-visible contact-received confirmation instead of repeating the contact request.
