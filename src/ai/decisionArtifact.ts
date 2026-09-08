import { z } from 'zod';
import type {
  AgentIntentContract,
  AnswerContract,
  PreSendReview,
  ToolResult
} from './agentManagerContracts.js';

export const DECISION_LOOP_STAGES = [
  'Observe',
  'Assess',
  'Choose',
  'Authorize',
  'Execute',
  'Verify',
  'Update',
  'Stop/Continue',
  'Compose'
] as const;

const decisionRiskSchema = z.enum(['low', 'medium', 'high', 'unknown']);
const requiredConsentSchema = z.enum(['none', 'buyer', 'specialist']);

export const DecisionArtifactSchema = z.object({
  version: z.literal(1),
  loop: z.array(z.enum(DECISION_LOOP_STAGES)).length(DECISION_LOOP_STAGES.length),
  goal: z.string().trim().min(1).max(120),
  knownFacts: z.array(z.string().trim().min(1).max(180)).max(32),
  unknowns: z.array(z.string().trim().min(1).max(180)).max(32),
  blockingUnknowns: z.array(z.string().trim().min(1).max(180)).max(32),
  possibleActions: z.array(z.string().trim().min(1).max(120)).max(16),
  selectedAction: z.string().trim().min(1).max(120),
  risk: decisionRiskSchema,
  requiredConsent: requiredConsentSchema,
  stopCondition: z.string().trim().min(1).max(180),
  fallback: z.string().trim().min(1).max(180),
  rationale: z.string().trim().min(1).max(600)
}).strict();

export type DecisionArtifact = z.infer<typeof DecisionArtifactSchema>;

export interface DecisionArtifactInput {
  intent: AgentIntentContract;
  toolResults: ToolResult[];
  answer: AnswerContract;
  policyGate: {
    ok: boolean;
    blockedReasons: string[];
    requiredActions: string[];
  };
  review: PreSendReview;
}

function unique(values: string[]) {
  return [...new Set(values.filter((value) => value.trim()))];
}

function toolObservationLabel(result: ToolResult) {
  return `tool:${result.requestId}:${result.observationStatus ?? result.status}`;
}

/**
 * Builds a bounded, auditable control-plane artifact from already typed model
 * contracts and deterministic validators. It deliberately stores references
 * and statuses rather than hidden reasoning or raw customer text.
 */
export function buildDecisionArtifact(input: DecisionArtifactInput): DecisionArtifact {
  const grounding = input.intent.grounding;
  const readiness = input.answer.selectionReadiness;
  const successfulTools = input.toolResults.filter((result) =>
    result.status === 'ok' && (result.observationStatus ?? 'success') === 'success'
  );
  const failedTools = input.toolResults.filter((result) => !successfulTools.includes(result));
  const knownFacts = unique([
    grounding?.sourcePolicy ? `source_policy:${grounding.sourcePolicy}` : '',
    ...input.answer.factsUsed.map((fact) => `fact:${fact.factKey}`),
    ...successfulTools.map((result) => toolObservationLabel(result)),
    ...(input.answer.selectedProductIds ?? []).map((productId) => `product:${productId}:selected`)
  ]).slice(0, 32);
  const unknowns = unique([
    ...(readiness?.missingFacts ?? []),
    ...failedTools.map(toolObservationLabel),
    ...input.policyGate.blockedReasons.map((reason) => `policy:${reason}`)
  ]).slice(0, 32);
  const blockingUnknowns = unique([
    ...(readiness?.status === 'needs_more_info' ? (readiness.missingFacts ?? []) : []),
    ...input.policyGate.blockedReasons,
    ...input.policyGate.requiredActions
      .filter((tool) => !successfulTools.some((result) => result.tool === tool))
      .map((tool) => `required_tool:${tool}`)
  ]).slice(0, 32);
  const responseMode = grounding?.responseMode ?? 'answer';
  const leadNeedsConsent = input.answer.leadAction === 'offer_form' ||
    input.answer.leadAction === 'capture_contact' ||
    responseMode === 'handoff';
  const authorizedLead = input.intent.leadCaptureAuthorization?.authorized === true;
  const requiredConsent = leadNeedsConsent && !authorizedLead ? 'buyer' : 'none';
  const risk = input.policyGate.blockedReasons.length ||
    input.review.issues.some((issue) => issue.severity === 'high')
    ? 'high'
    : unknowns.length || input.answer.riskFlags.length
      ? 'medium'
      : 'low';
  const selectedAction = responseMode;
  const possibleActions = unique([
    'answer',
    'clarify',
    'recommend',
    'compare',
    'handoff',
    ...input.intent.toolRequests.map((request) => `execute:${request.tool}`),
    blockingUnknowns.length ? 'disclose_unconfirmed_gap' : 'commit_answer'
  ]).slice(0, 16);

  return DecisionArtifactSchema.parse({
    version: 1,
    loop: [...DECISION_LOOP_STAGES],
    goal: grounding?.taskType ?? 'unknown_task',
    knownFacts,
    unknowns,
    blockingUnknowns,
    possibleActions,
    selectedAction,
    risk,
    requiredConsent,
    stopCondition: requiredConsent !== 'none'
      ? 'stop_before_contact_capture_without_buyer_authorization'
      : blockingUnknowns.length
        ? 'stop_before_unqualified_claim_or_side_effect'
        : 'stop_after_validated_answer_commit',
    fallback: 'retain_confirmed_facts_and_disclose_unconfirmed_fields',
    rationale: [
      `task=${grounding?.taskType ?? 'unknown'}`,
      `source=${grounding?.sourcePolicy ?? 'unknown'}`,
      `response=${responseMode}`,
      `evidence=${knownFacts.length}`,
      `unknowns=${unknowns.length}`,
      `blockers=${blockingUnknowns.length}`,
      `policy=${input.policyGate.ok ? 'pass' : 'block'}`
    ].join('; ')
  });
}
