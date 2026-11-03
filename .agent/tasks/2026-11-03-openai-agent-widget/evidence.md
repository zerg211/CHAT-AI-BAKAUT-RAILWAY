# Verification in progress

- Server and client typecheck: `npm run typecheck`, exit 0.
- Production build: `npm run build`, exit 0.
- Focused tests: `npx vitest run tests/platformAgentAssistant.test.ts tests/platformAgentClient.test.ts tests/chatStream.test.ts tests/chatHistory.test.ts tests/chatSessionLifecycle.test.ts tests/chatRouteAbort.test.ts tests/chatRecoveryAfterStreamFailure.test.ts`, 7 files and 62 tests passed on the current changes.
- Fresh focused pass including `tests/app.test.ts`: 8 files and 66 tests passed; the platform runtime marker and schema readiness are included in the subsequent commit.
- Railway production Postgres has a new 1 GB persistent volume and is online; the owner explicitly approved starting with an empty chat database.
- The real site currently loads `/local/bakaut-vm-chat/250db6b98598a38d/widget.js`; its iframe reports a chat refresh error. The new deployment has not been connected to that site loader.
- Live Agent API, full pagination, production deployment, and live-site widget acceptance remain pending. Local mock tests do not prove those acceptance criteria.
