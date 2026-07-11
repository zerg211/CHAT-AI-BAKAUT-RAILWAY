import { fetch } from 'undici';
import { config } from '../config.js';
import type { ConversationSession, Lead, Message } from '../shared/types.js';

export interface EmailResult {
  ok: boolean;
  status?: number;
  response?: unknown;
  skipped?: boolean;
  error?: string;
}

interface EmailConversationContext {
  id: string;
  number: number;
  title: string;
  topic?: string | null;
  pageUrl?: string | null;
  createdAt: string;
}

interface EmailMessageContext {
  role: Message['role'];
  content: string;
  createdAt: string;
}

function parseRecipients(value?: string) {
  return (value ?? '')
    .split(',')
    .map((recipient) => recipient.trim())
    .filter(Boolean);
}

function isBlankCharacter(character: string) {
  return character.trim().length === 0;
}

function compactWhitespace(value: string) {
  let result = '';
  let previousWasBlank = false;
  for (const character of value) {
    if (isBlankCharacter(character)) {
      if (!previousWasBlank) result += ' ';
      previousWasBlank = true;
      continue;
    }
    result += character;
    previousWasBlank = false;
  }
  return result.trim();
}

function trimTrailingSlashes(value: string) {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

function lowerText(value: string) {
  return value.toLocaleLowerCase('ru-RU');
}

function hasLabelColon(line: string, label: string) {
  const normalizedLine = lowerText(line);
  const normalizedLabel = lowerText(label);
  if (!normalizedLine.startsWith(normalizedLabel)) return false;

  let index = normalizedLabel.length;
  while (index < normalizedLine.length && isBlankCharacter(normalizedLine[index] ?? '')) {
    index += 1;
  }
  return normalizedLine[index] === ':';
}

function equalsWithOptionalTrailingPeriod(line: string, expected: string) {
  const normalizedLine = lowerText(line);
  const normalizedExpected = lowerText(expected);
  return normalizedLine === normalizedExpected || normalizedLine === `${normalizedExpected}.`;
}

function isResendEndpoint(url: string) {
  try {
    const target = new URL(url);
    return target.hostname === 'api.resend.com' && trimTrailingSlashes(target.pathname) === '/emails';
  } catch {
    return false;
  }
}

function compactText(value: string, maxLength: number) {
  const normalized = compactWhitespace(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

function stripTranscriptFromQuestion(question?: string | null) {
  if (!question) return '';
  const lines: string[] = [];
  for (const rawLine of question.split('\r').join('').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (hasLabelColon(line, 'Последние сообщения')) break;
    if (hasLabelColon(line, 'user') || hasLabelColon(line, 'assistant') || hasLabelColon(line, 'system')) continue;
    if (equalsWithOptionalTrailingPeriod(line, 'Контакт оставлен покупателем прямо в чате')) continue;
    lines.push(line);
  }
  return compactText(lines.join('; '), 850);
}

function latestUserContext(messages: EmailMessageContext[]) {
  return compactText(
    messages
      .filter((message) => message.role === 'user')
      .slice(-3)
      .map((message) => message.content)
      .join(' / '),
    650
  );
}

function leadSummary(lead: Lead, conversation: EmailConversationContext | null, messages: EmailMessageContext[]) {
  const details = stripTranscriptFromQuestion(lead.question) || latestUserContext(messages);
  return compactText(
    [
      details || 'Клиент оставил контакт для связи.',
      conversation?.topic ? `Тема: ${conversation.topic}` : null
    ].filter(Boolean).join('; '),
    900
  );
}

function shortDialogueContext(messages: EmailMessageContext[]) {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-4)
    .map((message) => `${message.role}: ${compactText(message.content, 260)}`)
    .join('\n');
}

function leadSubject(lead: Lead, _conversation: EmailConversationContext | null) {
  const contact = lead.phone || lead.email;
  return `Новый лид из AI-чата: ${lead.name}${contact ? `, ${contact}` : ''}`;
}

function leadText(lead: Lead, conversation: EmailConversationContext | null, messages: EmailMessageContext[]) {
  const summary = leadSummary(lead, conversation, messages);
  const lines = [
    'Новый лид из AI-чата',
    '',
    'Контакт:',
    `Имя: ${lead.name}`,
    `Телефон: ${lead.phone || 'не указан'}`,
    `Email: ${lead.email || 'не указан'}`,
    '',
    `SUMMARY: ${summary}`,
    '',
    conversation ? `Номер диалога: ${conversation.number}` : null,
    conversation?.title ? `Диалог: ${conversation.title}` : null,
    conversation?.pageUrl ? `Страница: ${conversation.pageUrl}` : null
  ].filter(Boolean) as string[];

  const context = shortDialogueContext(messages);
  if (context) {
    lines.push('', 'Короткий контекст диалога:', context);
  }

  return lines.join('\n');
}

export async function sendLeadEmail(
  lead: Lead,
  context: { session?: ConversationSession | null; messages?: Message[] } = {}
): Promise<EmailResult> {
  if (!config.EMAIL_HTTP_URL) {
    return { ok: false, skipped: true, error: 'EMAIL_HTTP_URL is not configured' };
  }

  const from = config.EMAIL_FROM;
  const recipients = parseRecipients(config.LEADS_TO_EMAIL);
  if (!from || !recipients.length) {
    return { ok: false, error: 'EMAIL_FROM and LEADS_TO_EMAIL are required' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.EMAIL_HTTP_TIMEOUT_MS);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'Idempotency-Key': `bakaut-lead-${lead.id}`
  };

  if (config.EMAIL_HTTP_AUTH_HEADER) {
    const [name, ...valueParts] = config.EMAIL_HTTP_AUTH_HEADER.split(':');
    if (name && valueParts.length) headers[name.trim()] = valueParts.join(':').trim();
  }

  try {
    const conversation = context.session
      ? {
          id: context.session.id,
          number: context.session.conversationNumber,
          title: context.session.title,
          topic: context.session.topic,
          pageUrl: context.session.pageUrl,
          createdAt: context.session.createdAt
        }
      : null;
    const messages = (context.messages ?? []).map((message) => ({
      role: message.role,
      content: message.content,
      createdAt: message.createdAt
    }));
    const subject = leadSubject(lead, conversation);
    const text = leadText(lead, conversation, messages);
    const body = isResendEndpoint(config.EMAIL_HTTP_URL)
      ? {
          from,
          to: recipients,
          subject,
          text
        }
      : {
          idempotencyKey: `bakaut-lead-${lead.id}`,
          from,
          to: recipients.join(', '),
          subject,
          lead,
          conversation,
          messages,
          text
        };

    const response = await fetch(config.EMAIL_HTTP_URL, {
      method: config.EMAIL_HTTP_METHOD,
      headers,
      signal: controller.signal,
      body: JSON.stringify(body)
    });
    const textResponse = await response.text();
    let parsed: unknown = textResponse;
    try {
      parsed = JSON.parse(textResponse);
    } catch {
      // Provider can return plain text.
    }
    return { ok: response.ok, status: response.status, response: parsed };
  } catch (error) {
    return { ok: false, error: String(error) };
  } finally {
    clearTimeout(timeout);
  }
}
