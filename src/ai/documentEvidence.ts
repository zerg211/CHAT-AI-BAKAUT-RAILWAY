import { createHash } from 'node:crypto';

interface DocumentPassage { id: string; start: number; end: number; text: string }
export interface EvidenceDocument {
  sourceUrl: string;
  sourceTitle?: string;
  textHash: string;
  textLength: number;
  suppliedLength: number;
  passages: DocumentPassage[];
}
export interface DocumentEvidenceTrace {
  documents: Array<Omit<EvidenceDocument, 'passages'>>;
  selections: Array<{
    kind: 'fact' | 'coverage'; itemIndex: number; passageIds: string[];
    status: 'bound' | 'invalid'; sourceUrl?: string; start?: number; end?: number;
    evidenceHash?: string;
  }>;
}

export function createEvidenceDocuments(documents: Array<{ sourceUrl: string; sourceTitle?: string; text: string }>): EvidenceDocument[] {
  return documents.slice(0, 2).map((document, documentIndex) => {
    const text = document.text.slice(0, 64_000);
    const passages: DocumentPassage[] = [];
    for (let start = 0; start < text.length; start += 1_200) {
      const end = Math.min(start + 1_200, text.length);
      passages.push({ id: `document-${documentIndex}-passage-${passages.length}`, start, end, text: text.slice(start, end) });
    }
    return { sourceUrl: document.sourceUrl, sourceTitle: document.sourceTitle,
      textHash: createHash('sha256').update(document.text).digest('hex'), textLength: document.text.length,
      suppliedLength: text.length, passages };
  });
}

export function documentEvidenceRefSchema(passageIds: string[], nullable = false) {
  const reference = { type: 'object', additionalProperties: false, properties: {
    passageIds: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', enum: passageIds } }
  }, required: ['passageIds'] };
  return nullable ? { anyOf: [reference, { type: 'null' }] } : reference;
}

export function documentPassageKey(sourceUrl: unknown, evidence: unknown) {
  return createHash('sha256').update(JSON.stringify([sourceUrl, evidence])).digest('hex');
}

/** References are unverified locations, never permission to accept a claim. */
export function bindDocumentEvidence(parsed: Record<string, unknown>, documents: EvidenceDocument[]) {
  const selections: DocumentEvidenceTrace['selections'] = [];
  const passageKeys: string[] = [];
  let invalid = false;
  function bind(raw: unknown, kind: 'fact' | 'coverage', itemIndex: number): Record<string, unknown> | null {
    if (!raw || typeof raw !== 'object') return null;
    const { evidenceRef, ...item } = raw as Record<string, unknown>;
    if (kind === 'coverage' && item.status !== 'confirmed' && evidenceRef == null) return item;
    const reference = evidenceRef && typeof evidenceRef === 'object' ? evidenceRef as Record<string, unknown> : {};
    const ids = Array.isArray(reference.passageIds) ? reference.passageIds : [];
    const document = documents.find((candidate) => candidate.passages.some((part) => part.id === ids[0]));
    const firstIndex = document?.passages.findIndex((part) => part.id === ids[0]) ?? -1;
    const parts = document?.passages.slice(firstIndex, firstIndex + ids.length) ?? [];
    const valid = ids.length >= 1 && ids.length <= 2 && parts.length === ids.length &&
      ids.every((id, index) => typeof id === 'string' && parts[index]?.id === id);
    if (!valid || !document) {
      invalid = true;
      selections.push({ kind, itemIndex, passageIds: ids.slice(0, 2).map((id) => String(id).slice(0, 96)), status: 'invalid' });
      return kind === 'fact' ? null : { ...item, status: 'not_confirmed', value: '', evidence: '', sourceUrl: null, sourceTitle: null };
    }
    const evidence = parts.map((part) => part.text).join('');
    passageKeys.push(documentPassageKey(document.sourceUrl, evidence));
    selections.push({ kind, itemIndex, passageIds: ids as string[], status: 'bound', sourceUrl: document.sourceUrl,
      start: parts[0]!.start, end: parts.at(-1)!.end, evidenceHash: createHash('sha256').update(evidence).digest('hex') });
    return { ...item, ...(kind === 'fact' ? { sourceType: 'web' } : {}), evidence,
      sourceUrl: document.sourceUrl, sourceTitle: document.sourceTitle ?? null };
  }
  const guidance = parsed.answerGuidance && typeof parsed.answerGuidance === 'object'
    ? parsed.answerGuidance as Record<string, unknown> : {};
  const facts = (Array.isArray(parsed.facts) ? parsed.facts : []).slice(0, 12)
    .flatMap((item, index) => { const bound = bind(item, 'fact', index); return bound ? [bound] : []; });
  const coverage = (Array.isArray(guidance.coverage) ? guidance.coverage : []).slice(0, 12)
    .flatMap((item, index) => { const bound = bind(item, 'coverage', index); return bound ? [bound] : []; });
  return {
    passageKeys,
    parsed: { ...parsed, facts, answerGuidance: { ...guidance, coverage, ...(invalid ? { directAnswer: '' } : {}) },
      ...(invalid ? { summaryForAnswer: '', warnings: [...(Array.isArray(parsed.warnings) ? parsed.warnings : []),
        'document_evidence_reference_invalid'] } : {}) },
    trace: { documents: documents.map(({ passages: _passages, ...document }) => document), selections } satisfies DocumentEvidenceTrace
  };
}
