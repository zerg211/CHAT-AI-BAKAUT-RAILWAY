/**
 * Task outcome model (F01): internal readiness is not business success.
 *
 * `answer ready` ≠ `task resolved`. Every turn ends in exactly one outcome:
 * resolved | partially_resolved | needs_human_operation | blocked_missing_evidence
 * | blocked_tool_failure | failed_agent_capability. The writer, telemetry and the
 * decision artifact consume this — never a bare "ready" flag.
 */
import type { ToolResult } from './agentManagerContracts.js';
import { evidenceFingerprint, extractEvidenceInput } from './evidenceInput.js';
import { unreadFirstPartyUrls } from './firstPartyTurnInjection.js';

export type TaskOutcomeStatus =
  | 'resolved'
  | 'partially_resolved'
  | 'needs_human_operation'
  | 'blocked_missing_evidence'
  | 'blocked_tool_failure'
  | 'failed_agent_capability';

export interface TaskOutcome {
  goal: string;
  status: TaskOutcomeStatus;
  resolvedFacts: string[];
  unresolvedFacts: string[];
  requiredNextAction: string | null;
  humanOperationReason: string | null;
  evidenceIds: string[];
  toolFailures: string[];
  /** Buyer turns spent on this goal including the current one. */
  customerEffortCount: number;
}

export interface TaskOutcomeInput {
  goal: string;
  userMessage: string;
  toolResults: ToolResult[];
  /** Blocking unknowns that survived the turn (policy blocks, unmet required tools). */
  blockingUnknowns?: string[];
  /** Genuinely failed tool attempts (timeout/unavailable after retries). */
  toolFailures?: string[];
  /** Agent capability failure with no remaining strategy (internal error class). */
  capabilityFailure?: string | null;
  leadCaptured?: boolean;
  contactOffered?: boolean;
  humanOperationReason?: string | null;
  customerEffortCount?: number;
  resolvedFacts?: string[];
  unresolvedFacts?: string[];
}

function readAttempted(toolResults: ToolResult[]): boolean {
  return toolResults.some((result) => result.tool === 'site.readFirstPartyPage');
}

/**
 * Deterministic outcome derivation. A buyer-supplied first-party URL that was
 * never read can never end in `resolved`: the key evidence was not consulted.
 */
export function deriveTaskOutcome(input: TaskOutcomeInput): TaskOutcome {
  const evidenceIds = input.toolResults
    .filter((result) => result.status === 'ok')
    .map((result) => result.requestId);
  const toolFailures = [...(input.toolFailures ?? [])];
  for (const result of input.toolResults) {
    if (result.status === 'error' || result.status === 'timeout') {
      toolFailures.push(`${result.tool}:${result.errorCode ?? result.status}`);
    }
  }
  const unreadUrls = unreadFirstPartyUrls(input.userMessage, input.toolResults);
  const base = {
    goal: input.goal,
    evidenceIds,
    toolFailures: [...new Set(toolFailures)],
    customerEffortCount: Math.max(1, input.customerEffortCount ?? 1)
  };
  if (input.capabilityFailure) {
    return {
      ...base,
      status: 'failed_agent_capability',
      resolvedFacts: [...(input.resolvedFacts ?? [])],
      unresolvedFacts: [...(input.unresolvedFacts ?? []), input.capabilityFailure],
      requiredNextAction: null,
      humanOperationReason: null
    };
  }
  if (input.leadCaptured) {
    return {
      ...base,
      status: 'needs_human_operation',
      resolvedFacts: [...(input.resolvedFacts ?? []), 'buyer contact collected exactly once'],
      unresolvedFacts: [...(input.unresolvedFacts ?? [])],
      requiredNextAction: null,
      humanOperationReason: input.humanOperationReason ?? 'manager callback pending'
    };
  }
  if (unreadUrls.length > 0 && !readAttempted(input.toolResults)) {
    return {
      ...base,
      status: 'blocked_missing_evidence',
      resolvedFacts: [...(input.resolvedFacts ?? [])],
      unresolvedFacts: [...(input.unresolvedFacts ?? []), ...unreadUrls.map((url) => `unread buyer-supplied page: ${url}`)],
      requiredNextAction: 'read the buyer-supplied first-party page before any absence claim',
      humanOperationReason: null
    };
  }
  if (toolFailures.length > 0 && evidenceIds.length === 0) {
    return {
      ...base,
      status: 'blocked_tool_failure',
      resolvedFacts: [...(input.resolvedFacts ?? [])],
      unresolvedFacts: [...(input.unresolvedFacts ?? []), ...toolFailures],
      requiredNextAction: 'retry with a materially different source or strategy',
      humanOperationReason: null
    };
  }
  const blockers = [...(input.blockingUnknowns ?? [])];
  if (blockers.length > 0) {
    return {
      ...base,
      status: 'blocked_missing_evidence',
      resolvedFacts: [...(input.resolvedFacts ?? [])],
      unresolvedFacts: [...(input.unresolvedFacts ?? []), ...blockers],
      requiredNextAction: blockers[0] ?? null,
      humanOperationReason: null
    };
  }
  if ((input.unresolvedFacts ?? []).length > 0) {
    return {
      ...base,
      status: 'partially_resolved',
      resolvedFacts: [...(input.resolvedFacts ?? [])],
      unresolvedFacts: [...(input.unresolvedFacts ?? [])],
      requiredNextAction: input.contactOffered ? 'await buyer contact or continue consultation' : null,
      humanOperationReason: null
    };
  }
  return {
    ...base,
    status: input.contactOffered ? 'partially_resolved' : 'resolved',
    resolvedFacts: [...(input.resolvedFacts ?? [])],
    unresolvedFacts: [],
    requiredNextAction: null,
    humanOperationReason: null
  };
}

export interface FirstPartyReviewIssue {
  code: 'first_party_evidence_unconsulted';
  severity: 'high';
  message: string;
  evidence: string;
}

/**
 * Deterministic pre-send rule: the buyer gave a first-party URL, this turn never
 * attempted to read it, yet the turn is about to send an answer. Sending without
 * consulting first-class evidence is an agent failure, not a buyer problem.
 */
export function firstPartyAnswerReviewIssues(input: {
  userMessage: string;
  toolResults: ToolResult[];
}): FirstPartyReviewIssue[] {
  const unread = unreadFirstPartyUrls(input.userMessage, input.toolResults);
  if (unread.length === 0 || readAttempted(input.toolResults)) return [];
  return [{
    code: 'first_party_evidence_unconsulted',
    severity: 'high',
    message: 'The buyer supplied a first-party page URL that this turn never attempted to read; answer without consulting first-class evidence.',
    evidence: unread.join(', ')
  }];
}

export interface TurnOutcomeSummary {
  evidenceFingerprint: string;
  /** Tool coverage with identifying args, e.g. `catalog.search:1110511`. */
  toolCoverage: string[];
  outcomeStatus: TaskOutcomeStatus;
  /** readiness.status + card count + lead action. */
  refusalSignature: string;
}

function coverageKey(tool: string, args: Record<string, unknown>): string {
  const identifying: unknown[] = [];
  for (const key of ['url', 'query', 'productIds', 'productNames']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) identifying.push(value.trim());
    else if (Array.isArray(value)) identifying.push(value.filter((item) => typeof item === 'string'));
  }
  return tool + ':' + JSON.stringify(identifying);
}

export function summarizeTurnOutcome(input: {
  userMessage: string;
  toolRequests?: Array<{ id: string; tool: string; args: Record<string, unknown> }>;
  toolResults: ToolResult[];
  goal?: string;
  blockingUnknowns?: string[];
  toolFailures?: string[];
  leadCaptured?: boolean;
  readinessStatus?: string;
  selectedProductIds?: string[];
  leadAction?: string;
}): TurnOutcomeSummary {
  const requests = new Map((input.toolRequests ?? []).map((request) => [request.id, request]));
  const toolCoverage = input.toolResults.map((result) => {
    const request = requests.get(result.requestId);
    return coverageKey(result.tool, request?.args ?? {});
  });
  // A non-resolved selection with no product cards and no lead is a refusal signal
  // even when no deterministic blocker was recorded: the buyer's commercial need
  // was not advanced. Surface it so anti-repetition can compare it as a fact.
  const selectionUnresolved = input.readinessStatus === 'needs_more_info' &&
    (input.selectedProductIds?.length ?? 0) === 0 &&
    input.leadAction !== 'offer_form' && input.leadAction !== 'capture_contact';
  const blockingUnknowns = selectionUnresolved
    ? [...(input.blockingUnknowns ?? []), 'selection:needs_more_info']
    : (input.blockingUnknowns ?? []);
  const outcome = deriveTaskOutcome({
    goal: input.goal ?? 'buyer task',
    userMessage: input.userMessage,
    toolResults: input.toolResults,
    blockingUnknowns,
    toolFailures: input.toolFailures,
    leadCaptured: input.leadCaptured
  });
  return {
    evidenceFingerprint: evidenceFingerprint(extractEvidenceInput(input.userMessage)),
    toolCoverage: [...new Set(toolCoverage)],
    outcomeStatus: outcome.status,
    refusalSignature: `${input.readinessStatus ?? 'none'}|cards:${input.selectedProductIds?.length ?? 0}|lead:${input.leadAction ?? 'none'}`
  };
}

const REFUSAL_STATUSES: TaskOutcomeStatus[] = ['blocked_missing_evidence', 'blocked_tool_failure', 'failed_agent_capability'];

/**
 * Anti-repetition progress check (F11): the buyer added evidence, yet the task
 * outcome did not change, no materially new action was attempted, and the answer
 * repeats the previous refusal. Comparison is by evidence fingerprint and tool
 * coverage — never by answer text.
 */
export function detectStalledRepetition(
  previous: TurnOutcomeSummary | null,
  current: TurnOutcomeSummary
): boolean {
  if (!previous) return false;
  if (current.evidenceFingerprint === previous.evidenceFingerprint) return false;
  if (current.outcomeStatus !== previous.outcomeStatus) return false;
  if (current.refusalSignature !== previous.refusalSignature) return false;
  if (!REFUSAL_STATUSES.includes(current.outcomeStatus)) return false;
  return current.toolCoverage.every((key) => previous.toolCoverage.includes(key));
}

interface HistoryMessage {
  role?: unknown;
  content?: unknown;
  metadata?: Record<string, unknown> | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Best-effort previous-turn summary from persisted assistant metadata; null when absent. */
export function previousTurnOutcomeSummary(history: HistoryMessage[]): TurnOutcomeSummary | null {
  let previousAssistant: HistoryMessage | null = null;
  let previousUser: HistoryMessage | null = null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'assistant' && !previousAssistant) {
      const metadata = asRecord(message.metadata);
      if (metadata && asRecord(metadata.answerContract)) previousAssistant = message;
      continue;
    }
    if (previousAssistant && message.role === 'user') {
      previousUser = message;
      break;
    }
  }
  if (!previousAssistant || !previousUser || typeof previousUser.content !== 'string') return null;
  const metadata = asRecord(previousAssistant.metadata) ?? {};
  const contract = asRecord(metadata.answerContract) ?? {};
  const readiness = asRecord(contract.selectionReadiness);
  const toolResults = Array.isArray(metadata.toolResults)
    ? (metadata.toolResults as ToolResult[])
    : [];
  const requests = Array.isArray((metadata.intentContract as Record<string, unknown> | undefined)?.toolRequests)
    ? ((metadata.intentContract as Record<string, unknown>).toolRequests as Array<{ id: string; tool: string; args: Record<string, unknown> }>)
    : [];
  const selectedProductIds = Array.isArray(contract.selectedProductIds)
    ? contract.selectedProductIds.filter((id): id is string => typeof id === 'string')
    : [];
  return summarizeTurnOutcome({
    userMessage: previousUser.content,
    toolRequests: requests,
    toolResults,
    readinessStatus: typeof readiness?.status === 'string' ? readiness.status : undefined,
    selectedProductIds,
    leadAction: typeof contract.leadAction === 'string' ? contract.leadAction : undefined
  });
}

export interface StalledRepetitionIssue {
  code: 'stalled_repeated_refusal';
  severity: 'high';
  message: string;
  evidence: string;
}

export function stalledRepetitionReviewIssues(input: {
  history: HistoryMessage[];
  userMessage: string;
  toolRequests?: Array<{ id: string; tool: string; args: Record<string, unknown> }>;
  toolResults: ToolResult[];
  readinessStatus?: string;
  selectedProductIds?: string[];
  leadAction?: string;
}): StalledRepetitionIssue[] {
  const previous = previousTurnOutcomeSummary(input.history);
  const current = summarizeTurnOutcome({
    userMessage: input.userMessage,
    toolRequests: input.toolRequests,
    toolResults: input.toolResults,
    readinessStatus: input.readinessStatus,
    selectedProductIds: input.selectedProductIds,
    leadAction: input.leadAction
  });
  if (!detectStalledRepetition(previous, current)) return [];
  return [{
    code: 'stalled_repeated_refusal',
    severity: 'high',
    message: 'The buyer added new evidence but the task outcome, attempted actions and refusal did not change; the new evidence was not acted upon.',
    evidence: current.evidenceFingerprint
  }];
}
