import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { fetch as undiciFetch } from 'undici';
import {
  createPinnedOutboundAgent,
  OutboundResponseTooLargeError,
  UnsafeOutboundUrlError,
  isPrivateOrReservedIp,
  readBoundedResponseBytes,
  resolveSafeOutboundUrl,
  safeFetchBytes
} from '../src/security/outboundHttp.js';

describe('safe outbound HTTP', () => {
  it('uses the production pinned dispatcher with a real undici request when lookup asks for all addresses', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('pinned lookup ok');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server address');
    const dispatcher = createPinnedOutboundAgent('127.0.0.1', 4);

    try {
      const response = await undiciFetch(`http://pinned-outbound.test:${address.port}`, { dispatcher });
      expect(await response.text()).toBe('pinned lookup ok');
    } finally {
      await dispatcher.close();
      server.close();
      await once(server, 'close');
    }
  });

  it('rejects private, loopback, link-local, documentation, and mapped addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '192.0.2.10',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::7f00:1',
      '::a00:1',
      '64:ff9b::7f00:1'
    ]) expect(isPrivateOrReservedIp(address)).toBe(true);
    expect(isPrivateOrReservedIp('93.184.216.34')).toBe(false);
    expect(isPrivateOrReservedIp('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
  });

  it('rejects local DNS answers and URLs outside an exact catalog origin', async () => {
    const localResolver = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
    await expect(resolveSafeOutboundUrl('https://example.com/file', { resolver: localResolver as never }))
      .rejects.toBeInstanceOf(UnsafeOutboundUrlError);
    await expect(resolveSafeOutboundUrl('https://evil.example/file', {
      allowedOrigin: 'https://bakautprof.ru',
      resolver: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) as never
    })).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
  });

  it('enforces byte limits from both content-length and streamed bytes', async () => {
    await expect(readBoundedResponseBytes(new Response('12345', {
      headers: { 'content-length': '5' }
    }), 4)).rejects.toBeInstanceOf(OutboundResponseTooLargeError);
    await expect(readBoundedResponseBytes(new Response('12345'), 4))
      .rejects.toBeInstanceOf(OutboundResponseTooLargeError);
  });

  it('selects a stricter response limit from bounded prefix bytes', async () => {
    const resolver = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
    const responseMaxBytes = ({ prefix }: { prefix: Uint8Array }) => {
      const prefixText = new TextDecoder().decode(prefix);
      return prefixText.includes('%PDF-') ? 16 : 4;
    };

    const pdf = await safeFetchBytes('https://public.example/download', {
      maxBytes: 16,
      responseMaxBytes,
      resolver: resolver as never,
      fetcher: vi.fn(async () => new Response('%PDF-12345', {
        headers: { 'content-type': 'text/plain' }
      })) as never
    });
    expect(new TextDecoder().decode(pdf.bytes)).toBe('%PDF-12345');

    await expect(safeFetchBytes('https://public.example/page', {
      maxBytes: 16,
      responseMaxBytes,
      resolver: resolver as never,
      fetcher: vi.fn(async () => new Response('12345', {
        headers: { 'content-type': 'text/html' }
      })) as never
    })).rejects.toMatchObject({ maxBytes: 4 });
  });

  it('detects PDF magic split across response chunks before selecting the limit', async () => {
    const encoder = new TextEncoder();
    const htmlLimitBytes = 2 * 1024 * 1024;
    const pdfLimitBytes = 8 * 1024 * 1024;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('%P'));
        controller.enqueue(encoder.encode('DF-'));
        controller.enqueue(new Uint8Array(htmlLimitBytes));
        controller.close();
      }
    });

    const result = await safeFetchBytes('https://public.example/download', {
      maxBytes: pdfLimitBytes,
      responseMaxBytes: ({ prefix }) =>
        new TextDecoder().decode(prefix).includes('%PDF-') ? pdfLimitBytes : htmlLimitBytes,
      resolver: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) as never,
      fetcher: vi.fn(async () => new Response(body, {
        headers: { 'content-type': 'text/plain' }
      })) as never
    });

    expect(result.bytes.byteLength).toBeGreaterThan(htmlLimitBytes);
    expect(new TextDecoder().decode(result.bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('revalidates every redirect and blocks a redirect to a private destination', async () => {
    const resolver = vi.fn(async (hostname: string) => hostname === 'public.example'
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }]);
    const fetcher = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'http://private.example/metadata' }
    }));

    await expect(safeFetchBytes('https://public.example/start', {
      maxBytes: 1024,
      resolver: resolver as never,
      fetcher: fetcher as never
    })).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it('includes DNS resolution in the overall timeout and ignores a late DNS result', async () => {
    let resolveDns!: (addresses: Array<{ address: string; family: 4 }>) => void;
    const resolver = vi.fn(() => new Promise<Array<{ address: string; family: 4 }>>((resolve) => {
      resolveDns = resolve;
    }));
    const fetcher = vi.fn();

    const request = safeFetchBytes('https://slow-dns.example/file', {
      maxBytes: 1024,
      timeoutMs: 20,
      resolver: resolver as never,
      fetcher: fetcher as never
    });

    await expect(request).rejects.toMatchObject({ name: 'TimeoutError' });
    resolveDns([{ address: '93.184.216.34', family: 4 }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetcher).not.toHaveBeenCalled();
  });
});
