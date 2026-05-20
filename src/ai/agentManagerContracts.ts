import { createHash } from 'node:crypto';
import { z } from 'zod';

export const dialogueLedgerEventTypes = [
  'fact.observed',
  'fact.confirmed',
  'fact.superseded',
  'fact.negated',
  'question.asked',
  'question.answered',
  'question.closed',
  'need.opened',
  'need.updated',
  'need.closed',
  'tool.artifact.linked'
] as const;

export const dialogueLedgerScopes = ['dialogue', 'turn', 'need', 'product', 'lead', 'tool', 'question'] as const;
export const dialogueLedgerSources = ['llm_state_delta', 'tool_result', 'system_reducer', 'admin_curation', 'catalog', 'web'] as const;
export const dialogueLedgerStatuses = ['active', 'superseded', 'negated', 'closed', 'rejected'] as const;

const nonEmptyString = z.string().trim().min(1);
const jsonObject = z.record(z.string(), z.unknown());

export const DialogueLedgerEventSchema = z.object({
  id: z.string().uuid().optional(),
  sessionId: z.string().uuid(),
  turnId: z.string().uuid(),
  eventId: nonEmptyString,
  eventType: z.enum(dialogueLedgerEventTypes),
  scope: z.enum(dialogueLedgerScopes),
  payload: jsonObject,
  evidence: nonEmptyString,
  source: z.enum(dialogueLedgerSources),
  status: z.enum(dialogueLedgerStatuses),
  createdAt: z.string().optional()
}).strict();

export const LedgerStateDeltaEventSchema = DialogueLedgerEventSchema.omit({
  id: true,
  sessionId: true,
  turnId: true,
  eventId: true,
  createdAt: true
}).extend({
  eventId: nonEmptyString.nullable().optional()
}).strict();

export const LedgerStateDeltaSchema = z.object({
  rationale: nonEmptyString,
  events: z.array(LedgerStateDeltaEventSchema).max(40)
}).strict();

export const ToolRequestSchema = z.object({
  id: nonEmptyString,
  tool: z.enum([
    'catalog.search',
    'catalog.getProductDetails',
    'calculator.generatorLoad',
    'web.researchProductFacts',
    'lead.capture'
  ]),
  args: jsonObject,
  rationale: nonEmptyString,
  required: z.boolean().default(true)
}).strict();

export const ToolResultSchema = z.object({
  requestId: nonEmptyString,
  tool: ToolRequestSchema.shape.tool,
  status: z.enum(['ok', 'denied', 'not_found', 'error', 'timeout']),
  payload: jsonObject,
  warnings: z.array(z.string()).default([]),
  errorCode: z.string().optional()
}).strict();

export const AgentIntentContractSchema = z.object({
  turnId: z.string().uuid().nullable().optional(),
  userMessageSummary: nonEmptyString,
  dialogueUnderstanding: nonEmptyString,
  nextStepRationale: nonEmptyString,
  requiresTools: z.boolean(),
  toolRequests: z.array(ToolRequestSchema).default([]),
  mustNotAskQuestionIds: z.array(z.string()).default([]),
  riskFlags: z.array(z.string()).default([])
}).strict();

export const AnswerContractSchema = z.object({
  answerText: nonEmptyString,
  factsUsed: z.array(z.object({
    factKey: nonEmptyString,
    sourceEventIds: z.array(nonEmptyString).min(1),
    value: z.unknown()
  }).strict()).default([]),
  questionsAsked: z.array(z.object({
    questionId: nonEmptyString,
    text: nonEmptyString,
    reason: nonEmptyString
  }).strict()).default([]),
  toolResultIds: z.array(nonEmptyString).default([]),
  leadAction: z.enum(['none', 'offer_form', 'capture_contact', 'confirm_contact_received']).default('none'),
  riskFlags: z.array(z.string()).default([])
}).strict();

export const PreSendReviewSchema = z.object({
  verdict: z.enum(['pass', 'rewrite_required', 'block']),
  issues: z.array(z.object({
    code: nonEmptyString,
    severity: z.enum(['low', 'medium', 'high']),
    message: nonEmptyString,
    evidence: nonEmptyString
  }).strict()).default([]),
  revisedAnswerText: z.string().nullable().optional()
}).strict();

export type DialogueLedgerEvent = z.infer<typeof DialogueLedgerEventSchema>;
export type LedgerStateDelta = z.infer<typeof LedgerStateDeltaSchema>;
export type ToolRequest = z.infer<typeof ToolRequestSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type AgentIntentContract = z.infer<typeof AgentIntentContractSchema>;
export type AnswerContract = z.infer<typeof AnswerContractSchema>;
export type PreSendReview = z.infer<typeof PreSendReviewSchema>;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function createStableLedgerEventId(input: Omit<DialogueLedgerEvent, 'id' | 'eventId' | 'createdAt'>) {
  const hash = createHash('sha256')
    .update(stableJson({
      sessionId: input.sessionId,
      turnId: input.turnId,
      eventType: input.eventType,
      scope: input.scope,
      payload: input.payload,
      evidence: input.evidence,
      source: input.source,
      status: input.status
    }))
    .digest('hex')
    .slice(0, 32);
  return `${input.eventType}:${hash}`;
}

export function normalizeLedgerStateDeltaEvents(input: {
  sessionId: string;
  turnId: string;
  delta: LedgerStateDelta;
}): DialogueLedgerEvent[] {
  return input.delta.events.map((event) => {
    const eventWithoutId = {
      sessionId: input.sessionId,
      turnId: input.turnId,
      eventType: event.eventType,
      scope: event.scope,
      payload: event.payload,
      evidence: event.evidence,
      source: event.source,
      status: event.status
    };
    return DialogueLedgerEventSchema.parse({
      ...eventWithoutId,
      eventId: createStableLedgerEventId(eventWithoutId)
    });
  });
}
