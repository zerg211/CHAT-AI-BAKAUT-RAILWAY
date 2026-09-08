# AI manager responsibility boundaries

Current code audit: 2026-09-08, tool/evidence extraction at `4578a2f`. This map describes implementation boundaries, not production or human-quality acceptance.

| Responsibility | Current owner | Contract and authority |
| --- | --- | --- |
| Turn supervision | `agentManagerOrchestrator.ts` | Session/turn execution ownership, durable checkpoints, one budget, ordered model/tool/release stages and saved answer commit. |
| Semantic routing and memory update | `OpenAIAgentManagerModel.decideTurn` in `agentManagerModelAdapter.ts`; `agentManagerContracts.ts` | Model returns combined typed semantic decision, ledger delta, intent, product mentions, requirements and action authorization. Supervisor validates it before applying state or executing tools. |
| Evidence and tool execution | `AgentManagerToolExecutor` | Original repository/model/embedding/price instances are injected. Exact identity, source applicability, fact reuse/persistence, catalogue search and tool results remain evidence-bound. No independent turn owner or retry loop is introduced. |
| Product selection | `agentManagerCardSelection.ts`, `requirementProofs.ts`, executor selection helpers | Model chooses intent and structured requirements. Code applies catalogue facts, ranking and proven contradictions; missing evidence is distinct from incompatibility. |
| Action policy | `agentManagerPolicyGate.ts`, contract validation, executor lead authorization | Structured, grounded buyer authorization is required. Tool execution does not infer permission from an unvalidated answer or retry. |
| Durable action delivery | Lead repository/outbox and delivery worker | Immutable request snapshot, provider idempotency key, fenced lease and provider receipts. Unknown completion requires reconciliation, not a new action. |
| Answer composition | `OpenAIAgentManagerModel.composeAnswer` | Existing model pass receives evidence-bound products/facts and response obligations. Supervisor owns draft persistence and bounded repair; no style-only extra pass. |
| Release validation | `validateAgentAnswer` in `agentManagerReleaseValidator.ts` | Same model/input/budget as before extraction. Checks evidence and answer/card consistency before supervisor commits final response. |
| Read continuation | `readContinuationController.ts`, `decisionArtifact.ts` | Typed bounded read decisions are executable before tools, not only logged afterward. They cannot authorize business side effects. |
| Recovery | `recoveryCoordinator.ts` plus supervisor saved-checkpoint callbacks | Admission and owner-contention waiting are separated; execution remains under the existing budget and owner. Saved answers do not require rerunning the action-bearing turn. |
| Progress and telemetry | `turnTelemetry.ts` | Same async stage context, durable redacted public event, live stage emitter and private trace sequence; telemetry failure isolation is preserved. |
| Outcome evaluation | `dialogueQualityAudit.ts`, `OutcomeDashboard.tsx`, human calibration tooling | Cost/latency/retry/fact-reuse denominators and unavailable data are explicit. Successful generation is not inferred to mean buyer resolution or human approval. |

## Extraction invariants and limits

Model adapter, telemetry, recovery, release validation and tool/evidence execution were extracted with existing characterization tests. The tool boundary additionally compares all moved methods/caches and 46 helper declarations against its pre-extraction Git baseline. Source guards include the new modules; moving code does not grant new regex waivers. Public exports and existing private supervisor test delegates remain compatible.

The supervisor still contains a large ordered turn pipeline and some stage-specific helpers. Semantic routing and composition have concrete model boundaries, but stage coordination is not yet independently factored into smaller services. This residual complexity is explicit; creating empty classes with plan role names would not improve it. Future extraction must preserve checkpoint order, the single execution owner, shared budget and exactly-once action semantics.

Local body equivalence and offline tests do not establish measured Recall@15, context-token savings, improved outcomes, human naturalness, production scoped credentials or live widget correctness. Those remain separate programme acceptance items.
