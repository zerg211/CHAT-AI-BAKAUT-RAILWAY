require('dotenv').config();

const DEFAULT_BASE_URL = 'https://chat-ai-production-3057.up.railway.app';
const DEFAULT_TIMEOUT_MS = 180000;

function stripTrailingSlashes(value) {
  let text = String(value || '');
  while (text.endsWith('/')) text = text.slice(0, -1);
  return text;
}

function readConfigValue(configValue, envName, fallback) {
  const envValue = typeof process.env[envName] === 'string' && process.env[envName].trim()
    ? process.env[envName].trim()
    : '';
  if (typeof configValue === 'string' && configValue.trim()) return configValue.trim();
  if (envValue) return envValue;
  return fallback;
}

function readNumberConfigValue(configValue, envName, fallback) {
  const raw = configValue ?? process.env[envName];
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function adminToken() {
  return process.env.PROMPTFOO_CHAT_ADMIN_TOKEN ||
    process.env.ADMIN_API_KEY ||
    process.env.ADMIN_PASSWORD ||
    '';
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

class BakautProductionLlmGraderProvider {
  constructor(options = {}) {
    this.config = options.config || {};
  }

  id() {
    return 'bakaut-production-llm-grader';
  }

  async callApi(prompt) {
    const token = adminToken();
    if (!token) {
      return {
        error: 'Missing PROMPTFOO_CHAT_ADMIN_TOKEN, ADMIN_API_KEY, or ADMIN_PASSWORD for production LLM grader.'
      };
    }

    const baseUrl = stripTrailingSlashes(readConfigValue(
      this.config.baseUrl,
      'PROMPTFOO_CHAT_BASE_URL',
      DEFAULT_BASE_URL
    ));
    const timeoutMs = readNumberConfigValue(this.config.timeoutMs, 'PROMPTFOO_CHAT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    const response = await fetchWithTimeout(`${baseUrl}/api/admin/evals/llm-rubric`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ prompt: String(prompt || '') })
    }, timeoutMs);
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      return {
        error: `Production LLM grader returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`
      };
    }
    if (!response.ok || !payload?.ok) {
      return {
        error: `Production LLM grader failed HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`
      };
    }
    return {
      output: payload.result,
      metadata: {
        model: payload.model,
        productionLlmGrader: true
      }
    };
  }
}

module.exports = BakautProductionLlmGraderProvider;
