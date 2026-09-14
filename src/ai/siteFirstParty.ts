/**
 * Direct first-party page read (F04).
 *
 * A buyer-supplied first-party URL is first-class evidence with a direct execution
 * path — it must never be reduced to "search the catalog again". Reads are
 * same-origin only, bounded, credential-free, and classified as product/company/other.
 * Identity extraction covers title/article only; prices stay with the dedicated
 * current-price verification, stock stays a human operation.
 */
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { cleanText } from '../catalog/normalize.js';
import { outboundText, safeFetchBytes, type SafeOutboundFetchResult } from '../security/outboundHttp.js';
import { classifyCompanyPath } from './companyKnowledge.js';
import { extractReadableSourceText } from '../catalog/sourceText.js';
import { hasPageSpecificProductEvidence } from '../catalog/productPageIdentity.js';
import { extractPdfText, PdfTextExtractionError } from './pdfTextExtraction.js';
import type { CatalogPageInput } from '../shared/types.js';

export type FirstPartyPageKind = 'product' | 'company' | 'other';

export interface FirstPartyProductIdentity {
  title: string;
  article?: string;
}

export interface FirstPartyCompanyInfo {
  kind: string;
  volatility: 'STABLE' | 'SEMI_VOLATILE';
  snippet: string;
}

export interface FirstPartyPageRead {
  /** Internal durable source candidate; never added wholesale to model context. */
  cacheCandidate?: CatalogPageInput;
  canonicalUrl: string;
  pageKind: FirstPartyPageKind;
  title: string;
  text: string;
  requestedUrl: string;
  format: 'html' | 'pdf';
  sourceTruncated: boolean;
  readRange: { start: number; end: number; totalChars: number; complete: boolean; nextOffset: number | null };
  productIdentity?: FirstPartyProductIdentity;
  companyInfo?: FirstPartyCompanyInfo;
  sourceFingerprint: string;
  observedAt: string;
}

export type FirstPartyReadFailureCode = 'denied' | 'timeout' | 'http_status' | 'unreadable' | 'unsupported' | 'source_changed';

export interface FirstPartyReadFailure {
  code: FirstPartyReadFailureCode;
  canonicalUrl: string;
  status?: number;
  observedAt: string;
}

export type FirstPartyPageResult = { ok: true; page: FirstPartyPageRead } | { ok: false; failure: FirstPartyReadFailure };

export interface FirstPartyReadOptions {
  baseUrl: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  textLimit?: number;
  offset?: number;
  expectedSourceFingerprint?: string;
  signal?: AbortSignal;
  now?: () => string;
  fetchBytes?: (url: string, options: {
    allowedOrigin: string; timeoutMs: number; maxBytes: number; maxRedirects: number;
    headers: Record<string, string>; signal?: AbortSignal;
  }) => Promise<SafeOutboundFetchResult>;
}

export function canonicalizeFirstPartyUrl(raw: string, baseUrl: string): { canonical: string; host: string; pathname: string } | null {
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(raw);
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.origin !== base.origin) return null;
  const pathname = parsed.pathname;
  return { canonical: parsed.origin + pathname + parsed.search, host: parsed.hostname.toLowerCase(), pathname };
}

const WRAP = new Set(['.', ',', ';', ':', '!', '?', '(', ')', '[', ']', '{', '}', '"', "'", '«', '»', '„', '“', '”', '…']);

function nextTokenAfter(text: string, marker: string): string | undefined {
  const lower = text.toLocaleLowerCase('ru-RU');
  const at = lower.indexOf(marker);
  if (at < 0) return undefined;
  const rest = text.slice(at + marker.length).trimStart();
  if (rest.length === 0 || rest[0] === ':' || rest[0] === '-') {
    const after = rest.slice(1).trimStart();
    if (!after) return undefined;
    return takeToken(after);
  }
  return undefined;
}

function takeToken(text: string): string | undefined {
  let end = 0;
  while (end < text.length) {
    const ch = text[end] ?? '';
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') break;
    end += 1;
  }
  let token = text.slice(0, end);
  while (token.length > 0 && WRAP.has(token[token.length - 1] ?? '')) token = token.slice(0, -1);
  while (token.length > 0 && WRAP.has(token[0] ?? '')) token = token.slice(1);
  return token || undefined;
}

function extractArticle(heading: string, text: string): string | undefined {
  return nextTokenAfter(heading, 'артикул') ?? nextTokenAfter(text, 'артикул');
}

function pageFingerprint(canonicalUrl: string, title: string, text: string): string {
  return createHash('sha256').update(JSON.stringify([canonicalUrl, title, text])).digest('hex');
}

function failureCodeOf(error: unknown): FirstPartyReadFailureCode {
  if (!(error instanceof Error)) return 'unreadable';
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout';
  if (error.message.includes('redirect') || error.message.includes('Unsafe') || error.message.includes('private')) return 'denied';
  if (error.message.includes('large')) return 'unsupported';
  return 'unreadable';
}

export async function readFirstPartyPage(
  url: string,
  options: FirstPartyReadOptions
): Promise<FirstPartyPageResult> {
  const observedAt = (options.now ?? (() => new Date().toISOString()))();
  let canonical = canonicalizeFirstPartyUrl(url, options.baseUrl);
  if (!canonical) {
    return { ok: false, failure: { code: 'denied', canonicalUrl: url, observedAt } };
  }
  const fetchBytes = options.fetchBytes ?? ((target, fetchOptions) => safeFetchBytes(target, fetchOptions));
  let result: SafeOutboundFetchResult;
  try {
    result = await fetchBytes(canonical.canonical, {
      allowedOrigin: options.baseUrl,
      timeoutMs: options.timeoutMs ?? 15_000,
      maxBytes: options.maxBytes ?? 1_500_000,
      maxRedirects: options.maxRedirects ?? 2,
      headers: { 'user-agent': 'Bakaut first-party page read' },
      signal: options.signal
    });
  } catch (error) {
    return { ok: false, failure: { code: failureCodeOf(error), canonicalUrl: canonical.canonical, observedAt } };
  }
  if (result.status !== 200) {
    return { ok: false, failure: { code: 'http_status', canonicalUrl: canonical.canonical, status: result.status, observedAt } };
  }
  canonical = canonicalizeFirstPartyUrl(result.url, options.baseUrl);
  if (!canonical) return { ok: false, failure: { code: 'denied', canonicalUrl: url, observedAt } };
  const contentType = String(result.headers.get('content-type') ?? '').toLowerCase();
  const isPdf = contentType.includes('application/pdf') || new TextDecoder().decode(result.bytes.subarray(0, 5)) === '%PDF-';
  if (contentType && !contentType.includes('text/html') && !isPdf) {
    return { ok: false, failure: { code: 'unsupported', canonicalUrl: canonical.canonical, status: result.status, observedAt } };
  }
  let html = '';
  let pdfText: string | undefined;
  let sourceTruncated = false;
  try {
    if (isPdf) {
      const parsed = await extractPdfText(result.bytes, { signal: options.signal });
      pdfText = parsed.text;
      sourceTruncated = parsed.truncated;
    } else html = outboundText(result);
  } catch (error) {
    const code = error instanceof PdfTextExtractionError && error.code === 'timed_out' ? 'timeout' : failureCodeOf(error);
    return { ok: false, failure: { code, canonicalUrl: canonical.canonical, status: result.status, observedAt } };
  }
  const $ = cheerio.load(html);
  const title = isPdf ? canonical.pathname.split('/').at(-1) ?? 'PDF' : cleanText($('h1').first().text() || $('title').first().text());
  if (!title || title.length < 3) {
    return { ok: false, failure: { code: 'unreadable', canonicalUrl: canonical.canonical, status: result.status, observedAt } };
  }
  const fullText = pdfText ?? extractReadableSourceText($);
  if (!fullText.trim()) return { ok: false, failure: { code: 'unreadable', canonicalUrl: canonical.canonical, observedAt } };
  const limit = Math.max(1, Math.min(12_000, options.textLimit ?? 8_000));
  const start = Math.max(0, Math.min(fullText.length, Math.trunc(options.offset ?? 0)));
  const end = Math.min(fullText.length, start + limit);
  const text = fullText.slice(start, end);
  const representation = {
    requestedUrl: url,
    format: isPdf ? 'pdf' as const : 'html' as const,
    sourceTruncated,
    readRange: { start, end, totalChars: fullText.length, complete: !sourceTruncated && start === 0 && end === fullText.length,
      nextOffset: end < fullText.length ? end : null },
    sourceFingerprint: pageFingerprint(canonical.canonical, title, fullText)
  };
  if (options.expectedSourceFingerprint && options.expectedSourceFingerprint !== representation.sourceFingerprint) {
    return { ok: false, failure: { code: 'source_changed', canonicalUrl: canonical.canonical, observedAt } };
  }
  const company = classifyCompanyPath(canonical.pathname);
  if (company) {
    const page: FirstPartyPageRead = {
      canonicalUrl: canonical.canonical,
      pageKind: 'company',
      ...(!sourceTruncated && !new URL(canonical.canonical).search ? { cacheCandidate: {
        sourceUrl: canonical.canonical, pageType: company.kind, title, content: fullText, sourceObservedAt: observedAt
      } } : {}),
      title,
      text,
      ...representation,
      companyInfo: { kind: company.kind, volatility: company.volatility, snippet: text.slice(0, 2_000) },
      observedAt
    };
    return { ok: true, page };
  }
  const article = extractArticle(title, fullText);
  if (hasPageSpecificProductEvidence(html, canonical.canonical)) {
    const page: FirstPartyPageRead = {
      canonicalUrl: canonical.canonical,
      pageKind: 'product',
      title,
      text,
      ...representation,
      productIdentity: article ? { title, article } : { title },
      observedAt
    };
    return { ok: true, page };
  }
  return {
    ok: true,
    page: {
      canonicalUrl: canonical.canonical,
      pageKind: 'other',
      title,
      text,
      ...representation,
      observedAt
    }
  };
}
