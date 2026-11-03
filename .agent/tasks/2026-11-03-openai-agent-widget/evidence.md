# Verification in progress

- Server and client typecheck: `npm run typecheck`, exit 0.
- Production build: `npm run build`, exit 0.
- Focused tests: `npx vitest run tests/platformAgentAssistant.test.ts tests/platformAgentClient.test.ts tests/chatStream.test.ts tests/chatHistory.test.ts tests/chatSessionLifecycle.test.ts tests/chatRouteAbort.test.ts tests/chatRecoveryAfterStreamFailure.test.ts`, 7 files and 62 tests passed on the current changes.
- Fresh focused pass including `tests/app.test.ts`: 8 files and 66 tests passed; the platform runtime marker and schema readiness are included in the subsequent commit.
- Railway production Postgres has a new 1 GB persistent volume and is online; the owner explicitly approved starting with an empty chat database.
- The real site currently loads `/local/bakaut-vm-chat/250db6b98598a38d/widget.js`; its iframe reports a chat refresh error. The new deployment has not been connected to that site loader.
- Live Agent API, full pagination, production deployment, and live-site widget acceptance remain pending. Local mock tests do not prove those acceptance criteria.
- First GitHub release gate ran 1,560 tests successfully but failed its production dependency audit because the locked Zod version had a high-severity advisory. Updated Zod to 4.6.7; `npm audit --omit=dev --audit-level=high` now exits 0. GitHub verification must be repeated for the updated lockfile.
- Live site check: first four pages displayed 40 unique product cards. Page five displayed nine cards although the agent named ten; it introduced a space into the A-iPower A5500 URL. See `problems.md`. The fix was verified with a focused regression test; deployment and repeat live verification are pending.
Local verification: 52 focused Vitest tests passed, including malformed product URL, a rejected product mentioned in prose, incomplete classification and duplicate pages. no-regex lint passed. Live acceptance remains pending; do not mark PASS until checked through bakautprof.ru widget.
Preloaded-list change: 55 focused tests passed, including collection of multiple catalog pages, fail-closed incomplete pages, explicit selection and 70-card response/history. Typecheck and no-regex lint passed. Production widget acceptance and timing remain pending.
