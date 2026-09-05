import {
  DialogueLedgerEventSchema,
  SelectionRankingObjectiveSchema,
  dialogueLedgerScopes,
  normalizeLedgerStateDeltaEvents,
  type DialogueLedgerEvent,
  type LedgerStateDelta,
  type SelectionRequirement,
  type SelectionRankingObjective
} from './agentManagerContracts.js';
import { z } from 'zod';
import { emptyNeedState, emptyProductSelectionState } from './needState.js';
import type {
  ActiveCustomerNeed,
  ActiveNeedStatus,
  CustomerNeedState,
  NeedItem,
  ProductSelectionClass
} from '../shared/types.js';

export type ReducedRequirementRole = 'hard_requirement' | 'preference' | 'context' | 'commercial' | 'unknown';

export interface ReducedFact {
  factKey: string;
  value: unknown;
  eventId: string;
  eventType: 'fact.observed' | 'fact.confirmed';
  status: 'active' | 'superseded' | 'negated' | 'closed' | 'rejected';
  evidence: string;
  source: string;
  confidence: number;
  createdAt?: string;
  needId?: string;
  role: ReducedRequirementRole;
  productClass?: string;
  scope?: DialogueLedgerEvent['scope'];
  productId?: string;
  unit?: string;
  relation?: SelectionRequirement['relation'];
  ranking?: Pick<SelectionRankingObjective, 'attribute' | 'direction'> | null;
}

export interface ReducedQuestion {
  questionId: string;
  text: string;
  askedEventId: string;
  status: 'open' | 'answered' | 'closed';
  answer?: unknown;
  closedByEventId?: string;
  needId?: string;
}

export interface ReducedNeed {
  needId: string;
  productClass: string;
  summary: string;
  constraints: string[];
  constraintFactBindings?: Array<{ constraint: string; factKey: string }>;
  openQuestions: string[];
  selectedProductIds: string[];
  rejectedProductIds: string[];
  status: ActiveNeedStatus;
  eventId: string;
  updatedAt?: string;
}

export interface ReducedDialogueLedgerState {
  eventIds: string[];
  factsByKey: Record<string, ReducedFact>;
  questionsById: Record<string, ReducedQuestion>;
  needsById: Record<string, ReducedNeed>;
  openQuestions: ReducedQuestion[];
  warnings: string[];
}

const reducedFactSnapshotSchema = z.object({
  factKey: z.string().trim().min(1),
  value: z.unknown(),
  eventId: z.string().trim().min(1),
  eventType: z.enum(['fact.observed', 'fact.confirmed']),
  status: z.enum(['active', 'superseded', 'negated', 'closed', 'rejected']),
  evidence: z.string().trim().min(1),
  source: z.string().trim().min(1),
  confidence: z.number().min(0).max(1),
  createdAt: z.string().trim().min(1).optional(),
  needId: z.string().trim().min(1).optional(),
  role: z.enum(['hard_requirement', 'preference', 'context', 'commercial', 'unknown']),
  productClass: z.string().trim().min(1).optional(),
  scope: z.enum(dialogueLedgerScopes).optional(),
  productId: z.string().trim().min(1).optional(),
  unit: z.string().trim().min(1).optional(),
  relation: z.enum(['must_have', 'must_not_have', 'preferred', 'not_required', 'context']).optional(),
  ranking: SelectionRankingObjectiveSchema.omit({ requirementId: true }).nullable().optional()
}).passthrough();

const reducedQuestionSnapshotSchema = z.object({
  questionId: z.string().trim().min(1),
  text: z.string().trim().min(1),
  askedEventId: z.string().trim().min(1),
  status: z.enum(['open', 'answered', 'closed']),
  answer: z.unknown().optional(),
  closedByEventId: z.string().trim().min(1).optional(),
  needId: z.string().trim().min(1).optional()
}).passthrough();

const reducedNeedSnapshotSchema = z.object({
  needId: z.string().trim().min(1),
  productClass: z.string().trim().min(1),
  summary: z.string(),
  constraints: z.array(z.string()),
  constraintFactBindings: z.array(z.object({ constraint: z.string(), factKey: z.string() })).optional(),
  openQuestions: z.array(z.string()),
  selectedProductIds: z.array(z.string()),
  rejectedProductIds: z.array(z.string()),
  status: z.enum(['open', 'selected', 'paused', 'closed']),
  eventId: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1).optional()
}).passthrough();

const reducedDialogueLedgerSnapshotSchema = z.object({
  eventIds: z.array(z.string().trim().min(1)),
  factsByKey: z.record(z.string(), reducedFactSnapshotSchema),
  questionsById: z.record(z.string(), reducedQuestionSnapshotSchema),
  needsById: z.record(z.string(), reducedNeedSnapshotSchema).optional().default({}),
  openQuestions: z.array(reducedQuestionSnapshotSchema).optional().default([]),
  warnings: z.array(z.string()).optional().default([])
}).passthrough();

const knownProductClasses = new Set<ProductSelectionClass>([
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

function factValueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function factNeedItem(fact: ReducedFact, updatedAt: string): NeedItem {
  return {
    value: `${fact.factKey}: ${factValueText(fact.value)}`,
    evidence: fact.evidence,
    confidence: fact.confidence,
    updatedAt: fact.createdAt ?? updatedAt
  };
}

function stringPayload(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringListPayload(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function optionalStringListPayload(payload: Record<string, unknown>, key: string) {
  return Array.isArray(payload[key]) ? stringListPayload(payload, key) : undefined;
}

type NeedListUpdateMode = 'merge' | 'replace' | 'clear';

function needListUpdateMode(
  payload: Record<string, unknown>,
  key: string,
  warnings: string[]
): NeedListUpdateMode | undefined {
  const raw = payload[key];
  if (raw === undefined || raw === null) return undefined;
  if (raw === 'merge' || raw === 'replace' || raw === 'clear') return raw;
  warnings.push(`need_${key}_invalid`);
  return undefined;
}

function applyNeedListUpdate(input: {
  previous?: string[];
  next?: string[];
  mode?: NeedListUpdateMode;
  legacyNonEmptyMode: 'merge' | 'replace';
}) {
  const previous = input.previous ?? [];
  const next = input.next ?? [];
  if (input.mode === 'clear') return [];
  if (input.mode === 'replace') return [...new Set(next)];
  if (input.mode === 'merge') return [...new Set([...previous, ...next])];
  if (input.next === undefined || next.length === 0) return [...previous];
  return input.legacyNonEmptyMode === 'merge'
    ? [...new Set([...previous, ...next])]
    : [...new Set(next)];
}

function factConfidence(
  eventType: 'fact.observed' | 'fact.confirmed',
  payload: Record<string, unknown>,
  warnings: string[]
) {
  const raw = payload.confidence;
  const valid = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1;
  if (raw !== undefined && raw !== null && !valid) warnings.push('fact_confidence_invalid');
  const confidence = valid ? raw : eventType === 'fact.confirmed' ? 1 : 0.5;
  if (eventType === 'fact.observed' && confidence === 1) {
    warnings.push('observed_fact_confidence_downgraded');
    return 0.5;
  }
  return confidence;
}

function requirementRole(payload: Record<string, unknown>): ReducedRequirementRole {
  const role = payload.role;
  return role === 'hard_requirement' || role === 'preference' || role === 'context' || role === 'commercial'
    ? role
    : 'unknown';
}

function needStatus(value: unknown, fallback: ActiveNeedStatus): ActiveNeedStatus {
  return value === 'open' || value === 'selected' || value === 'paused' || value === 'closed'
    ? value
    : fallback;
}

function productClass(value: unknown, fallback: string = 'unknown') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function factMapKey(factKey: string, needId?: string, productId?: string) {
  if (productId) return JSON.stringify(['product', needId ?? null, productId, factKey]);
  return needId ? `${needId}::${factKey}` : factKey;
}

export function dialogueFactConstraintText(fact: Pick<ReducedFact, 'factKey' | 'value' | 'unit'>) {
  return `${fact.factKey}: ${factValueText(fact.value)}${fact.unit ? ` ${fact.unit}` : ''}`;
}

export function getActiveDialogueNeed(state: ReducedDialogueLedgerState) {
  const activeNeeds = Object.values(state.needsById).filter((need) => need.status === 'open' || need.status === 'selected');
  return activeNeeds.length === 1 ? activeNeeds[0] : undefined;
}

export function activeScopedDialogueLedgerFacts(state: ReducedDialogueLedgerState) {
  const activeFacts = Object.values(state.factsByKey).filter((fact) => fact.status === 'active');
  // Legacy event streams can contain scoped facts before need.opened. A unique
  // scope is recoverable; insertion order is never evidence for the current need.
  const legacyNeedIds = Object.keys(state.needsById).length === 0
    ? [...new Set(activeFacts.map((fact) => fact.needId).filter((needId): needId is string => Boolean(needId)))]
    : [];
  const currentNeedId = getActiveDialogueNeed(state)?.needId ?? (legacyNeedIds.length === 1 ? legacyNeedIds[0] : undefined);
  return activeFacts.filter((fact) => fact.needId
    ? fact.needId === currentNeedId
    : fact.scope === 'dialogue' || fact.scope === 'product');
}

function cloneInitialState(initial?: ReducedDialogueLedgerState): ReducedDialogueLedgerState {
  if (!initial) {
    return {
      eventIds: [],
      factsByKey: {},
      questionsById: {},
      needsById: {},
      openQuestions: [],
      warnings: []
    };
  }
  return {
    eventIds: [...initial.eventIds],
    factsByKey: Object.fromEntries(Object.entries(initial.factsByKey).map(([key, fact]) => [key, { ...fact }])),
    questionsById: Object.fromEntries(Object.entries(initial.questionsById).map(([key, question]) => [key, { ...question }])),
    needsById: Object.fromEntries(Object.entries(initial.needsById ?? {}).map(([key, need]) => [key, {
      ...need,
      constraints: [...need.constraints],
      ...(need.constraintFactBindings ? { constraintFactBindings: need.constraintFactBindings.map(binding => ({ ...binding })) } : {}),
      openQuestions: [...need.openQuestions],
      selectedProductIds: [...need.selectedProductIds],
      rejectedProductIds: [...need.rejectedProductIds]
    }])),
    openQuestions: [],
    warnings: [...initial.warnings]
  };
}

export function parseReducedDialogueLedgerState(value: unknown): ReducedDialogueLedgerState {
  const parsed = reducedDialogueLedgerSnapshotSchema.safeParse(value);
  if (!parsed.success) throw new Error('invalid_dialogue_ledger_snapshot');
  const state = parsed.data;
  // Old snapshots discarded product identity and scope. Full raw-event replay
  // is the only safe way to recover those fields and any overwritten facts.
  if (
    Object.values(state.factsByKey).some((fact) => fact.scope === undefined) ||
    Object.values(state.needsById).filter((need) => need.status === 'open' || need.status === 'selected').length > 1
  ) throw new Error('invalid_dialogue_ledger_snapshot');
  return cloneInitialState({
    eventIds: state.eventIds,
    factsByKey: state.factsByKey,
    questionsById: state.questionsById,
    needsById: state.needsById,
    openQuestions: [],
    warnings: state.warnings
  });
}

export function reduceDialogueLedger(
  events: DialogueLedgerEvent[],
  initialState?: ReducedDialogueLedgerState
): ReducedDialogueLedgerState {
  const initial = cloneInitialState(initialState);
  const seen = new Set(initial.eventIds);
  const eventIds = [...initial.eventIds];
  const factsByEventId = new Map<string, ReducedFact>();
  const factEventByKey = new Map<string, string>();
  const questionsById = initial.questionsById;
  const needsById = initial.needsById;
  const warnings = initial.warnings;

  for (const [key, fact] of Object.entries(initial.factsByKey)) {
    factsByEventId.set(fact.eventId, fact);
    factEventByKey.set(key, fact.eventId);
  }

  for (const rawEvent of events) {
    const parsed = DialogueLedgerEventSchema.safeParse(rawEvent);
    if (!parsed.success) {
      warnings.push('invalid_event_rejected');
      continue;
    }
    const event = parsed.data;
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    eventIds.push(event.eventId);

    for (const supersededId of stringListPayload(event.payload, 'supersedesEventIds')) {
      const fact = factsByEventId.get(supersededId);
      if (fact) fact.status = 'superseded';
    }
    for (const negatedId of stringListPayload(event.payload, 'negatesEventIds')) {
      const fact = factsByEventId.get(negatedId);
      if (fact) fact.status = 'negated';
    }

    if (event.eventType === 'need.opened' || event.eventType === 'need.updated') {
      const needId = stringPayload(event.payload, 'needId');
      if (!needId) {
        warnings.push('need_event_without_need_id');
        continue;
      }
      const previous = needsById[needId];
      const activate = event.payload.activate === true || (event.eventType === 'need.opened' && event.payload.activate !== false);
      const requestedStatus = needStatus(event.payload.status, activate ? 'open' : previous?.status ?? 'paused');
      const status = !activate && previous?.status !== 'open' && previous?.status !== 'selected' &&
        (requestedStatus === 'open' || requestedStatus === 'selected')
        ? previous?.status ?? 'paused'
        : requestedStatus;
      if (activate && (status === 'open' || status === 'selected')) {
        for (const need of Object.values(needsById)) {
          if (need.needId !== needId && (need.status === 'open' || need.status === 'selected')) {
            need.status = 'paused';
          }
        }
      }
      const constraints = optionalStringListPayload(event.payload, 'constraints');
      const openQuestions = optionalStringListPayload(event.payload, 'openQuestions');
      const selectedProductIds = optionalStringListPayload(event.payload, 'selectedProductIds');
      const rejectedProductIds = optionalStringListPayload(event.payload, 'rejectedProductIds');
      const constraintsUpdateMode = needListUpdateMode(event.payload, 'constraintsUpdateMode', warnings);
      const openQuestionsUpdateMode = needListUpdateMode(event.payload, 'openQuestionsUpdateMode', warnings);
      const rejectedProductIdsUpdateMode = needListUpdateMode(
        event.payload,
        'rejectedProductIdsUpdateMode',
        warnings
      );
      const invalidatedProductIds = optionalStringListPayload(event.payload, 'invalidatedProductIds') ?? [];
      const rawSelectionUpdateMode = stringPayload(event.payload, 'selectionUpdateMode');
      const selectionUpdateMode = rawSelectionUpdateMode === 'preserve' ||
        rawSelectionUpdateMode === 'replace' ||
        rawSelectionUpdateMode === 'clear'
        ? rawSelectionUpdateMode
        : undefined;
      if (rawSelectionUpdateMode && !selectionUpdateMode) warnings.push('need_selection_update_mode_invalid');
      const effectiveRejectedProductIds = applyNeedListUpdate({
        previous: previous?.rejectedProductIds,
        next: rejectedProductIds,
        mode: rejectedProductIdsUpdateMode,
        legacyNonEmptyMode: 'merge'
      });
      const effectiveConstraints = applyNeedListUpdate({
        previous: previous?.constraints,
        next: constraints,
        mode: constraintsUpdateMode,
        legacyNonEmptyMode: 'replace'
      });
      const effectiveOpenQuestions = applyNeedListUpdate({
        previous: previous?.openQuestions,
        next: openQuestions,
        mode: openQuestionsUpdateMode,
        legacyNonEmptyMode: 'replace'
      });
      const excludedProductIds = new Set([...effectiveRejectedProductIds, ...invalidatedProductIds]);
      const previousSelectedProductIds = (previous?.selectedProductIds ?? [])
        .filter((productId) => !excludedProductIds.has(productId));
      const explicitSelectedProductIds = (selectedProductIds ?? [])
        .filter((productId) => !excludedProductIds.has(productId));
      const selectedProductIdsAfterLlmUpdate = event.eventType === 'need.updated' &&
        event.source === 'llm_state_delta' &&
        selectionUpdateMode === undefined &&
        selectedProductIds?.length === 0 &&
        (previous?.selectedProductIds.length ?? 0) > 0
        ? previousSelectedProductIds
        : selectedProductIds;
      const effectiveSelectedProductIds = selectionUpdateMode === 'clear'
        ? []
        : selectionUpdateMode === 'replace'
          ? explicitSelectedProductIds
          : selectionUpdateMode === 'preserve'
            ? [...new Set([...previousSelectedProductIds, ...explicitSelectedProductIds])]
            : (selectedProductIdsAfterLlmUpdate ?? previousSelectedProductIds)
                .filter((productId) => !excludedProductIds.has(productId));
      needsById[needId] = {
        needId,
        productClass: productClass(event.payload.productClass, previous?.productClass),
        summary: stringPayload(event.payload, 'summary') ?? previous?.summary ?? needId,
        constraints: effectiveConstraints,
        constraintFactBindings: [...(previous?.constraintFactBindings ?? []),
          ...(z.array(z.object({ constraint: z.string(), factKey: z.string() }).strict())
            .safeParse(event.payload.constraintFactBindings).data ?? [])]
          .filter(binding => effectiveConstraints.includes(binding.constraint)),
        openQuestions: effectiveOpenQuestions,
        selectedProductIds: effectiveSelectedProductIds,
        rejectedProductIds: effectiveRejectedProductIds,
        status,
        eventId: event.eventId,
        updatedAt: event.createdAt
      };
      continue;
    }

    if (event.eventType === 'need.closed') {
      const needId = stringPayload(event.payload, 'needId');
      if (!needId || !needsById[needId]) {
        warnings.push('need_close_without_known_need');
        continue;
      }
      needsById[needId] = {
        ...needsById[needId],
        status: 'closed',
        eventId: event.eventId,
        updatedAt: event.createdAt
      };
      continue;
    }

    if (event.eventType === 'fact.observed' || event.eventType === 'fact.confirmed') {
      const factKey = stringPayload(event.payload, 'factKey');
      if (!factKey) {
        warnings.push('fact_event_without_fact_key');
        continue;
      }
      const needId = stringPayload(event.payload, 'needId');
      const productId = stringPayload(event.payload, 'productId');
      const scopedKey = factMapKey(factKey, needId, productId);
      const previousEventId = factEventByKey.get(scopedKey);
      const previous = previousEventId ? factsByEventId.get(previousEventId) : undefined;
      const supersedesPrevious = previousEventId
        ? stringListPayload(event.payload, 'supersedesEventIds').includes(previousEventId)
        : false;
      const observedCannotReplaceConfirmed = event.eventType === 'fact.observed' &&
        previous?.eventType === 'fact.confirmed' &&
        (previous.status === 'active' || supersedesPrevious);
      const relation = reducedFactSnapshotSchema.shape.relation.safeParse(event.payload.relation ?? undefined);
      if (!relation.success) warnings.push('fact_relation_invalid');
      const ranking = reducedFactSnapshotSchema.shape.ranking.safeParse(event.payload.ranking);
      if (!ranking.success) warnings.push('fact_ranking_invalid');
      const fact: ReducedFact = {
        factKey,
        value: event.payload.value,
        eventId: event.eventId,
        eventType: event.eventType,
        status: event.status,
        evidence: event.evidence,
        source: event.source,
        confidence: factConfidence(event.eventType, event.payload, warnings),
        createdAt: event.createdAt,
        needId,
        role: requirementRole(event.payload),
        productClass: stringPayload(event.payload, 'productClass'),
        scope: event.scope,
        productId,
        unit: stringPayload(event.payload, 'unit'),
        relation: relation.success ? relation.data : undefined,
        ranking: ranking.success ? ranking.data : undefined
      };
      factsByEventId.set(event.eventId, fact);
      if (observedCannotReplaceConfirmed) {
        previous.status = 'active';
        warnings.push('observed_fact_did_not_replace_confirmed');
        continue;
      }
      if (previous?.status === 'active') previous.status = 'superseded';
      factEventByKey.set(scopedKey, event.eventId);
      continue;
    }

    if (event.eventType === 'fact.superseded' || event.eventType === 'fact.negated') {
      for (const eventId of stringListPayload(event.payload, 'targetEventIds')) {
        const fact = factsByEventId.get(eventId);
        if (fact) fact.status = event.eventType === 'fact.superseded' ? 'superseded' : 'negated';
      }
      continue;
    }

    if (event.eventType === 'question.asked') {
      const questionId = stringPayload(event.payload, 'questionId') ?? event.eventId;
      const text = stringPayload(event.payload, 'text');
      if (!text) {
        warnings.push('question_event_without_text');
        continue;
      }
      questionsById[questionId] = {
        questionId,
        text,
        askedEventId: event.eventId,
        status: event.payload.answerKnown === true ? 'answered' : 'open',
        needId: stringPayload(event.payload, 'needId')
      };
      continue;
    }

    if (event.eventType === 'question.answered' || event.eventType === 'question.closed') {
      const targetIds = [
        ...stringListPayload(event.payload, 'targetQuestionIds'),
        ...stringListPayload(event.payload, 'closesQuestionIds')
      ];
      const questionId = stringPayload(event.payload, 'questionId');
      if (questionId) targetIds.push(questionId);
      for (const targetId of targetIds) {
        const question = questionsById[targetId];
        if (!question) continue;
        question.status = event.eventType === 'question.answered' ? 'answered' : 'closed';
        question.answer = event.payload.answer;
        question.closedByEventId = event.eventId;
      }
    }
  }

  const factsByKey: Record<string, ReducedFact> = {};
  for (const [scopedKey, eventId] of factEventByKey.entries()) {
    const fact = factsByEventId.get(eventId);
    if (fact) factsByKey[scopedKey] = fact;
  }

  const openQuestions = Object.values(questionsById).filter((question) => question.status === 'open');
  for (const need of Object.values(needsById)) {
    // The planner binds the semantic alias; the reducer only resolves that exact
    // scoped identity after every fact event in this delta has been applied.
    const bindings = new Map((need.constraintFactBindings ?? []).map(binding => [binding.constraint, binding.factKey]));
    const nextBindings: NonNullable<ReducedNeed['constraintFactBindings']> = [];
    need.constraints = need.constraints.flatMap(constraint => {
      const factKey = bindings.get(constraint);
      if (!factKey) return [constraint];
      const fact = Object.values(factsByKey).find(item => item.needId === need.needId && item.factKey === factKey &&
        item.scope === 'need' && !item.productId);
      if (!fact) { warnings.push(`need_constraint_fact_missing:${need.needId}:${factKey}`); return [constraint]; }
      if (fact.status !== 'active') return [];
      const current = dialogueFactConstraintText(fact);
      nextBindings.push({ constraint: current, factKey });
      return [current];
    });
    if (bindings.size) need.constraintFactBindings = nextBindings;
    const resolvedQuestionTexts = new Set(
      Object.values(questionsById)
        .filter((question) =>
          question.status !== 'open' &&
          (!question.needId || question.needId === need.needId)
        )
        .map((question) => question.text)
    );
    const linkedOpenQuestions = openQuestions
      .filter((question) => question.needId === need.needId)
      .map((question) => question.text);
    need.openQuestions = Array.from(new Set([
      ...need.openQuestions.filter((question) => !resolvedQuestionTexts.has(question)),
      ...linkedOpenQuestions
    ]));
  }

  return {
    eventIds,
    factsByKey,
    questionsById,
    needsById,
    openQuestions,
    warnings: Array.from(new Set(warnings))
  };
}

export function applyLedgerStateDelta(input: {
  sessionId: string;
  turnId: string;
  existingEvents: DialogueLedgerEvent[];
  delta: LedgerStateDelta;
  initialState?: ReducedDialogueLedgerState;
}) {
  const events = normalizeLedgerStateDeltaEvents({
    sessionId: input.sessionId,
    turnId: input.turnId,
    delta: input.delta
  });
  return {
    events,
    state: reduceDialogueLedger([...input.existingEvents, ...events], input.initialState)
  };
}

function supportedProductClass(value: string | undefined, fallback: ProductSelectionClass): ProductSelectionClass {
  return value && knownProductClasses.has(value as ProductSelectionClass)
    ? value as ProductSelectionClass
    : fallback;
}

function activeCustomerNeedsFromLedger(
  ledgerState: ReducedDialogueLedgerState,
  base: CustomerNeedState,
  now: string
): ActiveCustomerNeed[] {
  const needs = Object.values(ledgerState.needsById);
  if (!needs.length) return [];
  const activeFacts = Object.values(ledgerState.factsByKey).filter((fact) => fact.status === 'active');
  return needs.map((need) => {
    const facts = activeFacts.filter((fact) => fact.needId === need.needId);
    const factConstraints = facts
      .filter((fact) => fact.eventType === 'fact.confirmed' && fact.role === 'hard_requirement' && fact.scope !== 'product' && !fact.productId)
      .map(dialogueFactConstraintText);
    const linkedQuestions = ledgerState.openQuestions
      .filter((question) => question.needId === need.needId)
      .map((question) => question.text);
    return {
      id: need.needId,
      productClass: supportedProductClass(need.productClass, 'unknown'),
      summary: need.summary,
      constraints: Array.from(new Set([...need.constraints, ...factConstraints])).slice(0, 24),
      openQuestions: Array.from(new Set([...need.openQuestions, ...linkedQuestions])).slice(0, 12),
      selectedProductIds: [...need.selectedProductIds].slice(0, 24),
      status: need.status,
      updatedAt: need.updatedAt ?? now
    };
  });
}

export function deriveNeedStateSnapshotFromLedger(
  ledgerState: ReducedDialogueLedgerState,
  base: CustomerNeedState = emptyNeedState()
): CustomerNeedState {
  const now = new Date().toISOString();
  const ledgerNeeds = activeCustomerNeedsFromLedger(ledgerState, base, now);
  const currentReducedNeed = getActiveDialogueNeed(ledgerState);
  const currentFacts = activeScopedDialogueLedgerFacts(ledgerState);
  const currentNeedId = currentReducedNeed?.needId ?? (ledgerNeeds.length === 0 ? currentFacts.find((fact) => fact.needId)?.needId : undefined);
  const currentNeed = currentReducedNeed
    ? ledgerNeeds.find((need) => need.id === currentReducedNeed.needId)
    : undefined;
  const activeFactItems = currentFacts.map((fact) => factNeedItem(fact, now));
  const confirmedFacts = currentFacts
    .filter((fact) => fact.eventType === 'fact.confirmed')
    .map((fact) => factNeedItem(fact, now));
  const observedFacts = currentFacts
    .filter((fact) => fact.eventType === 'fact.observed')
    .map((fact) => factNeedItem(fact, now));
  const fallbackClass = ledgerNeeds.length ? 'unknown' : base.selectionState.currentProductClass;
  const semanticClass: ProductSelectionClass = currentReducedNeed?.productClass === 'commercial'
    ? fallbackClass
    : supportedProductClass(
        currentNeed?.productClass,
        supportedProductClass(
          currentFacts.find((fact) => fact.productClass)?.productClass,
          fallbackClass
        )
      );
  const openQuestions = currentNeed?.openQuestions ?? ledgerState.openQuestions.map((question) => question.text);
  const summary = ledgerNeeds.length
    ? ledgerNeeds
        .filter((need) => need.status !== 'closed')
        .map((need) => `${need.status === 'paused' ? 'Paused' : 'Active'} ${need.summary}`)
        .join('; ')
        .slice(0, 1200)
    : activeFactItems.length
      ? activeFactItems.map((item) => item.value).join('; ').slice(0, 800)
      : openQuestions.length
        ? `Open questions: ${openQuestions.join('; ').slice(0, 700)}`
        : base.lastSummary;
  const hasLedgerState = ledgerNeeds.length > 0 || activeFactItems.length > 0 || openQuestions.length > 0;
  if (!hasLedgerState) return base;

  const snapshotBase = emptyNeedState();
  const rejectedProductIds = currentReducedNeed?.rejectedProductIds ?? [];

  return {
    ...snapshotBase,
    activeNeeds: ledgerNeeds.length
      ? ledgerNeeds
      : hasLedgerState
        ? [{
            id: currentNeedId ?? 'ledger-current',
            productClass: semanticClass,
            summary: summary || 'Ledger-derived dialogue state',
            constraints: currentFacts
              .filter((fact) => fact.eventType === 'fact.confirmed' && fact.role === 'hard_requirement' && fact.scope !== 'product' && !fact.productId)
              .map((fact) => `${fact.factKey}: ${factValueText(fact.value)}`)
              .slice(0, 24),
            openQuestions,
            selectedProductIds: [],
            status: openQuestions.length ? 'open' : 'selected',
            updatedAt: now
          }]
        : [],
    explicitNeeds: currentFacts
      .filter((fact) => fact.eventType === 'fact.confirmed' && fact.scope !== 'product' && !fact.productId)
      .map((fact) => factNeedItem(fact, now)),
    confirmedFacts,
    uncertainInferences: observedFacts,
    constraints: currentFacts
      .filter((fact) => fact.eventType === 'fact.confirmed' && fact.role === 'hard_requirement' && fact.scope !== 'product' && !fact.productId)
      .map((fact) => factNeedItem(fact, now)),
    selectionState: {
      ...emptyProductSelectionState(),
      semanticSource: 'planner',
      currentProductClass: semanticClass,
      targetProductClass: semanticClass,
      unknowns: openQuestions,
      selectedProductIds: currentNeed?.selectedProductIds ?? [],
      rejectedProducts: Array.from(new Set(rejectedProductIds)).map((productId) => ({
        productId,
        reason: 'Rejected in the active dialogue need state'
      })),
      updatedAt: now
    },
    lastSummary: summary
  };
}
