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
  canonicalUrl: string;
  pageKind: FirstPartyPageKind;
  title: string;
  text: string;
  productIdentity?: FirstPartyProductIdentity;
  companyInfo?: FirstPartyCompanyInfo;
  sourceFingerprint: string;
  observedAt: string;
}

export type FirstPartyReadFailureCode = 'denied' | 'timeout' | 'http_status' | 'unreadable' | 'unsupported';

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
  now?: () => string;
  fetchBytes?: (url: string, options: {
    allowedOrigin: string; timeoutMs: number; maxBytes: number; maxRedirects: number;
    headers: Record<string, string>;
  }) => Promise<SafeOutboundFetchResult>;
}

function canonicalizeSameOrigin(raw: string, baseUrl: string): { canonical: string; host: string; pathname: string } | null {
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(raw.normalize('NFKC'));
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.origin !== base.origin) return null;
  let pathname = parsed.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  return { canonical: parsed.origin + pathname, host: parsed.hostname.toLowerCase(), pathname };
}

function isProductPath(pathname: string): boolean {
  const parts = pathname.split('/').filter((part) => part.length > 0);
  if (parts[0] !== 'catalog' || parts.length < 3) return false;
  const last = parts[parts.length - 1] ?? '';
  return last.length > 8 && !last.startsWith('filter') && !last.includes('clear');
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

function pageFingerprint(canonicalUrl: string, title: string, article?: string): string {
  return createHash('sha256').update(JSON.stringify([canonicalUrl, title, article ?? null])).digest('hex');
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
  const canonical = canonicalizeSameOrigin(url, options.baseUrl);
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
      headers: { 'user-agent': 'Bakaut first-party page read' }
    });
  } catch (error) {
    return { ok: false, failure: { code: failureCodeOf(error), canonicalUrl: canonical.canonical, observedAt } };
  }
  if (result.status !== 200) {
    return { ok: false, failure: { code: 'http_status', canonicalUrl: canonical.canonical, status: result.status, observedAt } };
  }
  const contentType = String(result.headers.get('content-type') ?? '');
  if (contentType && !contentType.includes('text/html')) {
    return { ok: false, failure: { code: 'unsupported', canonicalUrl: canonical.canonical, status: result.status, observedAt } };
  }
  let html: string;
  try {
    html = outboundText(result);
  } catch {
    return { ok: false, failure: { code: 'unreadable', canonicalUrl: canonical.canonical, status: result.status, observedAt } };
  }
  const $ = cheerio.load(html);
  const title = cleanText($('h1').first().text() || $('title').first().text());
  if (!title || title.length < 3) {
    return { ok: false, failure: { code: 'unreadable', canonicalUrl: canonical.canonical, status: result.status, observedAt } };
  }
  const limit = options.textLimit ?? 8_000;
  const text = cleanText($('body').text()).slice(0, limit);
  const company = classifyCompanyPath(canonical.pathname);
  if (company) {
    const page: FirstPartyPageRead = {
      canonicalUrl: canonical.canonical,
      pageKind: 'company',
      title,
      text,
      companyInfo: { kind: company.kind, volatility: company.volatility, snippet: text.slice(0, 2_000) },
      sourceFingerprint: pageFingerprint(canonical.canonical, title),
      observedAt
    };
    return { ok: true, page };
  }
  if (isProductPath(canonical.pathname)) {
    const article = extractArticle(title, text);
    const page: FirstPartyPageRead = {
      canonicalUrl: canonical.canonical,
      pageKind: 'product',
      title,
      text,
      productIdentity: article ? { title, article } : { title },
      sourceFingerprint: pageFingerprint(canonical.canonical, title, article),
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
      sourceFingerprint: pageFingerprint(canonical.canonical, title),
      observedAt
    }
  };
}
