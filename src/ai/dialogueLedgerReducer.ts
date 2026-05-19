import {
  DialogueLedgerEventSchema,
  normalizeLedgerStateDeltaEvents,
  type DialogueLedgerEvent,
  type LedgerStateDelta
} from './agentManagerContracts.js';
import { emptyNeedState } from './needState.js';
import type { CustomerNeedState, NeedItem, ProductSelectionClass } from '../shared/types.js';

export interface ReducedFact {
  factKey: string;
  value: unknown;
  eventId: string;
  status: 'active' | 'superseded' | 'negated' | 'closed' | 'rejected';
  evidence: string;
  source: string;
}

export interface ReducedQuestion {
  questionId: string;
  text: string;
  askedEventId: string;
  status: 'open' | 'answered' | 'closed';
  answer?: unknown;
  closedByEventId?: string;
}

export interface ReducedDialogueLedgerState {
  eventIds: string[];
  factsByKey: Record<string, ReducedFact>;
  questionsById: Record<string, ReducedQuestion>;
  openQuestions: ReducedQuestion[];
  warnings: string[];
}

function factValueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function inferProductClassFromLedger(facts: ReducedFact[]): ProductSelectionClass | 'commercial' {
  const text = facts.map((fact) => `${fact.factKey} ${factValueText(fact.value)}`).join(' ').toLowerCase();
  if (/generator|генератор|coffee|кофе|kw|квт/u.test(text)) return 'generator';
  if (/plate|виброплит|compactor|трамбов/u.test(text)) return 'plate';
  if (/rammer|вибротрамб/u.test(text)) return 'rammer';
  if (/cutter|резчик|шов/u.test(text)) return 'cutter';
  if (/business|commercial|бизнес|производств|проф/u.test(text)) return 'commercial';
  return 'unknown';
}

function factNeedItem(fact: ReducedFact, updatedAt: string): NeedItem {
  return {
    value: `${fact.factKey}: ${factValueText(fact.value)}`,
    evidence: fact.evidence,
    confidence: fact.status === 'active' ? 1 : 0.5,
    updatedAt
  };
}

function stringPayload(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringListPayload(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

export function reduceDialogueLedger(events: DialogueLedgerEvent[]): ReducedDialogueLedgerState {
  const seen = new Set<string>();
  const eventIds: string[] = [];
  const factsByEventId = new Map<string, ReducedFact>();
  const factEventByKey = new Map<string, string>();
  const questionsById: Record<string, ReducedQuestion> = {};
  const warnings: string[] = [];

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

    if (event.eventType === 'fact.observed' || event.eventType === 'fact.confirmed') {
      const factKey = stringPayload(event.payload, 'factKey');
      if (!factKey) {
        warnings.push('fact_event_without_fact_key');
        continue;
      }
      const previousEventId = factEventByKey.get(factKey);
      if (previousEventId) {
        const previous = factsByEventId.get(previousEventId);
        if (previous && previous.status === 'active') previous.status = 'superseded';
      }
      const fact: ReducedFact = {
        factKey,
        value: event.payload.value,
        eventId: event.eventId,
        status: event.status,
        evidence: event.evidence,
        source: event.source
      };
      factsByEventId.set(event.eventId, fact);
      factEventByKey.set(factKey, event.eventId);
      continue;
    }

    if (event.eventType === 'fact.superseded') {
      for (const eventId of stringListPayload(event.payload, 'targetEventIds')) {
        const fact = factsByEventId.get(eventId);
        if (fact) fact.status = 'superseded';
      }
      continue;
    }

    if (event.eventType === 'fact.negated') {
      for (const eventId of stringListPayload(event.payload, 'targetEventIds')) {
        const fact = factsByEventId.get(eventId);
        if (fact) fact.status = 'negated';
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
        status: event.payload.answerKnown === true ? 'answered' : 'open'
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
  for (const [factKey, eventId] of factEventByKey.entries()) {
    const fact = factsByEventId.get(eventId);
    if (fact) factsByKey[factKey] = fact;
  }

  return {
    eventIds,
    factsByKey,
    questionsById,
    openQuestions: Object.values(questionsById).filter((question) => question.status === 'open'),
    warnings
  };
}

export function applyLedgerStateDelta(input: {
  sessionId: string;
  turnId: string;
  existingEvents: DialogueLedgerEvent[];
  delta: LedgerStateDelta;
}) {
  const events = normalizeLedgerStateDeltaEvents({
    sessionId: input.sessionId,
    turnId: input.turnId,
    delta: input.delta
  });
  return {
    events,
    state: reduceDialogueLedger([...input.existingEvents, ...events])
  };
}

export function deriveNeedStateSnapshotFromLedger(
  ledgerState: ReducedDialogueLedgerState,
  base: CustomerNeedState = emptyNeedState()
): CustomerNeedState {
  const now = new Date().toISOString();
  const activeFacts = Object.values(ledgerState.factsByKey).filter((fact) => fact.status === 'active');
  const confirmedFacts = activeFacts.map((fact) => factNeedItem(fact, now));
  const productClass = inferProductClassFromLedger(activeFacts);
  const openQuestions = ledgerState.openQuestions.map((question) => question.text);
  const summary = confirmedFacts.length
    ? confirmedFacts.map((item) => item.value).join('; ').slice(0, 800)
    : openQuestions.length
      ? `Open questions: ${openQuestions.join('; ').slice(0, 700)}`
      : base.lastSummary;

  const hasLedgerState = confirmedFacts.length > 0 || openQuestions.length > 0;
  return {
    ...base,
    activeNeeds: hasLedgerState
      ? [{
          id: 'ledger-current',
          productClass,
          summary: summary || 'Ledger-derived dialogue state',
          constraints: confirmedFacts.map((item) => item.value).slice(0, 12),
          openQuestions,
          selectedProductIds: base.activeNeeds.flatMap((need) => need.selectedProductIds ?? []).slice(0, 12),
          status: openQuestions.length ? 'open' : 'selected',
          updatedAt: now
        }]
      : [...base.activeNeeds],
    explicitNeeds: confirmedFacts,
    confirmedFacts,
    constraints: activeFacts
      .filter((fact) => /constraint|budget|weight|delivery|availability|налич|достав|бюджет|вес/iu.test(fact.factKey))
      .map((fact) => factNeedItem(fact, now)),
    selectionState: {
      ...base.selectionState,
      currentProductClass: productClass === 'commercial' ? base.selectionState.currentProductClass : productClass,
      targetProductClass: productClass === 'commercial' ? base.selectionState.targetProductClass : productClass,
      unknowns: openQuestions,
      updatedAt: now
    },
    lastSummary: summary || base.lastSummary
  };
}
