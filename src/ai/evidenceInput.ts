/**
 * Deterministic evidence-input normalization (F02).
 *
 * Extracts machine-usable evidence from a raw buyer message WITHOUT any LLM:
 * first-party/external URLs (canonicalized) and product identifiers
 * (numeric articles, model codes). Product *names* stay a semantic (LLM) concern.
 *
 * No regular expressions: all scanning is explicit character classification so the
 * module stays outside the semantic-regex hazard class by construction.
 */

export type IdentifierKind = 'numeric_article' | 'model_code' | 'catalog_id';

export interface IdentifierEvidence {
  kind: IdentifierKind;
  /** Raw token as seen in the message (trimmed of wrapping punctuation). */
  value: string;
  /** Canonical form used for exact lookups (uppercase compact for codes). */
  normalized: string;
  provenance: 'user_message';
}

export interface CanonicalUrlEvidence {
  raw: string;
  canonical: string;
  host: string;
  pathname: string;
  firstParty: boolean;
  provenance: 'user_message';
}

export interface EvidenceInput {
  /** Always empty from this deterministic pass; reserved for semantic extraction. */
  productNames: string[];
  identifiers: IdentifierEvidence[];
  urls: CanonicalUrlEvidence[];
}

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'roistat_visit', 'rs', 'yclid', 'gclid', 'fbclid'
]);

const DEFAULT_FIRST_PARTY_HOSTS = ['bakautprof.ru'];

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isCyrillicLetter(code: number): boolean {
  return (code >= 0x410 && code <= 0x44f) || code === 0x401 || code === 0x451;
}

function isTokenChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  if (isDigit(code) || isAsciiLetter(code) || isCyrillicLetter(code)) return true;
  return ch === '-' || ch === '_' || ch === '+' || ch === '.' || ch === ':';
}

const WRAP_CHARS = new Set(['.', ',', ';', ':', '!', '?', '(', ')', '[', ']', '{', '}', '"', "'", '«', '»', '„', '“', '”', '…', '—', '–', '*', '|', '<', '>']);

function trimWrappingPunctuation(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && WRAP_CHARS.has(token[start] ?? '')) start += 1;
  while (end > start && WRAP_CHARS.has(token[end - 1] ?? '')) end -= 1;
  return token.slice(start, end);
}

function isAllDigits(token: string): boolean {
  if (token.length === 0) return false;
  for (const ch of token) {
    const code = ch.codePointAt(0) ?? 0;
    if (!isDigit(code)) return false;
  }
  return true;
}

function tokenHasLetter(token: string): boolean {
  for (const ch of token) {
    const code = ch.codePointAt(0) ?? 0;
    if (isAsciiLetter(code) || isCyrillicLetter(code)) return true;
  }
  return false;
}

function tokenHasDigit(token: string): boolean {
  for (const ch of token) {
    const code = ch.codePointAt(0) ?? 0;
    if (isDigit(code)) return true;
  }
  return false;
}

function compactUpper(token: string): string {
  return token.normalize('NFKC').toUpperCase();
}

export interface EvidenceUrlOptions {
  firstPartyHosts?: string[];
}

function hostIsFirstParty(host: string, firstPartyHosts: string[]): boolean {
  const normalized = host.toLowerCase();
  return firstPartyHosts.some((candidate) => {
    const root = candidate.toLowerCase();
    return normalized === root || normalized.endsWith('.' + root);
  });
}

function canonicalizeUrl(raw: string, firstPartyHosts: string[]): CanonicalUrlEvidence | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.normalize('NFKC'));
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  const host = parsed.hostname.toLowerCase();
  if (host.length === 0) return null;
  const kept: Array<[string, string]> = [];
  parsed.searchParams.forEach((value, key) => {
    if (!TRACKING_PARAMS.has(key.toLowerCase())) kept.push([key, value]);
  });
  let pathname = parsed.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  let canonical = parsed.protocol + '//' + host + pathname;
  if (kept.length > 0) {
    kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    canonical += '?' + kept.map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value)).join('&');
  }
  return { raw, canonical, host, pathname, firstParty: hostIsFirstParty(host, firstPartyHosts), provenance: 'user_message' };
}

const URL_END_CHARS = new Set([' ', '\t', '\n', '\r', '<', '>', '"', "'", '(', ')', '[', ']', '{', '}']);

function extractRawUrls(text: string): string[] {
  const found: string[] = [];
  let index = 0;
  while (index < text.length) {
    let scheme: string | null = null;
    if (text.startsWith('https://', index)) scheme = 'https://';
    else if (text.startsWith('http://', index)) scheme = 'http://';
    else if (text.startsWith('www.', index)) scheme = 'www.';
    if (scheme === null) {
      index += 1;
      continue;
    }
    let end = index + scheme.length;
    while (end < text.length && !URL_END_CHARS.has(text[end] ?? '')) end += 1;
    let candidate = text.slice(index, end);
    while (candidate.length > 0 && (candidate.endsWith('.') || candidate.endsWith(',') || candidate.endsWith(';') || candidate.endsWith('!') || candidate.endsWith('?') || candidate.endsWith(':'))) {
      candidate = candidate.slice(0, -1);
    }
    if (scheme === 'www.') candidate = 'https://' + candidate;
    if (candidate.length > scheme.length + 1) found.push(candidate);
    index = end;
  }
  return found;
}

function maskRanges(text: string, ranges: Array<{ start: number; end: number }>): string {
  const chars = [...text];
  for (const range of ranges) {
    for (let i = range.start; i < range.end && i < chars.length; i += 1) chars[i] = ' ';
  }
  return chars.join('');
}

function findRawRanges(text: string, raws: string[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const raw of raws) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(raw, from);
      if (at < 0) break;
      ranges.push({ start: at, end: at + raw.length });
      from = at + raw.length;
    }
  }
  return ranges;
}

/**
 * Extracts identifiers and URLs from a buyer message. Deterministic, no LLM, no regex.
 * Pure-digit tokens of length 5..10 are numeric-article candidates (11+ reads as a
 * phone number and is skipped); letter+digit tokens of length >= 3 are model codes.
 * Lookup misses later simply drop the candidate — a miss is never proof of absence.
 */
export function extractEvidenceInput(message: string, options?: EvidenceUrlOptions): EvidenceInput {
  const text = (message ?? '').normalize('NFKC');
  const firstPartyHosts = options?.firstPartyHosts ?? DEFAULT_FIRST_PARTY_HOSTS;
  const rawUrls = extractRawUrls(text);
  const urls: CanonicalUrlEvidence[] = [];
  const seenUrls = new Set<string>();
  for (const raw of rawUrls) {
    const canonical = canonicalizeUrl(raw, firstPartyHosts);
    if (!canonical || seenUrls.has(canonical.canonical)) continue;
    seenUrls.add(canonical.canonical);
    urls.push(canonical);
  }
  const masked = maskRanges(text, findRawRanges(text, rawUrls));
  const identifiers: IdentifierEvidence[] = [];
  const seenIdentifiers = new Set<string>();
  let current = '';
  const flush = () => {
    const token = trimWrappingPunctuation(current);
    current = '';
    if (token.length === 0) return;
    if (token.toLowerCase().startsWith('bakaut:') && token.length > 7) {
      const key = 'catalog_id:' + token.toLowerCase();
      if (!seenIdentifiers.has(key)) {
        seenIdentifiers.add(key);
        identifiers.push({ kind: 'catalog_id', value: token, normalized: token.toLowerCase(), provenance: 'user_message' });
      }
      return;
    }
    if (isAllDigits(token)) {
      if (token.length >= 5 && token.length <= 10) {
        const key = 'numeric_article:' + token;
        if (!seenIdentifiers.has(key)) {
          seenIdentifiers.add(key);
          identifiers.push({ kind: 'numeric_article', value: token, normalized: token, provenance: 'user_message' });
        }
      }
      return;
    }
    if (token.length >= 3 && tokenHasLetter(token) && tokenHasDigit(token)) {
      const normalized = compactUpper(token);
      const key = 'model_code:' + normalized;
      if (!seenIdentifiers.has(key)) {
        seenIdentifiers.add(key);
        identifiers.push({ kind: 'model_code', value: token, normalized, provenance: 'user_message' });
      }
    }
  };
  for (const ch of masked) {
    if (isTokenChar(ch)) current += ch;
    else flush();
  }
  flush();
  return { productNames: [], identifiers, urls };
}

/** Fingerprint of the evidence that identity resolution was attempted with. */
export function evidenceFingerprint(input: EvidenceInput): string {
  const parts: string[] = [];
  for (const id of input.identifiers) parts.push(id.kind + ':' + id.normalized);
  for (const url of input.urls) parts.push('url:' + url.canonical);
  parts.sort();
  return parts.join('|');
}

/** Strength rank: higher evidence outranks weaker evidence for invalidation. */
export function evidenceStrength(input: EvidenceInput): number {
  let strength = 0;
  for (const url of input.urls) {
    strength = Math.max(strength, url.firstParty ? 4 : 1);
  }
  for (const id of input.identifiers) {
    if (id.kind === 'numeric_article') strength = Math.max(strength, 3);
    else if (id.kind === 'model_code') strength = Math.max(strength, 2);
    else strength = Math.max(strength, 5);
  }
  return strength;
}
