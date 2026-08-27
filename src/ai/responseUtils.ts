import { config } from '../config.js';
import { recordOpenAIUsageOnce } from './openaiUsageGuard.js';

export type WebCitation = {
  url: string;
  title?: string;
  snippet?: string;
};

export function safeError(error: unknown) {
  if (!error || typeof error !== 'object') return { message: String(error) };
  const value = error as { name?: string; status?: number; code?: unknown; message?: string; retryReason?: string };
  return {
    name: value.name,
    status: value.status,
    code: value.code === undefined || value.code === null ? undefined : String(value.code),
    message: value.message,
    retryReason: value.retryReason
  };
}

export function logOpenAIUsage(stage: string, model: string, response: unknown) {
  if (!response || typeof response !== 'object') return;
  void recordOpenAIUsageOnce(stage, model, response);
  if (!config.DEBUG_OPENAI_USAGE) return;
  const usage = (response as { usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
  } }).usage;
  if (!usage) return;
  console.info('OpenAI usage', {
    stage,
    model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
    totalTokens: usage.total_tokens
  });
}

function hasTypeSignal(type: string, signals: string[]) {
  const normalized = type.toLocaleLowerCase('en-US');
  return signals.some((signal) => normalized.includes(signal));
}

export function responseUsedWebSearch(value: unknown) {
  if (!value) return false;
  if (extractUrlCitations(value).length > 0) return true;
  return hasResponseNode(value, (object) => {
    const type = typeof object.type === 'string' ? object.type : '';
    return hasTypeSignal(type, ['web_search', 'search_result', 'url_citation']);
  });
}

export function extractResponseText(value: unknown, depth = 0): string {
  if (!value || depth > 8) return '';
  if (typeof value === 'string') return '';
  if (Array.isArray(value)) {
    return value.map((item) => extractResponseText(item, depth + 1)).filter(Boolean).join('\n').trim();
  }
  if (typeof value !== 'object') return '';

  const object = value as Record<string, unknown>;
  const objectType = typeof object.type === 'string' ? object.type : '';
  if (typeof object.output_text === 'string' && object.output_text.trim()) return object.output_text.trim();
  if (
    typeof object.text === 'string'
    && object.text.trim()
    && (!objectType || hasTypeSignal(objectType, ['output_text', 'message', 'text']))
  ) {
    return object.text.trim();
  }

  const contentText = extractResponseText(object.content, depth + 1);
  if (contentText) return contentText;
  const outputText = extractResponseText(object.output, depth + 1);
  if (outputText) return outputText;
  const messageText = extractResponseText(object.message, depth + 1);
  if (messageText) return messageText;
  return '';
}

function hasResponseNode(value: unknown, predicate: (object: Record<string, unknown>) => boolean, depth = 0): boolean {
  if (!value || depth > 8) return false;
  if (Array.isArray(value)) return value.some((item) => hasResponseNode(item, predicate, depth + 1));
  if (typeof value !== 'object') return false;

  const object = value as Record<string, unknown>;
  if (predicate(object)) return true;
  return Object.values(object).some((item) => hasResponseNode(item, predicate, depth + 1));
}

export function extractUrlCitations(value: unknown, depth = 0): WebCitation[] {
  if (!value || depth > 8) return [];
  if (Array.isArray(value)) return value.flatMap((item) => extractUrlCitations(item, depth + 1));
  if (typeof value !== 'object') return [];

  const object = value as Record<string, unknown>;
  const type = typeof object.type === 'string' ? object.type : '';
  const url = typeof object.url === 'string' ? object.url : undefined;
  const isCitation = Boolean(url && hasTypeSignal(type, ['url_citation', 'web_search', 'search_result', 'citation']));
  const own: WebCitation[] = isCitation && url
    ? [{
        url,
        title: typeof object.title === 'string' ? object.title : undefined,
        snippet: typeof object.snippet === 'string' ? object.snippet : undefined
      }]
    : [];

  return [
    ...own,
    ...Object.values(object).flatMap((item) => extractUrlCitations(item, depth + 1))
  ].filter((citation, index, all) => all.findIndex((item) => item.url === citation.url) === index);
}
