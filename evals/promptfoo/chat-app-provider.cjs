const DEFAULT_BASE_URL = 'http://localhost:3010';
const DEFAULT_TIMEOUT_MS = 180000;

function readConfigValue(configValue, envName, fallback, options = {}) {
  const envValue = typeof process.env[envName] === 'string' && process.env[envName].trim()
    ? process.env[envName].trim()
    : '';
  if (options.preferEnv && envValue) return envValue;
  if (typeof configValue === 'string' && configValue.trim()) return configValue.trim();
  if (envValue) return envValue;
  return fallback;
}

function readNumberConfigValue(configValue, envName, fallback) {
  const raw = configValue ?? process.env[envName];
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseSseEvents(text) {
  return String(text)
    .split(/\r?\n\r?\n/u)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split(/\r?\n/u);
      const event = lines.find((line) => line.startsWith('event:'))?.replace(/^event:\s*/u, '').trim() || 'message';
      const dataText = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.replace(/^data:\s*/u, ''))
        .join('\n');
      let data = dataText;
      try {
        data = JSON.parse(dataText);
      } catch {
        // Keep raw SSE data for diagnostics.
      }
      return { event, data };
    });
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readSseResponseText(response) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    return { text: await response.text(), error: null };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { text, error: null };
  } catch (error) {
    text += decoder.decode();
    return { text, error };
  } finally {
    reader.releaseLock?.();
  }
}

async function postJson(url, body, timeoutMs) {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }, timeoutMs);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 1000)}`);
  }
  return text ? JSON.parse(text) : {};
}

function normalizeMessages(vars, prompt) {
  if (typeof vars.messagesJson === 'string' && vars.messagesJson.trim()) {
    const parsed = JSON.parse(vars.messagesJson);
    if (!Array.isArray(parsed)) throw new Error('messagesJson must be a JSON array of strings.');
    return parsed
      .map((message) => typeof message === 'string' ? message.trim() : '')
      .filter(Boolean);
  }
  if (Array.isArray(vars.messages)) {
    return vars.messages
      .map((message) => typeof message === 'string' ? message.trim() : '')
      .filter(Boolean);
  }
  if (typeof vars.messages === 'string' && vars.messages.trim().startsWith('[')) {
    const parsed = JSON.parse(vars.messages);
    if (!Array.isArray(parsed)) throw new Error('messages must be a JSON array of strings when provided as JSON.');
    return parsed
      .map((message) => typeof message === 'string' ? message.trim() : '')
      .filter(Boolean);
  }
  const single = String(vars.message ?? prompt ?? '').trim();
  return single ? [single] : [];
}

function latestDonePayload(events) {
  const done = [...events].reverse().find((event) => event.event === 'done');
  return done && typeof done.data === 'object' && done.data ? done.data : null;
}

function latestErrorPayload(events) {
  const error = [...events].reverse().find((event) => event.event === 'error');
  return error && typeof error.data === 'object' && error.data ? error.data : null;
}

function latestTurnPayload(events) {
  const turn = [...events].reverse().find((event) => event.event === 'turn');
  return turn && typeof turn.data === 'object' && turn.data ? turn.data : null;
}

function turnResultFromResponse(input) {
  const done = latestDonePayload(input.events);
  const error = latestErrorPayload(input.events);
  const turn = latestTurnPayload(input.events);
  const turnId = done?.turnId || error?.turnId || turn?.turnId || input.turnId || null;
  const transportError = input.transportError
    ? {
      error: input.transportError instanceof Error ? input.transportError.message : String(input.transportError),
      turnId,
      recoverable: Boolean(turnId),
      transport: true
    }
    : null;
  const missingDoneError = !done && !error && turnId
    ? {
      error: 'missing done payload',
      turnId,
      recoverable: true
    }
    : null;
  const rawError = error || transportError || missingDoneError;
  return {
    user: input.userMessage,
    ok: input.response.ok && Boolean(done) && !error,
    httpStatus: input.response.status,
    answer: done?.answer || '',
    productCards: Array.isArray(done?.productCards) ? done.productCards : [],
    usedWebSearch: Boolean(done?.usedWebSearch),
    leadRequested: Boolean(done?.leadRequested),
    leadCreated: Boolean(done?.leadCreated),
    metadata: done?.metadata || null,
    turnId,
    error: rawError?.error || (!input.response.ok ? `HTTP ${input.response.status}` : null),
    events: input.events.map((event) => event.event),
    rawError,
    recovered: Boolean(input.recovered)
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function recoverTurnWithRetries(input) {
  let lastResult = null;
  const attempts = input.attempts ?? 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) await sleep(input.delayMs ?? 5000);
    const recoveryResponse = await fetchWithTimeout(`${input.baseUrl}/api/chat/sessions/${input.sessionId}/messages/${input.turnId}/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    }, input.timeoutMs);
    const recoveryRawSse = await readSseResponseText(recoveryResponse);
    const recoveryEvents = parseSseEvents(recoveryRawSse.text);
    const recoveryResult = turnResultFromResponse({
      userMessage: input.userMessage,
      response: recoveryResponse,
      events: recoveryEvents,
      turnId: input.turnId,
      transportError: recoveryRawSse.error,
      recovered: true
    });
    lastResult = recoveryResult;
    if (recoveryResult.ok) return recoveryResult;
    const canRetry = recoveryResult.rawError?.recoverable || recoveryResult.rawError?.transport;
    if (!canRetry) return recoveryResult;
  }
  return lastResult;
}

async function sendMessageWithRetries(input) {
  let lastError = null;
  const attempts = input.attempts ?? 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) await sleep(input.delayMs ?? 5000);
    try {
      const response = await fetchWithTimeout(`${input.baseUrl}/api/chat/sessions/${input.sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: input.userMessage })
      }, input.timeoutMs);
      const rawSse = await readSseResponseText(response);
      const events = parseSseEvents(rawSse.text);
      return turnResultFromResponse({
        userMessage: input.userMessage,
        response,
        events,
        transportError: rawSse.error
      });
    } catch (error) {
      lastError = error;
    }
  }
  return {
    user: input.userMessage,
    ok: false,
    answer: '',
    productCards: [],
    metadata: null,
    error: lastError instanceof Error ? lastError.message : String(lastError),
    transportRetryExhausted: true
  };
}

class BakautChatAppProvider {
  constructor(options = {}) {
    this.config = options.config || {};
  }

  id() {
    return 'bakaut-chat-app-http-sse';
  }

  async callApi(prompt, context = {}) {
    const vars = context.vars || {};
    const baseUrl = readConfigValue(this.config.baseUrl, 'PROMPTFOO_CHAT_BASE_URL', DEFAULT_BASE_URL, { preferEnv: true }).replace(/\/+$/u, '');
    const timeoutMs = readNumberConfigValue(this.config.timeoutMs, 'PROMPTFOO_CHAT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    const pageUrl = readConfigValue(
      vars.pageUrl || this.config.pageUrl,
      'PROMPTFOO_CHAT_PAGE_URL',
      `${baseUrl}/widget?agentHarness=1`
    );
    const caseId = String(vars.caseId || context.test?.description || 'promptfoo-case');
    const messages = normalizeMessages(vars, prompt);
    const startedAt = new Date().toISOString();
    const turns = [];
    let sessionId = null;

    if (!messages.length) {
      return {
        output: JSON.stringify({
          caseId,
          providerError: 'no_messages_configured',
          turns: []
        }, null, 2)
      };
    }

    try {
      const sessionPayload = await postJson(`${baseUrl}/api/chat/sessions`, {
        visitorId: `promptfoo-${caseId}-${Date.now()}`,
        pageUrl
      }, timeoutMs);
      sessionId = sessionPayload.session?.id || null;
      if (!sessionId) throw new Error(`Session id missing in response: ${JSON.stringify(sessionPayload).slice(0, 1000)}`);

      for (const userMessage of messages) {
        const turnResult = await sendMessageWithRetries({
          baseUrl,
          sessionId,
          userMessage,
          timeoutMs,
          attempts: 3,
          delayMs: 5000
        });
        if (!turnResult.ok && turnResult.rawError?.recoverable && turnResult.turnId) {
          const recoveryResult = await recoverTurnWithRetries({
            baseUrl,
            sessionId,
            turnId: turnResult.turnId,
            userMessage,
            timeoutMs,
            attempts: 3,
            delayMs: 5000
          });
          if (recoveryResult?.ok) {
            turns.push(recoveryResult);
            continue;
          }
          turnResult.recovery = recoveryResult;
        }
        turns.push(turnResult);
        if (!turnResult.ok) break;
      }
    } catch (error) {
      turns.push({
        user: messages[turns.length] || null,
        ok: false,
        answer: '',
        productCards: [],
        metadata: null,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      if (sessionId) {
        await fetch(`${baseUrl}/api/chat/sessions/${sessionId}/close`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({})
        }).catch(() => undefined);
      }
    }

    const result = {
      caseId,
      baseUrl,
      pageUrl,
      sessionId,
      startedAt,
      finishedAt: new Date().toISOString(),
      turns,
      final: turns[turns.length - 1] || null
    };

    return {
      output: JSON.stringify(result, null, 2),
      metadata: result
    };
  }
}

module.exports = BakautChatAppProvider;
