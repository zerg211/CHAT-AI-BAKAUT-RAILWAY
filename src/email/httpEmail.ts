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

export async function sendLeadEmail(
  lead: Lead,
  context: { session?: ConversationSession | null; messages?: Message[] } = {}
): Promise<EmailResult> {
  if (!config.EMAIL_HTTP_URL) {
    return { ok: false, skipped: true, error: 'EMAIL_HTTP_URL is not configured' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.EMAIL_HTTP_TIMEOUT_MS);
  const headers: Record<string, string> = {
    'content-type': 'application/json'
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

    const response = await fetch(config.EMAIL_HTTP_URL, {
      method: config.EMAIL_HTTP_METHOD,
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        from: config.EMAIL_FROM,
        to: config.LEADS_TO_EMAIL,
        subject: `Новая заявка из AI-чата${conversation?.title ? `: ${conversation.title}` : `: ${lead.name}`}`,
        lead,
        conversation,
        messages,
        text: [
          `Новая заявка из AI-чата`,
          conversation?.title ? `Диалог: ${conversation.title}` : null,
          `Имя: ${lead.name}`,
          lead.phone ? `Телефон: ${lead.phone}` : null,
          lead.email ? `Email: ${lead.email}` : null,
          lead.question ? `Вопрос: ${lead.question}` : null
        ].filter(Boolean).join('\n')
      })
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
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
