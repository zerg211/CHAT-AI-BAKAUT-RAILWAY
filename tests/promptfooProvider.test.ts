import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const BakautChatAppProvider = require('../evals/promptfoo/chat-app-provider.cjs') as new (options?: {
  config?: Record<string, unknown>;
}) => {
  callApi: (prompt: string, context?: { vars?: Record<string, unknown> }) => Promise<{ output: string }>;
};
const BakautProductionLlmGraderProvider = require('../evals/promptfoo/production-llm-grader-provider.cjs') as new (options?: {
  config?: Record<string, unknown>;
}) => {
  callApi: (prompt: string) => Promise<{ output?: unknown; error?: string; metadata?: Record<string, unknown> }>;
};

const originalFetch = global.fetch;
const originalAdminToken = process.env.PROMPTFOO_CHAT_ADMIN_TOKEN;

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
  if (originalAdminToken === undefined) {
    delete process.env.PROMPTFOO_CHAT_ADMIN_TOKEN;
  } else {
    process.env.PROMPTFOO_CHAT_ADMIN_TOKEN = originalAdminToken;
  }
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

  it('uses the production admin judge endpoint for LLM grading', async () => {
    process.env.PROMPTFOO_CHAT_ADMIN_TOKEN = 'test-admin-token';
    let receivedPrompt = '';
    let receivedAuthorization = '';

    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith('/api/admin/evals/llm-rubric')) {
        throw new Error(`Unexpected fetch ${url}`);
      }
      receivedAuthorization = String(init?.headers && typeof init.headers === 'object'
        ? (init.headers as Record<string, string>).authorization
        : '');
      const body = JSON.parse(String(init?.body || '{}'));
      receivedPrompt = body.prompt;
      return jsonResponse({
        ok: true,
        model: 'gpt-5.4-mini',
        result: {
          pass: true,
          score: 0.96,
          reason: 'Helpful and grounded.'
        }
      });
    }) as typeof fetch;

    const provider = new BakautProductionLlmGraderProvider({
      config: {
        baseUrl: 'https://chat.example.test/',
        timeoutMs: 1000
      }
    });

    const result = await provider.callApi('Rendered rubric prompt');

    expect(receivedAuthorization).toBe('Bearer test-admin-token');
    expect(receivedPrompt).toBe('Rendered rubric prompt');
    expect(result.output).toEqual({
      pass: true,
      score: 0.96,
      reason: 'Helpful and grounded.'
    });
    expect(result.metadata?.productionLlmGrader).toBe(true);
  });
});
