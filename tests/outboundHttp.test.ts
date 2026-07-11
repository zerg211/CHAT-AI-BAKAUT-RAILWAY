import { describe, expect, it, vi } from 'vitest';
import {
  OutboundResponseTooLargeError,
  UnsafeOutboundUrlError,
  isPrivateOrReservedIp,
  readBoundedResponseBytes,
  resolveSafeOutboundUrl,
  safeFetchBytes
} from '../src/security/outboundHttp.js';

describe('safe outbound HTTP', () => {
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
});
