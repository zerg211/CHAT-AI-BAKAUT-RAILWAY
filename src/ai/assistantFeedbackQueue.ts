import { createHash } from 'node:crypto';
import { z } from 'zod';

const jsonObjectSchema = z.record(z.string(), z.unknown());
const nullableShortText = z.string().trim().min(1).max(300).nullable().optional();

export const AssistantFeedbackRatingSchema = z.enum(['negative', 'wrong_cards']);
export const AssistantFeedbackQueueStatusSchema = z.enum([
  'pending',
  'in_review',
  'exported',
  'resolved',
  'dismissed'
]);

export const AssistantFeedbackPolicyEvidenceSchema = z.object({
  version: nullableShortText,
  hash: nullableShortText,
  selectedRuleIds: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  reviewMode: nullableShortText,
  reviewReason: nullableShortText
}).strict();

export const AssistantFeedbackModelEvidenceSchema = z.object({
  plannerModel: nullableShortText,
  answerModel: nullableShortText,
  reviewerModel: nullableShortText,
  responseIds: z.array(z.string().trim().min(1).max(300)).max(20).default([])
}).strict();

export const AssistantFeedbackToolEvidenceSchema = z.object({
  requestId: z.string().trim().min(1).max(300),
  tool: z.string().trim().min(1).max(120),
  status: z.enum(['ok', 'denied', 'not_found', 'error', 'timeout']),
  warnings: z.array(z.string().max(1000)).max(100).default([]),
  payload: jsonObjectSchema.optional()
}).strict();

export const AssistantFeedbackCardEvidenceSchema = z.object({
  productId: z.string().trim().min(1).max(300),
  name: z.string().trim().min(1).max(1000),
  position: z.number().int().nonnegative(),
  price: z.number().nonnegative().nullable().optional(),
  currency: z.string().trim().min(1).max(20).nullable().optional(),
  visible: z.boolean().default(true),
  sourceUrl: z.string().max(3000).nullable().optional()
}).strict();

export const AssistantFeedbackQueueItemSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  turnId: z.string().uuid(),
  userMessageId: z.string().uuid().nullable().optional(),
  assistantMessageId: z.string().uuid(),
  rating: AssistantFeedbackRatingSchema,
  status: AssistantFeedbackQueueStatusSchema,
  buyerMessage: z.string().trim().min(1).max(20_000),
  assistantAnswer: z.string().trim().min(1).max(40_000),
  policyEvidence: AssistantFeedbackPolicyEvidenceSchema,
  modelEvidence: AssistantFeedbackModelEvidenceSchema,
  toolEvidence: z.array(AssistantFeedbackToolEvidenceSchema).max(100),
  cardEvidence: z.array(AssistantFeedbackCardEvidenceSchema).max(100),
  diagnosticMetadata: jsonObjectSchema.default({}),
  feedbackCreatedAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true })
}).strict();

const RedactionKindSchema = z.enum(['known_value', 'email', 'phone', 'url']);

const ExportedPolicyEvidenceSchema = z.object({
  version: nullableShortText,
  hash: nullableShortText,
  selectedRuleIds: z.array(z.string().max(200)).max(100),
  reviewMode: nullableShortText,
  reviewReason: nullableShortText
}).strict();

const ExportedModelEvidenceSchema = z.object({
  plannerModel: nullableShortText,
  answerModel: nullableShortText,
  reviewerModel: nullableShortText
}).strict();

const ExportedToolEvidenceSchema = AssistantFeedbackToolEvidenceSchema.omit({ payload: true });
const ExportedCardEvidenceSchema = AssistantFeedbackCardEvidenceSchema.omit({ sourceUrl: true });

export const AssistantFeedbackRegressionFixtureSchema = z.object({
  schemaVersion: z.literal('assistant-feedback-regression-v2'),
  caseId: z.string().min(1).max(80),
  source: z.object({
    rating: AssistantFeedbackRatingSchema,
    feedbackCreatedAt: z.string().datetime({ offset: true }),
    sourceFingerprint: z.string().length(32)
  }).strict(),
  input: z.object({
    buyerMessage: z.string().min(1).max(20_000)
  }).strict(),
  observed: z.object({
    assistantAnswer: z.string().min(1).max(40_000),
    productCards: z.array(ExportedCardEvidenceSchema).max(100)
  }).strict(),
  runtime: z.object({
    policy: ExportedPolicyEvidenceSchema,
    model: ExportedModelEvidenceSchema,
    tools: z.array(ExportedToolEvidenceSchema).max(100)
  }).strict(),
  review: z.object({
    focus: z.enum(['answer_quality_and_grounding', 'card_relevance_and_constraints']),
    expectedChecks: z.array(z.string().min(1).max(300)).min(1).max(20),
    requiresHumanReview: z.literal(true)
  }).strict(),
  redaction: z.object({
    applied: z.array(RedactionKindSchema),
    knownPiiValueCount: z.number().int().nonnegative(),
    rawDatabaseIdentifiersOmitted: z.literal(true),
    residualPiiStatus: z.literal('best_effort_redaction_not_verified'),
    residualPiiReviewRequired: z.literal(true)
  }).strict()
}).strict();

export type AssistantFeedbackRating = z.infer<typeof AssistantFeedbackRatingSchema>;
export type AssistantFeedbackQueueStatus = z.infer<typeof AssistantFeedbackQueueStatusSchema>;
export type AssistantFeedbackQueueItem = z.infer<typeof AssistantFeedbackQueueItemSchema>;
export type AssistantFeedbackRegressionFixture = z.infer<typeof AssistantFeedbackRegressionFixtureSchema>;
export type FeedbackRedactionKind = z.infer<typeof RedactionKindSchema>;

export interface FeedbackRedactionResult {
  text: string;
  applied: FeedbackRedactionKind[];
}

function isWhitespace(value: string) {
  return value === ' ' || value === '\n' || value === '\r' || value === '\t';
}

function isAsciiDigit(value: string) {
  const code = value.codePointAt(0) ?? 0;
  return code >= 48 && code <= 57;
}

function isEmailBoundary(value: string) {
  return isWhitespace(value) || '<>()[]{},;:\"\''.includes(value) || value === '/';
}

function startsWithInsensitive(value: string, index: number, prefix: string) {
  return value.slice(index, index + prefix.length).toLocaleLowerCase('en-US') === prefix;
}

function replaceInsensitive(value: string, needle: string, replacement: string) {
  const normalizedNeedle = needle.toLocaleLowerCase('ru-RU');
  const normalizedValue = value.toLocaleLowerCase('ru-RU');
  let cursor = 0;
  let count = 0;
  let output = '';
  while (cursor < value.length) {
    const foundAt = normalizedValue.indexOf(normalizedNeedle, cursor);
    if (foundAt < 0) {
      output += value.slice(cursor);
      break;
    }
    output += value.slice(cursor, foundAt) + replacement;
    cursor = foundAt + needle.length;
    count += 1;
  }
  return { text: output, count };
}

function normalizedSensitiveKey(value: string) {
  return [...value.toLocaleLowerCase('en-US')]
    .filter((character) => character !== '_' && character !== '-' && character !== ' ')
    .join('');
}

const directSensitiveKeys = new Set([
  'name',
  'customername',
  'contactname',
  'phone',
  'telephone',
  'email',
  'address'
]);

const sensitiveObjectKeys = new Set([
  'contact',
  'customer',
  'lead',
  'person',
  'pii'
]);

function collectSensitiveValues(
  value: unknown,
  output: Set<string>,
  inheritedSensitive = false,
  depth = 0
) {
  if (depth > 5 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    const candidate = value.trim();
    if (inheritedSensitive && candidate.length >= 2 && candidate.length <= 500) output.add(candidate);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) collectSensitiveValues(item, output, inheritedSensitive, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
    const normalizedKey = normalizedSensitiveKey(key);
    const sensitive = inheritedSensitive || directSensitiveKeys.has(normalizedKey) || sensitiveObjectKeys.has(normalizedKey);
    collectSensitiveValues(item, output, sensitive, depth + 1);
  }
}

export function knownPiiValuesForFeedback(item: AssistantFeedbackQueueItem) {
  const values = new Set<string>();
  collectSensitiveValues(item.diagnosticMetadata, values);
  for (const tool of item.toolEvidence) collectSensitiveValues(tool.payload, values);
  return [...values];
}

function redactKnownValues(value: string, knownPiiValues: string[]) {
  const values = [...new Set(knownPiiValues.map((item) => item.trim()).filter((item) => item.length >= 2))]
    .sort((left, right) => right.length - left.length);
  let text = value;
  let count = 0;
  for (const item of values) {
    const redacted = replaceInsensitive(text, item, '[PII]');
    text = redacted.text;
    count += redacted.count;
  }
  return { text, count };
}

function redactUrls(value: string) {
  let output = '';
  let index = 0;
  let count = 0;
  while (index < value.length) {
    const prefixLength = startsWithInsensitive(value, index, 'https://')
      ? 8
      : startsWithInsensitive(value, index, 'http://')
        ? 7
        : 0;
    if (!prefixLength) {
      output += value[index];
      index += 1;
      continue;
    }
    let end = index + prefixLength;
    while (end < value.length && !isWhitespace(value[end])) end += 1;
    output += '[URL]';
    index = end;
    count += 1;
  }
  return { text: output, count };
}

function redactEmails(value: string) {
  let output = '';
  let cursor = 0;
  let searchFrom = 0;
  let count = 0;
  while (searchFrom < value.length) {
    const at = value.indexOf('@', searchFrom);
    if (at < 0) break;
    let start = at;
    while (start > cursor && !isEmailBoundary(value[start - 1])) start -= 1;
    let end = at + 1;
    while (end < value.length && !isEmailBoundary(value[end])) end += 1;
    if (start < at && end > at + 1) {
      output += value.slice(cursor, start) + '[EMAIL]';
      cursor = end;
      searchFrom = end;
      count += 1;
    } else {
      searchFrom = at + 1;
    }
  }
  output += value.slice(cursor);
  return { text: output, count };
}

function isPhoneRunChar(value: string) {
  return isAsciiDigit(value) || value === '+' || value === '-' || value === '(' || value === ')' || value === '.' || isWhitespace(value);
}

function redactPhones(value: string) {
  let output = '';
  let index = 0;
  let count = 0;
  while (index < value.length) {
    if (!isAsciiDigit(value[index]) && value[index] !== '+') {
      output += value[index];
      index += 1;
      continue;
    }
    let end = index;
    let digitCount = 0;
    let lastDigitEnd = index;
    while (end < value.length && isPhoneRunChar(value[end])) {
      if (isAsciiDigit(value[end])) {
        digitCount += 1;
        lastDigitEnd = end + 1;
      }
      end += 1;
    }
    if (digitCount >= 7) {
      output += '[PHONE]';
      index = lastDigitEnd;
      count += 1;
    } else {
      output += value.slice(index, end);
      index = end;
    }
  }
  return { text: output, count };
}

export function redactFeedbackText(value: string, knownPiiValues: string[] = []): FeedbackRedactionResult {
  const applied = new Set<FeedbackRedactionKind>();
  const known = redactKnownValues(value, knownPiiValues);
  if (known.count) applied.add('known_value');
  const urls = redactUrls(known.text);
  if (urls.count) applied.add('url');
  const emails = redactEmails(urls.text);
  if (emails.count) applied.add('email');
  const phones = redactPhones(emails.text);
  if (phones.count) applied.add('phone');
  return { text: phones.text, applied: [...applied] };
}

function redactedStrings(values: string[], knownPiiValues: string[], applied: Set<FeedbackRedactionKind>) {
  return values.map((value) => {
    return redactedString(value, knownPiiValues, applied);
  });
}

function redactedString(value: string, knownPiiValues: string[], applied: Set<FeedbackRedactionKind>) {
  const redacted = redactFeedbackText(value, knownPiiValues);
  for (const kind of redacted.applied) applied.add(kind);
  return redacted.text;
}

function sourceFingerprint(input: AssistantFeedbackQueueItem) {
  return createHash('sha256')
    .update([input.id, input.sessionId, input.turnId, input.assistantMessageId].join(':'))
    .digest('hex')
    .slice(0, 32);
}

function reviewContract(rating: AssistantFeedbackRating) {
  if (rating === 'wrong_cards') {
    return {
      focus: 'card_relevance_and_constraints' as const,
      expectedChecks: [
        'Verify that every visible card satisfies the current hard buyer constraints.',
        'Verify that compromises are separated and explained instead of mixed with suitable products.',
        'Verify that answer text and the visible card set describe the same recommendation.'
      ]
    };
  }
  return {
    focus: 'answer_quality_and_grounding' as const,
    expectedChecks: [
      'Verify that the answer addresses the current buyer request and dialogue context.',
      'Verify that factual claims are grounded in current ledger, catalog, web, or tool evidence.',
      'Verify that the answer does not promise unverified commercial conditions.'
    ]
  };
}

export function buildAssistantFeedbackRegressionCandidate(
  rawItem: AssistantFeedbackQueueItem,
  options: { knownPiiValues?: string[] } = {}
): AssistantFeedbackRegressionFixture {
  const item = AssistantFeedbackQueueItemSchema.parse(rawItem);
  const knownPiiValues = options.knownPiiValues ?? [];
  const applied = new Set<FeedbackRedactionKind>();
  const buyerMessage = redactFeedbackText(item.buyerMessage, knownPiiValues);
  const assistantAnswer = redactFeedbackText(item.assistantAnswer, knownPiiValues);
  for (const kind of [...buyerMessage.applied, ...assistantAnswer.applied]) applied.add(kind);
  const policy = {
    ...item.policyEvidence,
    selectedRuleIds: redactedStrings(item.policyEvidence.selectedRuleIds, knownPiiValues, applied)
  };
  const tools = item.toolEvidence.map(({ payload: _payload, ...tool }) => ({
    ...tool,
    requestId: redactedString(tool.requestId, knownPiiValues, applied),
    warnings: redactedStrings(tool.warnings, knownPiiValues, applied)
  }));
  const cards = item.cardEvidence.map(({ sourceUrl: _sourceUrl, ...card }) => ({
    ...card,
    name: redactedString(card.name, knownPiiValues, applied)
  }));
  const fingerprint = sourceFingerprint(item);
  const review = reviewContract(item.rating);

  return AssistantFeedbackRegressionFixtureSchema.parse({
    schemaVersion: 'assistant-feedback-regression-v2',
    caseId: `feedback-${fingerprint.slice(0, 16)}`,
    source: {
      rating: item.rating,
      feedbackCreatedAt: item.feedbackCreatedAt,
      sourceFingerprint: fingerprint
    },
    input: { buyerMessage: buyerMessage.text },
    observed: {
      assistantAnswer: assistantAnswer.text,
      productCards: cards
    },
    runtime: {
      policy,
      model: {
        plannerModel: item.modelEvidence.plannerModel,
        answerModel: item.modelEvidence.answerModel,
        reviewerModel: item.modelEvidence.reviewerModel
      },
      tools
    },
    review: {
      ...review,
      requiresHumanReview: true
    },
    redaction: {
      applied: [...applied],
      knownPiiValueCount: knownPiiValues.filter((value) => value.trim().length >= 2).length,
      rawDatabaseIdentifiersOmitted: true,
      residualPiiStatus: 'best_effort_redaction_not_verified',
      residualPiiReviewRequired: true
    }
  });
}

export function serializeAssistantFeedbackRegressionCandidates(
  fixtures: AssistantFeedbackRegressionFixture[]
) {
  return JSON.stringify(fixtures.map((fixture) => AssistantFeedbackRegressionFixtureSchema.parse(fixture)), null, 2);
}
