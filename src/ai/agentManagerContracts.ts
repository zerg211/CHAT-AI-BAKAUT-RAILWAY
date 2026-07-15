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

export const AgentManagerToolNameSchema = z.enum([
  'catalog.search',
  'catalog.getProductDetails',
  'calculator.generatorLoad',
  'web.researchProductFacts',
  'lead.capture'
]);

const canonicalProductClassSchema = z.enum([
  'generator',
  'weldingGenerator',
  'generatorOil',
  'engineOil',
  'generatorAccessory',
  'plateAccessory',
  'plate',
  'rammer',
  'roller',
  'cutter',
  'diamondBlade',
  'diamondCore',
  'trowel',
  'unknown'
]);
const productClassSchema = z.string().trim().min(1).max(120);
const optionalPlaceholder = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => value === null ? undefined : value, schema.optional());
const optionalText = optionalPlaceholder(nonEmptyString);
const optionalProductClass = optionalPlaceholder(productClassSchema);
const optionalCanonicalProductClass = optionalPlaceholder(canonicalProductClassSchema);
const optionalPowerSource = optionalPlaceholder(z.enum(['battery', 'fuel', 'mains', 'any']));
const optionalPhase = optionalPlaceholder(z.enum(['single_phase', 'three_phase', 'any']));
const optionalPositiveLimit = (max: number) => optionalPlaceholder(z.number().int().min(1).max(max));
const stringList = (max: number) => z.array(nonEmptyString).max(max).optional();

export const CatalogSearchToolArgsSchema = z.object({
  query: optionalText,
  semanticQuery: optionalText,
  productIntent: optionalProductClass,
  canonicalProductIntent: optionalCanonicalProductClass,
  powerSource: optionalPowerSource,
  phase: optionalPhase,
  limit: optionalPositiveLimit(12),
  comparisonAttributes: stringList(12),
  reason: optionalText,
  notes: optionalText
}).strict();

export const ProductDetailsToolArgsSchema = z.object({
  query: optionalText,
  semanticQuery: optionalText,
  productIntent: optionalProductClass,
  canonicalProductIntent: optionalCanonicalProductClass,
  powerSource: optionalPowerSource,
  phase: optionalPhase,
  productIds: stringList(8),
  productNames: stringList(4),
  comparisonAttributes: stringList(12),
  limit: optionalPositiveLimit(12),
  reason: optionalText,
  notes: optionalText
}).strict();

const generatorLoadItemSchema = z.object({
  kind: optionalText,
  name: optionalText,
  count: optionalPlaceholder(z.number().positive()),
  runningKw: optionalPlaceholder(z.number().nonnegative()),
  startingKw: optionalPlaceholder(z.number().nonnegative()),
  source: optionalPlaceholder(z.enum(['explicit_user', 'estimated_average', 'catalog_fact', 'web_average'])),
  evidence: optionalText,
  basisKind: optionalPlaceholder(z.enum(['exact_power', 'checked_fact', 'specific_type_or_function', 'generic_load_name', 'unknown'])),
  basisSignals: z.array(z.enum([
    'consumer_type_known',
    'consumer_function_known',
    'voltage_or_phase_known',
    'usage_scope_known',
    'simultaneous_operation_known',
    'buyer_requested_approximation',
    'catalog_or_web_fact',
    'explicit_power'
  ])).max(8).optional()
}).strict();

export const GeneratorLoadToolArgsSchema = z.object({
  query: optionalText,
  semanticQuery: optionalText,
  productIntent: optionalProductClass,
  canonicalProductIntent: optionalCanonicalProductClass,
  powerSource: optionalPowerSource,
  phase: optionalPhase,
  loads: z.array(generatorLoadItemSchema).max(24),
  simultaneousStarting: optionalPlaceholder(z.boolean()),
  simultaneousStartingKinds: stringList(24),
  estimateBasis: optionalPlaceholder(z.enum(['exact_or_user_provided', 'catalog_or_web_fact', 'bounded_assumption', 'unbounded_guess'])),
  reason: optionalText,
  notes: optionalText
}).strict();

export const WebResearchToolArgsSchema = z.object({
  query: optionalText,
  semanticQuery: optionalText,
  productIntent: optionalProductClass,
  canonicalProductIntent: optionalCanonicalProductClass,
  powerSource: optionalPowerSource,
  phase: optionalPhase,
  productNames: stringList(4),
  comparisonAttributes: stringList(12),
  limit: optionalPositiveLimit(12),
  reason: optionalText,
  notes: optionalText
}).strict();

const leadContactSchema = z.object({
  name: optionalText,
  phone: optionalText,
  email: optionalText,
  preferredContact: optionalPlaceholder(z.enum(['message', 'call'])),
  comment: optionalText
}).strict();

export const LeadCaptureToolArgsSchema = z.object({
  contact: z.preprocess((value) => value === null ? undefined : value, leadContactSchema.optional()),
  reason: optionalText,
  notes: optionalText
}).strict();

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

const toolRequestFields = {
  id: nonEmptyString,
  rationale: nonEmptyString,
  required: z.boolean().default(true),
  coversRequirementIds: z.array(nonEmptyString).max(40).optional()
};

export const ToolRequestSchema = z.discriminatedUnion('tool', [
  z.object({ ...toolRequestFields, tool: z.literal('catalog.search'), args: CatalogSearchToolArgsSchema }).strict(),
  z.object({ ...toolRequestFields, tool: z.literal('catalog.getProductDetails'), args: ProductDetailsToolArgsSchema }).strict(),
  z.object({ ...toolRequestFields, tool: z.literal('calculator.generatorLoad'), args: GeneratorLoadToolArgsSchema }).strict(),
  z.object({ ...toolRequestFields, tool: z.literal('web.researchProductFacts'), args: WebResearchToolArgsSchema }).strict(),
  z.object({ ...toolRequestFields, tool: z.literal('lead.capture'), args: LeadCaptureToolArgsSchema }).strict()
]);

export interface ToolRequestArgs {
  query?: string | null;
  semanticQuery?: string | null;
  productIntent?: string | null;
  canonicalProductIntent?: z.infer<typeof canonicalProductClassSchema> | null;
  powerSource?: 'battery' | 'fuel' | 'mains' | 'any' | null;
  phase?: 'single_phase' | 'three_phase' | 'any' | null;
  limit?: number | null;
  productIds?: string[];
  productNames?: string[];
  comparisonAttributes?: string[];
  loads?: unknown[];
  simultaneousStarting?: boolean | null;
  simultaneousStartingKinds?: string[];
  estimateBasis?: 'exact_or_user_provided' | 'catalog_or_web_fact' | 'bounded_assumption' | 'unbounded_guess' | null;
  contact?: {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    preferredContact?: 'message' | 'call' | null;
    comment?: string | null;
  } | null;
  reason?: string | null;
  notes?: string | null;
}

export const ToolResultSchema = z.object({
  requestId: nonEmptyString,
  tool: AgentManagerToolNameSchema,
  status: z.enum(['ok', 'denied', 'not_found', 'error', 'timeout']),
  payload: jsonObject,
  warnings: z.array(z.string()).default([]),
  errorCode: z.string().optional()
}).strict();

export const ProductMentionRoleSchema = z.enum([
  'target_product',
  'catalog_candidate',
  'comparison_subject',
  'context_load_device',
  'compatibility_context',
  'mentioned_only'
]);

export const ProductMentionSchema = z.object({
  name: nonEmptyString,
  role: ProductMentionRoleSchema,
  productClass: z.string().trim().min(1).nullable().optional(),
  evidence: nonEmptyString
}).strict();

export const SelectionRequirementVerificationSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('product_attribute')
  }).strict(),
  z.object({
    mode: z.literal('typed_tool'),
    toolRequestId: nonEmptyString,
    tool: AgentManagerToolNameSchema,
    verifier: nonEmptyString,
    bindAs: nonEmptyString
  }).strict()
]);

export const SelectionRequirementSchema = z.object({
  id: nonEmptyString,
  kind: nonEmptyString,
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  unit: z.string().trim().min(1).nullable(),
  relation: z.enum([
    'must_have',
    'must_not_have',
    'preferred',
    'not_required',
    'context'
  ]).optional(),
  role: z.enum(['hard_constraint', 'preference', 'context', 'mentioned_only']),
  strictness: z.enum(['strict', 'preferred', 'informational']),
  evidence: nonEmptyString,
  verification: SelectionRequirementVerificationSchema.optional()
}).strict();

export const AgentSelectionPolicySchema = z.object({
  targetProductClass: nonEmptyString.nullable(),
  canonicalProductClass: canonicalProductClassSchema.nullable(),
  selectionGoal: z.enum(['browse_catalog', 'preliminary_fit', 'final_fit']).optional(),
  needAction: z.enum(['continue', 'open', 'switch', 'resume', 'close', 'none']),
  alternativePolicy: z.enum([
    'exact_only',
    'same_class_only',
    'allow_adjacent_with_explanation',
    'open_to_alternatives',
    'unknown'
  ]),
  reusePreviousCards: z.boolean(),
  maxCards: z.number().int().min(0).max(8).nullable(),
  powerSource: z.enum(['battery', 'fuel', 'mains', 'any']).nullable(),
  phase: z.enum(['single_phase', 'three_phase', 'any']).nullable(),
  requirements: z.array(SelectionRequirementSchema).max(40),
  rationale: nonEmptyString
}).strict();

export const LeadCaptureAuthorizationSchema = z.object({
  authorized: z.boolean(),
  contactSource: z.enum(['current_message', 'existing_session', 'pending_draft', 'none']),
  purpose: nonEmptyString.nullable(),
  buyerQuestion: nonEmptyString.nullable().optional(),
  evidence: nonEmptyString.nullable(),
  pendingDraftId: z.string().uuid().nullable().optional()
}).strict().superRefine((authorization, context) => {
  if (authorization.authorized) {
    if (authorization.contactSource === 'none') {
      context.addIssue({ code: 'custom', path: ['contactSource'], message: 'authorized lead requires a contact source' });
    }
    if (!authorization.purpose) {
      context.addIssue({ code: 'custom', path: ['purpose'], message: 'authorized lead requires a purpose' });
    }
    if (!authorization.buyerQuestion) {
      context.addIssue({ code: 'custom', path: ['buyerQuestion'], message: 'authorized lead requires a grounded buyer question' });
    }
    if (!authorization.evidence) {
      context.addIssue({ code: 'custom', path: ['evidence'], message: 'authorized lead requires current-message evidence' });
    }
    if (authorization.contactSource === 'pending_draft' && !authorization.pendingDraftId) {
      context.addIssue({ code: 'custom', path: ['pendingDraftId'], message: 'pending draft authorization requires its draft id' });
    }
    if (authorization.contactSource !== 'pending_draft' && authorization.pendingDraftId) {
      context.addIssue({ code: 'custom', path: ['pendingDraftId'], message: 'only pending draft authorization may carry a draft id' });
    }
  } else if (
    authorization.contactSource !== 'none' ||
    authorization.purpose !== null ||
    authorization.buyerQuestion != null ||
    authorization.evidence !== null ||
    authorization.pendingDraftId != null
  ) {
    context.addIssue({ code: 'custom', message: 'unauthorized lead must not carry contact source, purpose, buyer question, evidence, or draft id' });
  }
});

export const AgentIntentGroundingSchema = z.object({
  taskType: z.enum([
    'technical_answer',
    'product_selection',
    'comparison',
    'availability_or_delivery',
    'lead_handoff',
    'offtopic'
  ]),
  sourcePolicy: z.enum([
    'conversation_only',
    'catalog_required',
    'web_required',
    'specialist_required'
  ]),
  webPurpose: z.enum([
    'technical_specs',
    'manual_or_service',
    'current_lineup',
    'none'
  ]),
  requiredToolKinds: z.array(AgentManagerToolNameSchema).default([]),
  technicalAttributes: z.array(nonEmptyString).default([]),
  rationale: nonEmptyString
}).strict();

const defaultAgentIntentGrounding: z.infer<typeof AgentIntentGroundingSchema> = {
  taskType: 'technical_answer',
  sourcePolicy: 'conversation_only',
  webPurpose: 'none',
  requiredToolKinds: [],
  technicalAttributes: [],
  rationale: 'Planner did not provide an explicit grounding policy; preserve legacy toolRequests behavior.'
};

export const AgentIntentContractSchema = z.object({
  turnId: z.string().nullable().optional(),
  userMessageSummary: nonEmptyString,
  dialogueUnderstanding: nonEmptyString,
  nextStepRationale: nonEmptyString,
  requiresTools: z.boolean(),
  toolRequests: z.array(ToolRequestSchema).default([]),
  grounding: AgentIntentGroundingSchema.default(defaultAgentIntentGrounding),
  productMentions: z.array(ProductMentionSchema).default([]),
  selectionPolicy: AgentSelectionPolicySchema.optional(),
  leadCaptureAuthorization: LeadCaptureAuthorizationSchema.optional(),
  policyRuleIds: z.array(nonEmptyString).default([]),
  mustNotAskQuestionIds: z.array(z.string()).default([]),
  riskFlags: z.array(z.string()).default([])
}).strict();

export const AnswerSelectionReadinessSchema = z.object({
  productClass: nonEmptyString,
  status: z.enum([
    'not_applicable',
    'needs_more_info',
    'ready_for_preliminary_cards',
    'ready_for_exact_cards'
  ]),
  canShowProductCards: z.boolean(),
  missingFacts: z.array(nonEmptyString).default([]),
  rationale: nonEmptyString
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
  selectedProductIds: z.array(nonEmptyString).max(8).optional(),
  leadAction: z.enum(['none', 'offer_form', 'capture_contact', 'confirm_contact_received']).default('none'),
  riskFlags: z.array(z.string()).default([]),
  selectionReadiness: AnswerSelectionReadinessSchema.optional()
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
type ParsedToolRequest = z.infer<typeof ToolRequestSchema>;
export type ToolRequest = Omit<ParsedToolRequest, 'args'> & { args: ToolRequestArgs };
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type ProductMentionRole = z.infer<typeof ProductMentionRoleSchema>;
export type ProductMention = z.infer<typeof ProductMentionSchema>;
export type SelectionRequirement = z.infer<typeof SelectionRequirementSchema>;
export type AgentSelectionPolicy = z.infer<typeof AgentSelectionPolicySchema>;
export type LeadCaptureAuthorization = z.infer<typeof LeadCaptureAuthorizationSchema>;
export type AgentIntentGrounding = z.infer<typeof AgentIntentGroundingSchema>;
type ParsedAgentIntentContract = z.infer<typeof AgentIntentContractSchema>;
export type AgentIntentContract = Omit<ParsedAgentIntentContract, 'toolRequests' | 'productMentions' | 'grounding' | 'policyRuleIds' | 'selectionPolicy' | 'leadCaptureAuthorization'> & {
  toolRequests: ToolRequest[];
  productMentions?: ProductMention[];
  grounding?: AgentIntentGrounding;
  policyRuleIds?: string[];
  selectionPolicy?: AgentSelectionPolicy;
  leadCaptureAuthorization?: LeadCaptureAuthorization;
};
export type AnswerContract = z.infer<typeof AnswerContractSchema>;
export type AnswerSelectionReadiness = z.infer<typeof AnswerSelectionReadinessSchema>;
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
