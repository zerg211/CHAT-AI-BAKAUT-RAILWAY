import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch } from 'undici';

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const localHostSuffixes = ['.localhost', '.local', '.internal', '.home.arpa'];

function trimTrailingCharacter(value: string, character: string) {
  let end = value.length;
  while (end > 0 && value[end - 1] === character) end -= 1;
  return value.slice(0, end);
}

function stripIpv6Brackets(value: string) {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

export class UnsafeOutboundUrlError extends Error {
  readonly code = 'unsafe_outbound_url';

  constructor(message: string) {
    super(message);
    this.name = 'UnsafeOutboundUrlError';
  }
}

export class OutboundResponseTooLargeError extends Error {
  readonly code = 'outbound_response_too_large';

  constructor(readonly maxBytes: number) {
    super(`Outbound response exceeded ${maxBytes} bytes`);
    this.name = 'OutboundResponseTooLargeError';
  }
}

export type SafeOutboundFetchResult = {
  url: string;
  status: number;
  headers: Headers;
  bytes: Uint8Array;
};

export type SafeOutboundFetchOptions = {
  allowedOrigin?: string;
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  resolver?: typeof dnsLookup;
  fetcher?: typeof fetch;
  responseMaxBytes?: (response: {
    url: string;
    status: number;
    headers: Headers;
    prefix: Uint8Array;
  }) => number;
};

function ipv4Number(address: string) {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function ipv4InCidr(value: number, base: number, prefix: number) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function privateOrReservedIpv4(address: string) {
  const value = ipv4Number(address);
  if (value === null) return true;
  const ranges: Array<[string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4]
  ];
  return ranges.some(([base, prefix]) => ipv4InCidr(value, ipv4Number(base)!, prefix));
}

export function isPrivateOrReservedIp(address: string) {
  const normalized = stripIpv6Brackets(address.split('%')[0]);
  if (!ipaddr.isValid(normalized)) return true;
  const parsed = ipaddr.parse(normalized);
  if (parsed.kind() === 'ipv4') return privateOrReservedIpv4(parsed.toString());
  const ipv6 = parsed as ipaddr.IPv6;
  if (ipv6.isIPv4MappedAddress()) return privateOrReservedIpv4(ipv6.toIPv4Address().toString());
  if (ipv6.parts.slice(0, 6).every((part) => part === 0)) return true;
  return ipv6.range() !== 'unicast';
}

function validatedUrl(value: string, allowedOrigin?: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafeOutboundUrlError('Outbound URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeOutboundUrlError('Only HTTP(S) outbound URLs are allowed');
  }
  if (url.username || url.password) throw new UnsafeOutboundUrlError('Outbound URL credentials are forbidden');
  if ((url.protocol === 'http:' && url.port && url.port !== '80') ||
      (url.protocol === 'https:' && url.port && url.port !== '443')) {
    throw new UnsafeOutboundUrlError('Non-standard outbound ports are forbidden');
  }
  const hostname = trimTrailingCharacter(url.hostname.toLocaleLowerCase('en-US'), '.');
  if (hostname === 'localhost' || localHostSuffixes.some((suffix) => hostname.endsWith(suffix))) {
    throw new UnsafeOutboundUrlError('Local outbound hostnames are forbidden');
  }
  if (allowedOrigin && url.origin !== new URL(allowedOrigin).origin) {
    throw new UnsafeOutboundUrlError('Outbound URL is outside the configured origin');
  }
  return url;
}

export async function resolveSafeOutboundUrl(
  value: string,
  options: { allowedOrigin?: string; resolver?: typeof dnsLookup; signal?: AbortSignal } = {}
) {
  const url = validatedUrl(value, options.allowedOrigin);
  const literalHostname = stripIpv6Brackets(url.hostname);
  const literalFamily = isIP(literalHostname);
  const addresses = literalFamily
    ? [{ address: literalHostname, family: literalFamily }]
    : await abortableDnsLookup(
        Promise.resolve().then(() => (options.resolver ?? dnsLookup)(url.hostname, { all: true, verbatim: true })),
        options.signal
      );
  options.signal?.throwIfAborted();
  if (!addresses.length || addresses.some((item) => isPrivateOrReservedIp(item.address))) {
    throw new UnsafeOutboundUrlError('Outbound hostname resolves to a private or reserved address');
  }
  return { url, address: addresses[0].address, family: addresses[0].family };
}

async function abortableDnsLookup<T>(lookup: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return lookup;
  signal.throwIfAborted();
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    const result = await Promise.race([lookup, aborted]);
    signal.throwIfAborted();
    return result;
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
}

export function createPinnedOutboundAgent(address: string, family: number) {
  return new Agent({
    connect: {
      lookup: (_hostname, lookupOptions, callback) => {
        const pinnedAddress = { address, family };
        if (lookupOptions.all) callback(null, [pinnedAddress]);
        else callback(null, address, family);
      }
    }
  });
}

export async function readBoundedResponseBytes(
  response: Response,
  maxBytes: number,
  selectMaxBytes?: (prefix: Uint8Array) => number
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be a positive safe integer');
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new OutboundResponseTooLargeError(maxBytes);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let effectiveMaxBytes = maxBytes;
  let effectiveLimitSelected = !selectMaxBytes;
  const responsePrefix = new Uint8Array(1024);
  let responsePrefixLength = 0;
  const selectEffectiveLimit = (prefix: Uint8Array) => {
    if (effectiveLimitSelected || !selectMaxBytes) return;
    const selected = selectMaxBytes(prefix);
    if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maxBytes) {
      throw new Error('selected maxBytes must be a positive safe integer within maxBytes');
    }
    effectiveMaxBytes = selected;
    effectiveLimitSelected = true;
    if (Number.isFinite(declaredLength) && declaredLength > effectiveMaxBytes) {
      throw new OutboundResponseTooLargeError(effectiveMaxBytes);
    }
    if (total > effectiveMaxBytes) throw new OutboundResponseTooLargeError(effectiveMaxBytes);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        selectEffectiveLimit(responsePrefix.slice(0, responsePrefixLength));
        break;
      }
      if (!effectiveLimitSelected && value.byteLength > 0 && responsePrefixLength < responsePrefix.byteLength) {
        const prefixBytesRemaining = responsePrefix.byteLength - responsePrefixLength;
        const prefixPart = value.subarray(0, Math.min(value.byteLength, prefixBytesRemaining));
        responsePrefix.set(prefixPart, responsePrefixLength);
        responsePrefixLength += prefixPart.byteLength;
        if (responsePrefixLength === responsePrefix.byteLength) {
          selectEffectiveLimit(responsePrefix);
        }
      }
      total += value.byteLength;
      if (total > effectiveMaxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new OutboundResponseTooLargeError(effectiveMaxBytes);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

export async function safeFetchBytes(value: string, options: SafeOutboundFetchOptions): Promise<SafeOutboundFetchResult> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxRedirects = options.maxRedirects ?? 3;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  let current = value;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const resolved = await resolveSafeOutboundUrl(current, {
      allowedOrigin: options.allowedOrigin,
      resolver: options.resolver,
      signal
    });
    const dispatcher = createPinnedOutboundAgent(resolved.address, resolved.family);
    try {
      const response = await (options.fetcher ?? fetch)(resolved.url, {
        method: 'GET',
        headers: options.headers,
        redirect: 'manual',
        signal,
        dispatcher
      });
      if (redirectStatuses.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw new UnsafeOutboundUrlError('Outbound redirect has no location');
        if (redirectCount >= maxRedirects) throw new UnsafeOutboundUrlError('Outbound redirect limit exceeded');
        current = new URL(location, resolved.url).toString();
        continue;
      }
      const responseHeaders = response.headers as unknown as Headers;
      const responseUrl = resolved.url.toString();
      const bytes = await readBoundedResponseBytes(
        response as unknown as Response,
        options.maxBytes,
        options.responseMaxBytes
          ? (prefix) => options.responseMaxBytes!({
              url: responseUrl,
              status: response.status,
              headers: responseHeaders,
              prefix
            })
          : undefined
      );
      return {
        url: responseUrl,
        status: response.status,
        headers: responseHeaders,
        bytes
      };
    } finally {
      // This dispatcher owns only this request. The body has either been read,
      // cancelled, or failed; there is no shared work to drain. Graceful close
      // can wait for an aborted connection well beyond the request deadline.
      await dispatcher.destroy().catch(() => undefined);
    }
  }
  throw new UnsafeOutboundUrlError('Outbound redirect limit exceeded');
}

export function outboundText(result: SafeOutboundFetchResult) {
  return new TextDecoder('utf-8', { fatal: false }).decode(result.bytes);
}
