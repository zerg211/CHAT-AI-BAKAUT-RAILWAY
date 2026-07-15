# AI manager production audit v16 — frozen specification

Status: frozen before implementation.

## Objective

Continue the owner-requested verify/fix/reverify loop toward a production AI manager that behaves like a capable Bakaut sales and support employee rather than a scripted chatbot. Do not assume the previous plate-compactor fix proves adjacent flows.

## Current production baseline

- Expected branch: `main`.
- Expected deployed commit at audit start: `f41f99ca015cc63c27696becbf1db41dfdefed66`.
- Expected runtime: `2026-07-15.gpt-5-6-terra-latency-headroom-v15`.
- Production surface: embedded widget on `https://bakautprof.ru/` only.
- All manager roles must remain `gpt-5.6-terra`.

## Scope

Run several distinct adaptive buyer conversations and audit every turn from both sides:

1. Generator selection from an incomplete need through load clarification, concrete recommendation, alternatives, and a changed hard requirement.
2. Technical support/maintenance or consumables question that requires catalog facts and, if decisive facts are missing, autonomous external research before human escalation.
3. Commercial question covering availability, delivery timing, discount or special conditions, verifying that no unsupported promise is made and that lead handoff occurs only when appropriate.
4. Product-card correctness, memory across turns, factual grounding, natural sales language, and latency/recovery behavior in every dialogue.

The next buyer message must be chosen only after reading the actual prior answer and visible cards.

## Required diagnosis for every confirmed defect

1. Identify where deterministic code limits or replaces semantic model understanding.
2. Identify whether the rule lacks dialogue context.
3. State what remains deterministic because it verifies catalog facts, safety, permissions, business restrictions, or sorting.
4. State what belongs in the LLM planner because it requires intent, changed requirements, alternative policy, or contextual meaning.
5. Define the structured planner/result field that lets code execute safely.

No phrase-specific regex, canned response, or one-dialogue `if` may be added as a fix.

## Acceptance criteria

- **AC1 — runtime identity:** production health proves the exact GitHub commit, Terra models, contract version, and `agent_manager` runtime.
- **AC2 — adaptive coverage:** at least three fresh production sessions cover the three scoped buyer strategies; every next turn follows the actual visible answer.
- **AC3 — need elicitation:** the agent gathers or correctly infers decision-relevant requirements without interrogating unnecessarily and does not recommend against an explicit hard constraint.
- **AC4 — context updates:** changed requirements replace or explicitly reconcile prior constraints; stale needs do not contaminate selection.
- **AC5 — grounded selection:** named products and visible cards match the active need, catalog facts, price visibility, and deterministic hard constraints.
- **AC6 — technical truth:** technical, maintenance, consumable, safety, and compatibility claims are grounded; missing decisive facts trigger search-first behavior and truthful preliminary/final-fit language.
- **AC7 — commercial truth:** availability, discount, delivery, service, and special-condition statements stay within business rules and never become unsupported promises.
- **AC8 — useful continuation:** when self-service research is exhausted, the response keeps the useful preliminary conclusion, names the exact gap, offers a technical specialist, requests a phone number, and offers message or call without falsely claiming transfer.
- **AC9 — agentic quality:** responses are contextual, natural, non-scripted, explain tradeoffs, handle objections, and move the buyer toward a useful next step.
- **AC10 — observability:** each audited turn has buyer-visible transcript, card audit, admin metadata, tool statuses/durations, selection state, reviewer verdict, recovery/fallback state, and relevant code cause.
- **AC11 — latency:** every completed non-lead turn is at most 60 seconds server-side; each web research stage is below 20 seconds; no futile retry runs.
- **AC12 — regression coverage:** every confirmed production defect receives a targeted regression before or with its fix.
- **AC13 — local release gate:** focused tests, full repository tests, agentic eval, TypeScript, production build, dependency audit, no-new-regex gate, and `git diff --check` pass after any code change.
- **AC14 — deployment and revalidation:** fixes are committed and pushed to GitHub, Railway proves the exact deployed commit, and affected production dialogues are repeated through the embedded widget.
- **AC15 — evidence:** `evidence.md`, `evidence.json`, `problems.md`, raw local checks, production transcripts, card audits, and trace summaries exist in this task directory.

## Verification method

1. Confirm current worktree and runtime route/marker before relying on documentation.
2. Inspect current prompts, selection/card filters, tool policy, lead flow, recovery/fallback, and relevant tests.
3. Conduct live dialogues only through the Bakaut embedded widget and preserve session/turn IDs.
4. Check factual claims against current catalog/admin evidence and authoritative external sources only when required.
5. Record every failure in `problems.md`; choose the smallest universal architectural fix.
6. Reverify current code from scratch, deploy through GitHub, then repeat the affected live behavior.

## Prohibitions

- No localhost or direct API call as behavioral proof.
- No manual Railway deployment.
- No model downgrade or removal of the evidence reviewer.
- No new buyer-phrase regex, keyword route, canned reply, or test-only production branch.
- No secrets in files or tool output.
- Do not edit or stage the three pre-existing user-owned files under `.agent/tasks/2026-07-08-agentic-dialogue-fixes/`.
- Do not claim the broad owner goal complete from this single audit cycle unless the full completion audit proves all intended sales/support domains and no required work remains.
