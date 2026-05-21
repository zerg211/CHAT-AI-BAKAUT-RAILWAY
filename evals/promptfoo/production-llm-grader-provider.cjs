require('dotenv').config();

const DEFAULT_BASE_URL = 'https://chat-ai-production-3057.up.railway.app';
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 4000;
const DEFAULT_MAX_PROMPT_CHARS = 110000;
const DEFAULT_TEXT_FIELD_CHARS = 1800;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function tryParseJson(text) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return null;
  }
}

function trimText(value, maxChars = DEFAULT_TEXT_FIELD_CHARS) {
  if (value === null || value === undefined) return value;
  const text = String(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)} ... [truncated ${text.length - maxChars} chars]`;
}

function compactStringArray(value, maxItems = 12) {
  if (!Array.isArray(value)) return undefined;
  return value
    .slice(0, maxItems)
    .filter((item) => item !== null && item !== undefined)
    .map((item) => trimText(item, 400));
}

function compactLoad(load) {
  if (!isRecord(load)) return load;
  return {
    kind: load.kind ?? null,
    name: trimText(load.name, 300),
    count: load.count ?? null,
    runningKw: load.runningKw ?? null,
    startingKw: load.startingKw ?? null,
    source: load.source ?? null,
    basisKind: load.basisKind ?? null,
    basisSignals: compactStringArray(load.basisSignals, 8),
    evidence: trimText(load.evidence, 500)
  };
}

function compactProduct(card) {
  if (!isRecord(card)) return card;
  return {
    id: card.id ?? null,
    name: trimText(card.name ?? card.title ?? card.productName, 500),
    brand: card.brand ?? null,
    category: card.category ?? null,
    price: card.price ?? null,
    currency: card.currency ?? null,
    reasons: compactStringArray(card.reasons, 5),
    caveats: compactStringArray(card.caveats, 5)
  };
}

function compactToolRequest(request) {
  if (!isRecord(request)) return request;
  const args = isRecord(request.args) ? request.args : {};
  return {
    id: request.id ?? null,
    tool: request.tool ?? null,
    rationale: trimText(request.rationale, 700),
    required: request.required ?? null,
    args: {
      productIntent: args.productIntent ?? null,
      query: trimText(args.query, 900),
      semanticQuery: trimText(args.semanticQuery, 900),
      estimateBasis: args.estimateBasis ?? null,
      limit: args.limit ?? null,
      comparisonAttributes: compactStringArray(args.comparisonAttributes, 10),
      loads: Array.isArray(args.loads) ? args.loads.slice(0, 12).map(compactLoad) : undefined,
      simultaneousStarting: args.simultaneousStarting ?? null,
      simultaneousStartingKinds: compactStringArray(args.simultaneousStartingKinds, 8),
      reason: trimText(args.reason, 700),
      notes: trimText(args.notes, 700)
    }
  };
}

function compactGeneratorProfile(profile) {
  if (!isRecord(profile)) return profile;
  return {
    totalRunningKw: profile.totalRunningKw ?? null,
    requiredStartingKw: profile.requiredStartingKw ?? null,
    requiredNominalKw: profile.requiredNominalKw ?? null,
    simultaneousStarting: profile.simultaneousStarting ?? null,
    simultaneousStartingKinds: compactStringArray(profile.simultaneousStartingKinds, 8),
    calculation: trimText(profile.calculation, 900),
    confidence: profile.confidence ?? null,
    items: Array.isArray(profile.items) ? profile.items.slice(0, 12).map(compactLoad) : undefined
  };
}

function compactToolPayload(payload) {
  if (!isRecord(payload)) return payload;
  return {
    query: trimText(payload.query, 900),
    productIntent: payload.productIntent ?? null,
    estimateBasis: payload.estimateBasis ?? null,
    loads: Array.isArray(payload.loads) ? payload.loads.slice(0, 12).map(compactLoad) : undefined,
    profile: compactGeneratorProfile(payload.profile),
    products: Array.isArray(payload.products) ? payload.products.slice(0, 8).map(compactProduct) : undefined,
    results: Array.isArray(payload.results) ? payload.results.slice(0, 8).map(compactProduct) : undefined,
    reason: trimText(payload.reason, 700)
  };
}

function compactToolResult(result) {
  if (!isRecord(result)) return result;
  return {
    requestId: result.requestId ?? null,
    tool: result.tool ?? null,
    status: result.status ?? null,
    warnings: compactStringArray(result.warnings, 12),
    payload: compactToolPayload(result.payload)
  };
}

function compactAnswerContract(contract) {
  if (!isRecord(contract)) return contract;
  return {
    answerText: trimText(contract.answerText, 1800),
    leadAction: contract.leadAction ?? null,
    riskFlags: compactStringArray(contract.riskFlags, 10),
    questionsAsked: compactStringArray(contract.questionsAsked, 10),
    toolResultIds: compactStringArray(contract.toolResultIds, 10),
    selectionReadiness: contract.selectionReadiness ?? null,
    factsUsed: Array.isArray(contract.factsUsed)
      ? contract.factsUsed.slice(0, 10).map((fact) => isRecord(fact)
        ? {
            claim: trimText(fact.claim, 500),
            sourceEventIds: compactStringArray(fact.sourceEventIds, 6)
          }
        : fact)
      : undefined
  };
}

function compactMetadata(metadata) {
  if (!isRecord(metadata)) return metadata;
  const intentContract = isRecord(metadata.intentContract) ? metadata.intentContract : null;
  const cardSelection = isRecord(metadata.cardSelection) ? metadata.cardSelection : null;
  return {
    warnings: compactStringArray(metadata.warnings, 14),
    turnContract: metadata.turnContract ? {
      taskType: metadata.turnContract.taskType,
      validatorWarnings: compactStringArray(metadata.turnContract.validatorWarnings, 12)
    } : undefined,
    intentContract: intentContract ? {
      userMessageSummary: trimText(intentContract.userMessageSummary, 900),
      dialogueUnderstanding: trimText(intentContract.dialogueUnderstanding, 1200),
      nextStepRationale: trimText(intentContract.nextStepRationale, 1000),
      requiresTools: intentContract.requiresTools,
      riskFlags: compactStringArray(intentContract.riskFlags, 10),
      toolRequests: Array.isArray(intentContract.toolRequests)
        ? intentContract.toolRequests.slice(0, 8).map(compactToolRequest)
        : undefined
    } : undefined,
    toolResults: Array.isArray(metadata.toolResults) ? metadata.toolResults.slice(0, 8).map(compactToolResult) : undefined,
    answerContract: compactAnswerContract(metadata.answerContract),
    cardSelection: cardSelection ? {
      intent: cardSelection.intent,
      selectedProductIds: compactStringArray(cardSelection.selectedProductIds, 12),
      answerMentionedProductIds: compactStringArray(cardSelection.answerMentionedProductIds, 12),
      droppedProductIds: compactStringArray(cardSelection.droppedProductIds, 12),
      warnings: compactStringArray(cardSelection.warnings, 12),
      products: Array.isArray(cardSelection.products) ? cardSelection.products.slice(0, 8).map(compactProduct) : undefined,
      selectionReadiness: cardSelection.selectionReadiness
    } : undefined,
    selectionReadiness: metadata.selectionReadiness,
    postAnswerVerification: metadata.postAnswerVerification ? {
      status: metadata.postAnswerVerification.status,
      issues: Array.isArray(metadata.postAnswerVerification.issues)
        ? metadata.postAnswerVerification.issues.slice(0, 8)
        : undefined
    } : undefined
  };
}

function compactTurn(turn) {
  if (!isRecord(turn)) return turn;
  return {
    user: trimText(turn.user ?? turn.userMessage, 1200),
    ok: turn.ok ?? null,
    answer: trimText(turn.answer, 2400),
    usedWebSearch: turn.usedWebSearch ?? null,
    leadRequested: turn.leadRequested ?? null,
    productCards: Array.isArray(turn.productCards) ? turn.productCards.slice(0, 8).map(compactProduct) : [],
    metadata: compactMetadata(turn.metadata)
  };
}

function compactPromptfooOutput(rawOutput) {
  const parsed = tryParseJson(String(rawOutput || '').trim());
  if (!isRecord(parsed) || !Array.isArray(parsed.turns)) return trimText(rawOutput, 45000);
  const compact = {
    caseId: parsed.caseId ?? null,
    pageUrl: parsed.pageUrl ?? null,
    sessionId: parsed.sessionId ?? null,
    turns: parsed.turns.map(compactTurn),
    final: compactTurn(parsed.final ?? parsed.turns[parsed.turns.length - 1])
  };
  return JSON.stringify(compact, null, 2);
}

function findOutputRange(content) {
  const startMarkers = ['<Output>\n', '<Output>\r\n', '<Output>'];
  let start = -1;
  let startMarker = '';
  for (const marker of startMarkers) {
    start = content.indexOf(marker);
    if (start !== -1) {
      startMarker = marker;
      break;
    }
  }
  if (start === -1) return null;
  const outputStart = start + startMarker.length;
  const endMarkers = ['\n</Output>', '\r\n</Output>', '</Output>'];
  let end = -1;
  let endMarker = '';
  for (const marker of endMarkers) {
    end = content.indexOf(marker, outputStart);
    if (end !== -1) {
      endMarker = marker;
      break;
    }
  }
  if (end === -1) return null;
  return { outputStart, outputEnd: end, endMarker };
}

function compactOutputInContent(content) {
  const range = findOutputRange(content);
  if (!range) return content;
  const rawOutput = content.slice(range.outputStart, range.outputEnd);
  const compactOutput = compactPromptfooOutput(rawOutput);
  return [
    content.slice(0, range.outputStart),
    compactOutput,
    range.endMarker,
    content.slice(range.outputEnd + range.endMarker.length)
  ].join('');
}

function compactJudgePrompt(prompt, maxPromptChars = DEFAULT_MAX_PROMPT_CHARS) {
  const original = String(prompt || '');
  if (original.length <= maxPromptChars) return original;

  const parsed = tryParseJson(original);
  if (Array.isArray(parsed)) {
    const compactMessages = parsed.map((message) => {
      if (!isRecord(message) || typeof message.content !== 'string') return message;
      return { ...message, content: compactOutputInContent(message.content) };
    });
    const rendered = JSON.stringify(compactMessages);
    if (rendered.length <= maxPromptChars) return rendered;
    return trimText(rendered, maxPromptChars);
  }

  const compacted = compactOutputInContent(original);
  if (compacted.length <= maxPromptChars) return compacted;
  return trimText(compacted, maxPromptChars);
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
    const attempts = readNumberConfigValue(this.config.attempts, 'PROMPTFOO_CHAT_LLM_GRADER_ATTEMPTS', DEFAULT_ATTEMPTS);
    const retryDelayMs = readNumberConfigValue(this.config.retryDelayMs, 'PROMPTFOO_CHAT_RETRY_DELAY_MS', DEFAULT_RETRY_DELAY_MS);
    const maxPromptChars = readNumberConfigValue(this.config.maxPromptChars, 'PROMPTFOO_CHAT_LLM_GRADER_MAX_PROMPT_CHARS', DEFAULT_MAX_PROMPT_CHARS);
    const promptForJudge = compactJudgePrompt(prompt, maxPromptChars);
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) await sleep(retryDelayMs);
      try {
        const response = await fetchWithTimeout(`${baseUrl}/api/admin/evals/llm-rubric`, {
          method: 'POST',
          headers: {
            'authorization': `Bearer ${token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ prompt: promptForJudge })
        }, timeoutMs);
        const text = await response.text();
        let payload = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          lastError = `Production LLM grader returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`;
          continue;
        }
        if (!response.ok || !payload?.ok) {
          lastError = `Production LLM grader failed HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`;
          continue;
        }
        return {
          output: payload.result,
          metadata: {
            model: payload.model,
            productionLlmGrader: true,
            attempt,
            originalPromptChars: String(prompt || '').length,
            sentPromptChars: promptForJudge.length
          }
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      error: String(lastError || 'Production LLM grader failed without a detailed error.')
    };
  }
}

module.exports = BakautProductionLlmGraderProvider;
