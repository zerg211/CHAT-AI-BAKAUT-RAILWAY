import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const BakautChatAppProvider = require('../evals/promptfoo/chat-app-provider.cjs') as new (options?: {
  config?: Record<string, unknown>;
}) => {
  callApi: (prompt: string, context?: { vars?: Record<string, unknown> }) => Promise<{ output: string }>;
};

const originalFetch = global.fetch;

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function sseDoneResponse() {
  return new Response([
    'event: done',
    'data: {"turnId":"turn-1","answer":"Готово, подберу вариант.","productCards":[],"metadata":{}}',
    ''
  ].join('\n'), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('Promptfoo chat app provider', () => {
  it('retries chat session creation before running the dialogue', async () => {
    let sessionAttempts = 0;
    let messageAttempts = 0;

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/chat/sessions')) {
        sessionAttempts += 1;
        if (sessionAttempts === 1) throw new Error('fetch failed');
        return jsonResponse({ session: { id: 'session-1' } });
      }
      if (url.endsWith('/api/chat/sessions/session-1/messages')) {
        messageAttempts += 1;
        return sseDoneResponse();
      }
      if (url.endsWith('/api/chat/sessions/session-1/close')) {
        return jsonResponse({});
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    const provider = new BakautChatAppProvider({
      config: {
        baseUrl: 'https://chat.example.test',
        sessionAttempts: 2,
        retryDelayMs: 1
      }
    });

    const result = await provider.callApi('provider-retry', {
      vars: {
        caseId: 'provider-retry',
        messagesJson: '["Здравствуйте"]'
      }
    });
    const output = JSON.parse(result.output);

    expect(sessionAttempts).toBe(2);
    expect(messageAttempts).toBe(1);
    expect(output.sessionId).toBe('session-1');
    expect(output.turns[0].ok).toBe(true);
  });
});
