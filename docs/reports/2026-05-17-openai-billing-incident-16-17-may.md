# OpenAI billing incident: 16-17 May 2026

## Scope

User-reported issue: OpenAI billing was spent unexpectedly around 16-17 May 2026.

This report is based on project code, local live-test artifacts, and production admin conversation metadata from Railway. It does not include OpenAI account-side Usage CSV, so it explains the app-side cause and gives an evidence-backed token estimate, not an exact money total.

## Finding

The spend was caused by repeated production live/e2e verification runs against the real `https://bakautprof.ru/` widget on 16 May 2026.

This was not normal buyer traffic:

- 45 production sessions with messages were created on 16 May 2026.
- 44 of 45 sessions had `HeadlessChrome` user agent and `pageUrl=https://bakautprof.ru/`, matching automated Playwright/live-test runs.
- Those automated sessions produced:
  - 254 user turns;
  - 240 successful assistant messages;
  - 13 failed turns;
  - only the final 6 failed sessions showed `AI answer recovery failed: insufficient_quota` and produced no assistant answer.

Therefore the quota was already consumed before the visible `insufficient_quota` failures started. The failures at 21:34-21:49 UTC are a symptom of exhausted billing/quota, not the original spender.

## Production timeline evidence

Production admin metadata for 16 May 2026:

| UTC hour | Sessions | User turns | Assistant messages | Failed turns |
| --- | ---: | ---: | ---: | ---: |
| 10:00 | 1 | 8 | 7 | 1 |
| 12:00 | 2 | 10 | 8 | 2 |
| 13:00 | 1 | 1 | 1 | 0 |
| 15:00 | 2 | 16 | 14 | 2 |
| 16:00 | 5 | 33 | 31 | 2 |
| 17:00 | 6 | 42 | 41 | 0 |
| 18:00 | 7 | 37 | 37 | 0 |
| 19:00 | 6 | 40 | 40 | 0 |
| 20:00 | 7 | 43 | 43 | 0 |
| 21:00 | 8 | 24 | 18 | 6 |

High-consumption repeated sessions include many full 9-turn live cycles:

- conversations `946`, `949`, `951`, `953`, `956`, `958`, `960`, `961`, `963`, `966`, `968`, `970`, `973`, `974`: each had 9 user turns and 9 assistant messages.
- conversations `959`, `967`: each had 6 user turns and 6 assistant messages.
- conversations `975`-`980`: one-turn failures with `AI answer recovery failed: insufficient_quota`.

Local protocol artifacts confirm the same flows:

- `local-live-tests/2026-05-16-bakautprof-production-agent-cycle.production.md`: 9-turn production live cycle passed.
- `local-live-tests/2026-05-16-production-876-agentic-remediation-2026-05-16T19-07-50-277Z.production.md`: 6-turn production #876 cycle passed.
- `local-live-tests/remediation-railway-deploy.json`: postdeploy workflow ran `test:live:production`, passed the 9-turn cycle, then entered `test:live:production:876`.
- `local-live-tests/production-agent-cycle-failure.json`: later first-turn production check failed with `AI answer recovery failed: insufficient_quota`.

## Why each turn was expensive

The chat backend is an agentic pipeline, not a single OpenAI request per buyer message. A normal turn can trigger:

1. `need_extraction` planner call.
2. `turn_planner` call.
3. final `answer` call.
4. optional troubleshooting memory router.
5. optional web/fact search.
6. optional answer recovery or empty-answer recovery.
7. optional web fact extraction.

Relevant code locations:

- `src/ai/assistant.ts`: OpenAI `responses.create` calls for need extraction, planning, answer generation, recovery, and fact extraction.
- `src/ai/generatorLoadReference.ts`: web search call through `web_search_preview`.
- `src/config.ts`: output-token limits and model configuration.
- `tests/remediationPostdeploy.mjs`: runs both production live scripts.
- `tests/liveAgentCycle.production.mjs`: 9-turn production live scenario.
- `tests/liveAgentCycle.876.production.mjs`: 6-turn production #876 scenario.

Local usage evidence:

- `local-live-tests/dev-server-876.log` shows the first local #876 turn consumed about 20,878 tokens across `need_extraction`, `turn_planner`, and `answer`.
- The second local #876 turn consumed about 30,752 tokens.
- Older token audit `local-live-tests/2026-04-27-token-budget-optimization.local.md` recorded `answer` calls averaging 21,027 input tokens, with a max of 57,697 input tokens before optimization.

With 240 successful production assistant messages on 16 May, even a conservative 20k-31k tokens per successful turn gives roughly 4.8M-7.4M tokens, before adding failed/recovery attempts, web search, and retries.

## What became heavier than before

The anomaly is not explained only by "45 dialogs". Admin metadata shows 45 sessions, but they contained 254 buyer turns and 240 successful assistant replies. Many sessions were full production verification cycles with 6-9 buyer turns each.

The per-turn payload also grew in the May remediation branch:

1. Large card slices became normal in live tests.
   - Code: `src/ai/assistant.ts`, `FULL_SLICE_PRODUCT_CARDS = 50`.
   - Production protocol: `local-live-tests/2026-05-16-bakautprof-production-agent-cycle.production.md` shows turns where 50 cards were produced and `Показать еще 43` was shown.
   - Local usage: `.codex-logs/local-server-3022.out.log` recorded an `answer` call with about 55,868 input tokens and 56,097 total tokens on a turn with `cards=50`.
   - Effect: the UI may need 50 cards, but the LLM answer prompt does not need full details for all 50. Sending broad card/product payloads to the answer stage multiplied input tokens.

2. The May contract stack was duplicated in the answer prompt.
   - Commit area: `63ade93 Add agent remediation contract stack`.
   - Code before fix: `src/ai/assistant.ts` placed `requirementLedger`, `executionContract`, `cardManifest`, `factClaimPlanner`, and `leadStateMachine` inside `answerContext`, then repeated the same five objects again at the top level of `answerInputPayload`.
   - Effect: every answer call carried the same structured policy state twice. This improves neither intelligence nor safety; it is prompt bloat.

3. Semantic memory made planning context heavier.
   - Commit area: `f5b0842 Add semantic memory for sales dialog state`.
   - Effect: `need_extraction` and `turn_planner` now carry richer active requirements, mentioned products, hidden preferences, and selection state. This is architecturally correct, but it needs compaction and token accounting.

4. Planner output ceilings increased.
   - Commit area: `85c15b5 Stabilize structured planner state storage`.
   - Code: `PLANNER_JSON_OUTPUT_TOKEN_MIN = 8000`, `JSON_RETRY_OUTPUT_TOKEN_MIN = 12000`.
   - Effect: planner calls can reserve/generate much larger structured outputs than earlier. In `.codex-logs/local-server-3022.out.log`, `turn_planner` dominated local usage: about 990k total tokens across 44 calls, more than the final `answer` stage.

5. Recovery can add extra paid calls on failures.
   - Commit area: `5238f02 Add turn recovery and live agent cycle gate`.
   - Effect: aborted/empty answer cases can trigger recovery calls. On 16 May this was not the main spender because most expensive sessions completed successfully, but it amplified failed turns near quota exhaustion.

Estimated comparison:

- 27 Apr final 6-turn local audit: about 160,453 total tokens, or about 26,742 tokens per buyer turn.
- 16 May local `3022` log: about 1,927,465 total tokens over roughly 42 successful answer turns, or about 45,900 tokens per turn.
- 16 May production: 240 successful assistant replies. At the older 26.7k/turn profile this is already about 6.4M tokens. At the heavier May profile it is about 11M tokens, before failed/recovery/web-search overhead.

Conclusion: the budget was spent because production tests produced far more real turns than "45 dialogs" suggests, and those turns became materially heavier after 50-card answer context, duplicated runtime contracts, semantic memory, larger planner JSON budgets, and recovery calls were introduced.

## Root cause

Primary root cause:

The remediation workflow repeatedly ran real production live tests against the Railway bot, and each test turn executed a multi-call OpenAI agent pipeline. There was no production budget guard, no per-day test-run cap, and no persisted per-stage token ledger to stop or warn before credits were exhausted.

Contributing factors:

- `npm run test:remediation:postdeploy` runs both `test:live:production` and `test:live:production:876`, up to 15 real production turns per run.
- Multiple remediation/fix/deploy cycles on 16 May retriggered those live checks.
- Production usage was not persistently recorded per OpenAI stage; `DEBUG_OPENAI_USAGE` logs usage only when enabled and goes to logs, not to a durable accounting table.
- The final answer context is still potentially large because the bot sends conversation context, candidate products, catalog facts, and sometimes web-search context to preserve agent quality.

## What is not the cause

- The final `insufficient_quota` requests are not the main spender; they mark the point where quota was already exhausted.
- Unit tests and agentic eval tests are mostly local/mocked and are not the main OpenAI spender.
- Railway deployment itself is not the OpenAI spender.
- Heartbeats are not the main spender.
- There is no evidence in the production sessions of uncontrolled infinite looping. The pattern is finite but repeatedly re-run live test flows.

## Required remediation

1. Add a production OpenAI usage ledger:
   - persist stage, model, input tokens, output tokens, total tokens, session id, turn id, environment, and timestamp;
   - expose admin summary by day/session/stage.

2. Add a budget guard:
   - daily token cap for production test traffic;
   - separate cap for live/e2e sessions identified by `HeadlessChrome`;
   - fail fast before calling OpenAI when the cap is exceeded.

3. Gate production live tests:
   - require an explicit env flag for expensive production live checks;
   - print estimated maximum turns before run;
   - prevent accidental repeated postdeploy loops.

4. Separate production quality checks by cost:
   - cheap readiness probe first;
   - one short smoke turn only when quota is healthy;
   - full 9+6 live cycle only when explicitly approved for final validation.

5. Keep the agentic architecture, but reduce repeated context:
   - maintain semantic memory and structured catalog facts;
   - avoid resending broad product candidates when the current turn only needs a narrow answer;
   - persist and reuse verified facts instead of rechecking them in every live test turn.

6. Compact answer-stage prompts without making the bot linear:
   - keep full card selection in deterministic code/UI payload;
   - send only buyer-visible cards to the answer LLM;
   - send hidden cards as count/short preview, not full product detail;
   - send one compact `runtimeContracts` object instead of duplicating the full contract stack;
   - keep full ledgers/manifests in metadata for audit and validators.

## Current status

The code already has an admin runtime readiness probe:

- `GET /api/admin/runtime/openai`

It correctly classified current production OpenAI status as `quota_or_billing` / `insufficient_quota`. The next step is not another live production test; it is implementing the usage ledger and budget guard first.

Implemented local prompt-compaction fix on 17 May 2026:

- `src/ai/assistant.ts` now sends only visible cards in `answerContext.productCardsShown`.
- recommendation answer context now builds detailed product facts from the visible cards only, not from the full 50-card UI slice.
- `productCardsBehindShowMore` is capped to a short preview while `productCardDisplay.hiddenCount` still tells the model that more cards exist.
- `allSuitableProducts` in the answer prompt is capped to 12 compact items.
- runtime policies are sent as a compact `runtimeContracts` object inside `answerContext`.
- the duplicated top-level `requirementLedger` / `executionContract` / `cardManifest` / `factClaimPlanner` / `leadStateMachine` answer payload fields were removed.
