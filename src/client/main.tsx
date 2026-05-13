import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { streamChatMessage } from './chatStream';
import { submitLead } from './leadSubmit';
import type { CardDisplayOptions, ChatResponsePayload, ConversationSession, ConversationSummary, Lead, Message, ProductCard } from '../shared/types';
import './styles.css';

type ChatMessage = {
  id: string;
  serverId?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  cards?: ProductCard[];
  cardDisplay?: CardDisplayOptions;
  leadRequested?: boolean;
  metadata?: ChatResponsePayload['metadata'];
  status?: 'sending' | 'done' | 'stopped' | 'error';
  progress?: string;
  feedback?: FeedbackRating;
};

type FeedbackRating = 'positive' | 'negative' | 'wrong_cards';

type LeadForm = {
  name: string;
  phone: string;
  email: string;
  question: string;
};

type AdminConversationDetail = {
  session: ConversationSession;
  messages: Message[];
};

type AdminConversationStats = {
  totalSessions: number;
  sessionsWithMessages: number;
  emptySessions: number;
  totalMessages: number;
};

type AdminFilter = 'today' | 'all' | 'active' | 'withLeads' | 'empty';
type AdminSource = 'local' | 'production';

const PRODUCTION_ADMIN_BASE_URL = 'https://chat-ai-production-3057.up.railway.app';

function isLoopbackHost(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function localAdminBaseUrl() {
  const isApiOrigin = isLoopbackHost(window.location.hostname) && (!window.location.port || window.location.port === '3010');
  return isApiOrigin ? '' : 'http://127.0.0.1:3010';
}

function shouldShowAiDiagnostics() {
  return isLoopbackHost(window.location.hostname);
}

function shortDiagnosticReason(reason: unknown) {
  const value = String(reason ?? '').trim();
  if (!value) return 'unknown';
  return value.length > 140 ? `${value.slice(0, 137)}...` : value;
}

function aiFallbackLabels(metadata?: ChatResponsePayload['metadata']) {
  const diagnostics = metadata?.aiDiagnostics;
  const labels: string[] = [];
  if (diagnostics?.needExtractionFallback?.used) {
    labels.push(`need: ${shortDiagnosticReason(diagnostics.needExtractionFallback.reason)}`);
  }
  if (diagnostics?.turnPlanningFallback?.used) {
    labels.push(`planner: ${shortDiagnosticReason(diagnostics.turnPlanningFallback.reason)}`);
  }
  const answerFallback = diagnostics?.answerGenerationFallback ?? metadata?.answerGenerationFallback;
  if (answerFallback?.used) {
    labels.push(`answer: ${shortDiagnosticReason(answerFallback.reason)}`);
  }
  return labels;
}

function AiDiagnosticsBadge({ metadata }: { metadata?: ChatResponsePayload['metadata'] }) {
  const labels = aiFallbackLabels(metadata);
  if (!shouldShowAiDiagnostics() || !labels.length) return null;
  return (
    <div className="ai-diagnostics" title="Developer-only diagnostic. Hidden from normal production visitors.">
      <strong>AI fallback</strong>
      <span>{labels.join(' | ')}</span>
    </div>
  );
}

const ADMIN_SOURCES: Record<AdminSource, { label: string; baseUrl: string; storageKey: string; hint: string }> = {
  local: {
    label: 'Локально',
    baseUrl: localAdminBaseUrl(),
    storageKey: 'bakaut_admin_password_local',
    hint: localAdminBaseUrl() || window.location.host
  },
  production: {
    label: 'Прод',
    baseUrl: PRODUCTION_ADMIN_BASE_URL,
    storageKey: 'bakaut_admin_password_production',
    hint: 'Railway production'
  }
};

function initialAdminSource(): AdminSource {
  return window.location.hostname.includes('railway.app') ? 'production' : 'local';
}

function storedAdminToken(source: AdminSource) {
  return sessionStorage.getItem(ADMIN_SOURCES[source].storageKey) ?? '';
}

function adminTokenHint(source: AdminSource) {
  if (source === 'production') return 'Пароль задается переменной ADMIN_PASSWORD в Railway Variables.';
  return 'Пароль задается переменной ADMIN_PASSWORD в локальном .env. Без пароля админка закрыта.';
}

function adminLoadErrorMessage(error: unknown, source: AdminSource) {
  if (error instanceof Error) {
    if (source === 'local' && /failed to fetch|networkerror|load failed/i.test(error.message)) {
      return 'Не удалось подключиться к локальному серверу http://127.0.0.1:3010. Проверьте, что локальный проект запущен.';
    }
    return error.message;
  }
  return 'Не удалось загрузить данные';
}

function clearLegacyAdminTokens() {
  localStorage.removeItem('bakaut_admin_token');
  localStorage.removeItem('bakaut_admin_token_local');
  localStorage.removeItem('bakaut_admin_token_production');
}

async function adminResponseError(response: Response, fallback: string) {
  try {
    const body = await response.json() as { error?: string };
    return body.error || fallback;
  } catch {
    return fallback;
  }
}

const apiBase = '';

function id() {
  return Math.random().toString(36).slice(2);
}

function nowIso() {
  return new Date().toISOString();
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatDateTime(value?: string | null) {
  if (!value) return 'нет сообщений';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function isTodayDate(value?: string | null) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const today = new Date();
  return date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
}

function shortText(value?: string | null, max = 120) {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function safeHref(value: string) {
  try {
    const url = new URL(value, window.location.origin);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function renderBold(text: string, keyPrefix: string) {
  const nodes: React.ReactNode[] = [];
  const bold = /\*\*([^*\n][\s\S]*?)\*\*/g;
  let lastIndex = 0;
  let index = 0;
  for (const match of text.matchAll(bold)) {
    if (match.index === undefined) continue;
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    nodes.push(<strong key={`${keyPrefix}-b-${index}`}>{match[1]}</strong>);
    lastIndex = match.index + match[0].length;
    index += 1;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function renderInlineMarkdown(text: string, keyPrefix: string) {
  const nodes: React.ReactNode[] = [];
  const link = /\[([^\]\n]{1,160})\]\((https?:\/\/[^)\s]+)\)/g;
  let lastIndex = 0;
  let index = 0;
  for (const match of text.matchAll(link)) {
    if (match.index === undefined) continue;
    if (match.index > lastIndex) nodes.push(...renderBold(text.slice(lastIndex, match.index), `${keyPrefix}-t-${index}`));
    const href = safeHref(match[2]);
    if (href) {
      nodes.push(
        <a key={`${keyPrefix}-link-${index}`} href={href} target="_blank" rel="noreferrer">
          {match[1]}
        </a>
      );
    } else {
      nodes.push(match[0]);
    }
    lastIndex = match.index + match[0].length;
    index += 1;
  }
  if (lastIndex < text.length) nodes.push(...renderBold(text.slice(lastIndex), `${keyPrefix}-t-${index}`));
  return nodes;
}

function splitInlineMarkdownTableRows(line: string) {
  const rows = [...line.matchAll(/\|[^|\n]+(?:\|[^|\n]+){2,}\|/g)];
  if (rows.length < 2) return [line];
  const parts: string[] = [];
  let cursor = 0;
  for (const row of rows) {
    const start = row.index ?? 0;
    if (start > cursor) {
      const prefix = line.slice(cursor, start).trim();
      if (prefix) parts.push(prefix);
    }
    parts.push(row[0].trim());
    cursor = start + row[0].length;
  }
  const suffix = line.slice(cursor).trim();
  if (suffix) parts.push(suffix);
  return parts;
}

function markdownTableCells(line: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  const cells = trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function isMarkdownTableSeparator(line: string) {
  const cells = markdownTableCells(line);
  return Boolean(cells?.length && cells.every((cell) => /^:?-{3,}:?$/.test(cell)));
}

function renderMarkdownText(text: string) {
  const nodes: React.ReactNode[] = [];
  const paragraph: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let listItems: string[] = [];
  let tableRows: string[][] = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    const value = paragraph.join('\n').trim();
    if (value) {
      nodes.push(<p key={`p-${nodes.length}`}>{renderInlineMarkdown(value, `p-${nodes.length}`)}</p>);
    }
    paragraph.length = 0;
  }

  function flushList() {
    if (!listType || !listItems.length) return;
    const Tag = listType;
    nodes.push(
      <Tag key={`list-${nodes.length}`}>
        {listItems.map((item, index) => (
          <li key={`li-${index}`}>{renderInlineMarkdown(item, `li-${nodes.length}-${index}`)}</li>
        ))}
      </Tag>
    );
    listType = null;
    listItems = [];
  }

  function flushTable() {
    if (!tableRows.length) return;
    const [head, ...body] = tableRows;
    nodes.push(
      <div className="markdown-table-wrap" key={`table-${nodes.length}`}>
        <table className="markdown-table">
          <thead>
            <tr>{head.map((cell, index) => <th key={`th-${index}`}>{renderInlineMarkdown(cell, `th-${nodes.length}-${index}`)}</th>)}</tr>
          </thead>
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={`tr-${rowIndex}`}>
                {row.map((cell, cellIndex) => <td key={`td-${cellIndex}`}>{renderInlineMarkdown(cell, `td-${nodes.length}-${rowIndex}-${cellIndex}`)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
    tableRows = [];
  }

  const lines = text.split(/\r?\n/).flatMap(splitInlineMarkdownTableRows);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      flushTable();
      continue;
    }

    if (isMarkdownTableSeparator(trimmed)) {
      flushParagraph();
      flushList();
      continue;
    }

    const tableCells = markdownTableCells(trimmed);
    if (tableCells) {
      flushParagraph();
      flushList();
      tableRows.push(tableCells);
      continue;
    }

    flushTable();

    if (/^-{3,}$/.test(trimmed)) {
      flushParagraph();
      flushList();
      nodes.push(<hr key={`hr-${nodes.length}`} />);
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      nodes.push(<h4 key={`h-${nodes.length}`}>{renderInlineMarkdown(heading[2], `h-${nodes.length}`)}</h4>);
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    const ordered = /^\d+[.)]\s+(.+)$/.exec(trimmed);
    if (bullet || ordered) {
      flushParagraph();
      const nextType = bullet ? 'ul' : 'ol';
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push((bullet ?? ordered)?.[1] ?? trimmed);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  flushTable();
  return nodes;
}

function getPageUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('pageUrl') ?? document.referrer ?? window.location.href;
}

function createClientId() {
  return globalThis.crypto?.randomUUID?.() ?? `visitor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function createSession(createIfMissing = false) {
  const existing = sessionStorage.getItem('bakaut_session_id');
  if (existing) {
    const heartbeat = await fetch(`${apiBase}/api/chat/sessions/${existing}/heartbeat`, { method: 'POST' }).catch(() => null);
    if (heartbeat?.ok) return existing;
    sessionStorage.removeItem('bakaut_session_id');
  }

  if (!createIfMissing) return null;

  const response = await fetch(`${apiBase}/api/chat/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      visitorId: localStorage.getItem('bakaut_visitor_id') ?? createClientId(),
      pageUrl: getPageUrl()
    })
  });
  if (!response.ok) throw new Error('Не удалось создать сессию');
  const data = (await response.json()) as { session: ConversationSession };
  localStorage.setItem('bakaut_visitor_id', data.session.visitorId ?? createClientId());
  sessionStorage.setItem('bakaut_session_id', data.session.id);
  return data.session.id;
}

async function sendAssistantFeedback(sessionId: string, messageId: string, rating: FeedbackRating) {
  const response = await fetch(`${apiBase}/api/chat/sessions/${sessionId}/messages/${messageId}/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rating })
  });
  if (!response.ok) throw new Error('feedback failed');
}

const INITIAL_VISIBLE_CARDS = 7;
const SHOW_ALL_CARD_COUNT = 10;

function ProductCards({ cards, initialVisibleCount }: { cards: ProductCard[]; initialVisibleCount?: number }) {
  const [expanded, setExpanded] = useState(false);
  if (!cards.length) return null;

  const initialCount = initialVisibleCount
    ? Math.max(1, Math.min(cards.length, Math.floor(initialVisibleCount)))
    : cards.length <= SHOW_ALL_CARD_COUNT ? cards.length : INITIAL_VISIBLE_CARDS;
  const visibleCards = expanded ? cards : cards.slice(0, initialCount);
  const hiddenCount = Math.max(0, cards.length - visibleCards.length);
  const countLabel = cards.length >= 50 ? `показано ${cards.length}` : `${cards.length} шт.`;

  return (
    <div className="product-panel" aria-label="Подобранные товары">
      <div className="product-panel-head">
        <span>Подходящие варианты</span>
        <span>{countLabel}</span>
      </div>
      <div className="product-grid">
        {visibleCards.map((card) => (
          <article className="product-card" key={card.id}>
            <div className="product-media">
              {card.imageUrl ? <img src={card.imageUrl} alt="" loading="lazy" /> : <div className="product-image-empty" />}
            </div>
            <div className="product-body">
              <h3>{card.name}</h3>
              <p className="product-meta">{[card.brand, card.category].filter(Boolean).join(' · ')}</p>
              {card.price ? (
                <p className="product-price">{card.price.toLocaleString('ru-RU')} {card.currency ?? 'RUB'}</p>
              ) : (
                <p className="product-price muted">Цена требует уточнения</p>
              )}
              <ul>
                {card.reasons.slice(0, 2).map((reason) => <li key={reason}>{reason}</li>)}
              </ul>
              {card.sourceUrl ? <a href={card.sourceUrl} target="_blank" rel="noreferrer">Открыть карточку</a> : null}
            </div>
          </article>
        ))}
      </div>
      {cards.length > initialCount ? (
        <button className="product-more" type="button" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Свернуть' : `Показать еще ${hiddenCount}`}
        </button>
      ) : null}
    </div>
  );
}

function LeadPanel({ sessionId, latestQuestion, autoOpenKey }: { sessionId: string | null; latestQuestion: string; autoOpenKey: number }) {
  const [form, setForm] = useState<LeadForm>({ name: '', phone: '', email: '', question: latestQuestion });
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [expanded, setExpanded] = useState(false);
  const lastAutoQuestionRef = useRef(latestQuestion);

  useEffect(() => {
    setForm((current) => {
      const shouldRefresh = !current.question || current.question === lastAutoQuestionRef.current;
      return shouldRefresh ? { ...current, question: latestQuestion } : current;
    });
    lastAutoQuestionRef.current = latestQuestion;
  }, [latestQuestion]);

  useEffect(() => {
    if (autoOpenKey > 0) setExpanded(true);
  }, [autoOpenKey]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setStatus('sending');
    try {
      await submitLead(apiBase, {
        sessionId: sessionId ?? undefined,
        name: form.name,
        phone: form.phone || undefined,
        email: form.email || undefined,
        question: form.question || latestQuestion
      });
      setStatus('sent');
      setForm({ name: '', phone: '', email: '', question: '' });
    } catch (submitError) {
      setStatus('error');
    }
  }

  return (
    <form className={`lead-panel ${expanded ? 'expanded' : 'collapsed'}`} onSubmit={submit}>
      <div className="lead-head">
        <div className="lead-title-row">
          <h2>Передать специалисту</h2>
          {expanded ? (
            <button className="lead-collapse" type="button" aria-label="Свернуть форму заявки" onClick={() => setExpanded(false)}>
              Свернуть
            </button>
          ) : null}
        </div>
        <p>Оставьте контакт, если нужно уточнить наличие, доставку или условия заказа.</p>
      </div>
      {expanded ? (
        <>
          <input
            aria-label="Имя"
            placeholder="Имя"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            required
          />
          <input
            aria-label="Телефон"
            placeholder="Телефон"
            value={form.phone}
            onChange={(event) => setForm({ ...form, phone: event.target.value })}
          />
          <input
            aria-label="Email"
            placeholder="Email"
            type="email"
            value={form.email}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
          />
          <textarea
            aria-label="Вопрос"
            placeholder="Что уточнить"
            value={form.question}
            onChange={(event) => setForm({ ...form, question: event.target.value })}
          />
          <button type="submit" disabled={status === 'sending' || !form.name || (!form.phone && !form.email)}>
            {status === 'sending' ? 'Отправляю...' : 'Отправить заявку'}
          </button>
        </>
      ) : (
        <button className="lead-toggle" type="button" onClick={() => setExpanded(true)}>
          Оставить контакт
        </button>
      )}
      {status === 'sent' ? <p className="form-note ok">Заявка сохранена. Специалист свяжется с вами.</p> : null}
      {status === 'error' ? <p className="form-note bad">Не удалось отправить. Попробуйте еще раз.</p> : null}
    </form>
  );
}

function AdminApp() {
  const [source, setSource] = useState<AdminSource>(() => initialAdminSource());
  const [tokens, setTokens] = useState<Record<AdminSource, string>>(() => ({
    local: storedAdminToken('local'),
    production: storedAdminToken('production')
  }));
  const [inputToken, setInputToken] = useState(() => storedAdminToken(initialAdminSource()));
  const [sessions, setSessions] = useState<ConversationSummary[]>([]);
  const [sessionStats, setSessionStats] = useState<AdminConversationStats | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<AdminConversationDetail | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<AdminFilter>('today');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pendingDelete, setPendingDelete] = useState<ConversationSession | null>(null);
  const [deletingId, setDeletingId] = useState('');

  const currentSource = ADMIN_SOURCES[source];
  const token = tokens[source];

  async function adminFetch<T>(path: string, targetSource = source, init: RequestInit = {}): Promise<T> {
    const target = ADMIN_SOURCES[targetSource];
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${tokens[targetSource]}`);
    const response = await fetch(`${target.baseUrl}${path}`, {
      ...init,
      headers
    });
    if (response.status === 401) throw new Error('Неверный пароль администратора');
    if (response.status === 404) throw new Error('Диалог не найден или уже удален');
    if (!response.ok) throw new Error(await adminResponseError(response, 'Не удалось загрузить данные'));
    return response.json() as Promise<T>;
  }

  function forgetAdminPassword() {
    const target = ADMIN_SOURCES[source];
    sessionStorage.removeItem(target.storageKey);
    clearLegacyAdminTokens();
    setTokens((current) => ({ ...current, [source]: '' }));
    setInputToken('');
    setSessions([]);
    setSessionStats(null);
    setLeads([]);
    setDetail(null);
    setSelectedId('');
    setPendingDelete(null);
    setDeletingId('');
    setError('');
  }

  async function deletePendingConversation() {
    if (!pendingDelete || deletingId) return;
    const idToDelete = pendingDelete.id;
    setDeletingId(idToDelete);
    setError('');
    try {
      await adminFetch<{ deleted: ConversationSession }>(`/api/admin/conversations/${idToDelete}`, source, { method: 'DELETE' });
      const remainingSessions = sessions.filter((session) => session.id !== idToDelete);
      setPendingDelete(null);
      setSessions(remainingSessions);
      setLeads((current) => current.map((lead) => lead.sessionId === idToDelete ? { ...lead, sessionId: null } : lead));
      setSelectedId(remainingSessions[0]?.id || '');
      setDetail(null);
      if (token) await loadList(token, source);
    } catch (deleteError) {
      setError(adminLoadErrorMessage(deleteError, source));
    } finally {
      setDeletingId('');
    }
  }

  async function loadList(nextToken = token, targetSource = source) {
    const value = nextToken.trim();
    if (!value) {
      setError(`Введите пароль администратора для вкладки "${ADMIN_SOURCES[targetSource].label}"`);
      return;
    }
    const target = ADMIN_SOURCES[targetSource];
    setLoading(true);
    setError('');
    try {
      const headers = { Authorization: `Bearer ${value}` };
      const [conversationData, emptyConversationData, leadData] = await Promise.all([
        fetch(`${target.baseUrl}/api/admin/conversations?limit=200&filter=withMessages`, { headers }),
        fetch(`${target.baseUrl}/api/admin/conversations?limit=200&filter=empty`, { headers }),
        fetch(`${target.baseUrl}/api/admin/leads?limit=200`, { headers })
      ]);
      if (conversationData.status === 401 || emptyConversationData.status === 401 || leadData.status === 401) throw new Error('Неверный пароль администратора');
      if (!conversationData.ok) throw new Error(await adminResponseError(conversationData, 'Не удалось загрузить данные'));
      if (!leadData.ok) throw new Error(await adminResponseError(leadData, 'Не удалось загрузить данные'));
      if (!emptyConversationData.ok) throw new Error(await adminResponseError(emptyConversationData, 'Не удалось загрузить пустые диалоги'));
      const conversationsJson = await conversationData.json() as { sessions: ConversationSummary[]; stats?: AdminConversationStats };
      const emptyConversationsJson = await emptyConversationData.json() as { sessions: ConversationSummary[]; stats?: AdminConversationStats };
      const leadsJson = await leadData.json() as { leads: Lead[] };
      const mergedSessions = [
        ...conversationsJson.sessions,
        ...emptyConversationsJson.sessions.filter((emptySession) => !conversationsJson.sessions.some((session) => session.id === emptySession.id))
      ];
      setTokens((current) => ({ ...current, [targetSource]: value }));
      sessionStorage.setItem(target.storageKey, value);
      setSessions(mergedSessions);
      setSessionStats(conversationsJson.stats ?? emptyConversationsJson.stats ?? null);
      setLeads(leadsJson.leads);
      setSelectedId(conversationsJson.sessions.find((session) => session.messageCount > 0)?.id || '');
    } catch (loadError) {
      setError(adminLoadErrorMessage(loadError, targetSource));
      setSessions([]);
      setSessionStats(null);
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    clearLegacyAdminTokens();
  }, []);

  useEffect(() => {
    const nextToken = tokens[source] ?? '';
    setInputToken(nextToken);
    setSessions([]);
    setSessionStats(null);
    setLeads([]);
    setDetail(null);
    setSelectedId('');
    setPendingDelete(null);
    setDeletingId('');
    setError('');
    if (nextToken) loadList(nextToken, source).catch(() => undefined);
  }, [source]);

  useEffect(() => {
    if (!token || !selectedId) {
      setDetail(null);
      return;
    }
    adminFetch<AdminConversationDetail>(`/api/admin/conversations/${selectedId}`, source)
      .then(setDetail)
      .catch((loadError) => setError(adminLoadErrorMessage(loadError, source)));
  }, [selectedId, source, token]);

  const leadSessionIds = useMemo(() => new Set(leads.map((lead) => lead.sessionId).filter(Boolean)), [leads]);
  const mainSessionCount = useMemo(
    () => sessionStats?.sessionsWithMessages ?? sessions.filter((session) => session.messageCount > 0).length,
    [sessionStats, sessions]
  );
  const emptySessionCount = sessionStats?.emptySessions ?? (sessions.length - sessions.filter((session) => session.messageCount > 0).length);
  const todaySessionCount = useMemo(
    () => sessions.filter((session) => session.messageCount > 0 && isTodayDate(session.latestMessageAt)).length,
    [sessions]
  );
  const filteredSessions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return sessions.filter((session) => {
      const isEmpty = session.messageCount === 0;
      if (filter === 'empty') {
        if (!isEmpty) return false;
      } else if (isEmpty) {
        return false;
      }
      if (filter === 'today' && !isTodayDate(session.latestMessageAt)) return false;
      if (filter === 'active' && session.status !== 'active') return false;
      if (filter === 'withLeads' && !leadSessionIds.has(session.id)) return false;
      if (!normalized) return true;
      return [
        session.title,
        session.topic,
        session.latestUserMessage,
        session.latestAssistantMessage,
        String(session.conversationNumber)
      ].some((value) => String(value ?? '').toLowerCase().includes(normalized));
    });
  }, [filter, leadSessionIds, query, sessions]);

  const selectedLead = leads.find((lead) => lead.sessionId === selectedId);

  useEffect(() => {
    if (!filteredSessions.length) {
      if (selectedId) setSelectedId('');
      return;
    }
    if (!filteredSessions.some((session) => session.id === selectedId)) {
      setSelectedId(filteredSessions[0].id);
    }
  }, [filteredSessions, selectedId]);

  return (
    <main className="admin-shell">
      <header className="admin-top">
        <div>
          <p className="eyebrow">БАКАУТ</p>
          <h1>Диалоги ассистента</h1>
          <p className="header-subtitle">Быстрый просмотр живых чатов без смешивания локальной и продовой базы.</p>
        </div>
        <div className="admin-access">
          <div className="admin-source-tabs" aria-label="Источник диалогов">
            {(Object.keys(ADMIN_SOURCES) as AdminSource[]).map((item) => (
              <button
                className={source === item ? 'active' : ''}
                key={item}
                type="button"
                onClick={() => setSource(item)}
              >
                {ADMIN_SOURCES[item].label}
              </button>
            ))}
          </div>
          <form className="admin-auth" onSubmit={(event) => { event.preventDefault(); loadList(inputToken, source); }}>
            <input
              aria-label="Пароль администратора"
              type="password"
              placeholder={`Пароль администратора: ${currentSource.label}`}
              value={inputToken}
              onChange={(event) => setInputToken(event.target.value)}
            />
            <button type="submit" disabled={loading}>{loading ? 'Загрузка' : 'Открыть'}</button>
            <button className="admin-logout" type="button" onClick={forgetAdminPassword} disabled={!token && !inputToken}>
              Выйти
            </button>
          </form>
          <p className="admin-source-note">Источник: {currentSource.hint}</p>
          <p className="admin-source-note">{adminTokenHint(source)}</p>
        </div>
      </header>

      {error ? <div className="admin-error">{error}</div> : null}

      <section className="admin-layout">
        <aside className="admin-sidebar">
          <div className="admin-tools">
            <input
              aria-label="Поиск"
              placeholder="Поиск по теме, номеру, тексту"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="admin-filters" aria-label="Фильтры">
              <button className={filter === 'today' ? 'active' : ''} type="button" onClick={() => setFilter('today')}>Сегодня</button>
              <button className={filter === 'all' ? 'active' : ''} type="button" onClick={() => setFilter('all')}>Диалоги</button>
              <button className={filter === 'active' ? 'active' : ''} type="button" onClick={() => setFilter('active')}>Активные</button>
              <button className={filter === 'withLeads' ? 'active' : ''} type="button" onClick={() => setFilter('withLeads')}>С заявкой</button>
              <button className={filter === 'empty' ? 'active' : ''} type="button" onClick={() => setFilter('empty')}>Пустые</button>
            </div>
            <button className="admin-refresh" type="button" onClick={() => loadList()} disabled={!token || loading}>
              Обновить
            </button>
            <p className="admin-count">
              {currentSource.label}: сегодня {todaySessionCount}, с общением {mainSessionCount}, пустые {emptySessionCount}, показано {filteredSessions.length}
            </p>
          </div>

          <div className="conversation-list">
            {filteredSessions.map((session) => (
              <button
                className={`conversation-row ${session.id === selectedId ? 'selected' : ''}`}
                key={session.id}
                type="button"
                onClick={() => setSelectedId(session.id)}
              >
                <span className="conversation-row-head">
                  <strong>{session.title}</strong>
                  <time>{formatDateTime(session.latestMessageAt ?? session.updatedAt)}</time>
                </span>
                <span className="conversation-row-topic">{session.topic || 'Без темы'}</span>
                <span className="conversation-row-text">{shortText(session.latestUserMessage, 96) || 'Нет сообщений'}</span>
                <span className="conversation-row-tags">
                  <span>{session.status === 'active' ? 'активный' : session.status}</span>
                  <span>{session.messageCount} сообщ.</span>
                  {session.leadCount ? <span>заявка</span> : null}
                </span>
              </button>
            ))}
            {!filteredSessions.length ? (
              <p className="admin-empty">
                {filter === 'empty' ? 'Пустых диалогов нет.' : filter === 'today' ? 'Сегодня диалоги с общением не найдены.' : 'Диалоги с общением не найдены.'}
              </p>
            ) : null}
          </div>
        </aside>

        <section className="admin-detail">
          {detail ? (
            <>
              <div className="admin-detail-head">
                <div>
                  <p className="eyebrow">Диалог #{detail.session.conversationNumber}</p>
                  <h2>{detail.session.topic || detail.session.title}</h2>
                  <p>{formatDateTime(detail.session.createdAt)} · {detail.session.status}</p>
                </div>
                <div className="admin-detail-actions">
                  {selectedLead ? (
                    <div className="lead-summary">
                      <strong>Заявка</strong>
                      <span>{selectedLead.name}</span>
                      <span>{[selectedLead.phone, selectedLead.email].filter(Boolean).join(' · ')}</span>
                    </div>
                  ) : null}
                  <button
                    className="admin-delete-button"
                    disabled={deletingId === detail.session.id}
                    type="button"
                    onClick={() => setPendingDelete(detail.session)}
                  >
                    {deletingId === detail.session.id ? 'Удаление...' : 'Удалить диалог'}
                  </button>
                </div>
              </div>

              <div className="admin-messages">
                {detail.messages.map((message) => {
                  const metadata = message.metadata as {
                    productCards?: ProductCard[];
                    cardDisplay?: CardDisplayOptions;
                    usedWebSearch?: boolean;
                    feedback?: { rating?: FeedbackRating; createdAt?: string };
                    cardSelection?: { fallbackSuppressed?: boolean; fallbackReason?: string; rankedCount?: number; selectedRejectedCount?: number };
                    aiDiagnostics?: NonNullable<ChatResponsePayload['metadata']>['aiDiagnostics'];
                    answerGenerationFallback?: NonNullable<ChatResponsePayload['metadata']>['answerGenerationFallback'];
                  };
                  const answerFallback = metadata.aiDiagnostics?.answerGenerationFallback ?? metadata.answerGenerationFallback;
                  return (
                    <article className={`admin-message ${message.role}`} key={message.id}>
                      <div className="message-meta">
                        <span>{message.role === 'user' ? 'Покупатель' : 'Ассистент'}</span>
                        <time>{formatDateTime(message.createdAt)}</time>
                      </div>
                      <div className="bubble">{renderMarkdownText(message.content)}</div>
                      {message.role === 'assistant' ? (
                        <div className="admin-message-flags">
                          <span>web: {metadata.usedWebSearch ? 'да' : 'нет'}</span>
                          <span>fallback: {metadata.cardSelection?.fallbackSuppressed ? 'сработал стоп' : 'нет'}</span>
                          {answerFallback?.used ? <span className="warn">answer fallback: {shortDiagnosticReason(answerFallback.reason)}</span> : null}
                          {metadata.aiDiagnostics?.needExtractionFallback?.used ? <span className="warn">need fallback: {shortDiagnosticReason(metadata.aiDiagnostics.needExtractionFallback.reason)}</span> : null}
                          {metadata.aiDiagnostics?.turnPlanningFallback?.used ? <span className="warn">planner fallback: {shortDiagnosticReason(metadata.aiDiagnostics.turnPlanningFallback.reason)}</span> : null}
                          {metadata.feedback?.rating ? <span>feedback: {metadata.feedback.rating}</span> : null}
                          {metadata.cardSelection?.fallbackReason ? <span>{metadata.cardSelection.fallbackReason}</span> : null}
                          {typeof metadata.cardSelection?.rankedCount === 'number' ? <span>ranked: {metadata.cardSelection.rankedCount}</span> : null}
                        </div>
                      ) : null}
                      {metadata.productCards?.length ? <ProductCards cards={metadata.productCards} initialVisibleCount={metadata.cardDisplay?.initialVisibleCount} /> : null}
                    </article>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="admin-placeholder">
              <h2>Откройте диалог</h2>
              <p>Введите ключ администратора и выберите чат из списка слева.</p>
            </div>
          )}
        </section>
      </section>

      {pendingDelete ? (
        <div className="admin-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title">
          <div className="admin-modal">
            <h2 id="delete-dialog-title">Удалить диалог?</h2>
            <p>
              {pendingDelete.title} будет удален вместе со всеми сообщениями. Заявка, если она была,
              останется в базе, но без привязки к этому диалогу.
            </p>
            <div className="admin-modal-actions">
              <button type="button" onClick={() => setPendingDelete(null)} disabled={Boolean(deletingId)}>
                Отмена
              </button>
              <button className="danger" type="button" onClick={deletePendingConversation} disabled={Boolean(deletingId)}>
                {deletingId ? 'Удаляю...' : 'Удалить'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: id(),
      role: 'assistant',
      content: 'Здравствуйте. Помогу быстро подобрать оборудование под задачу и покажу подходящие варианты из каталога.',
      createdAt: nowIso()
    }
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [leadAutoOpenKey, setLeadAutoOpenKey] = useState(0);
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const latestQuestion = useMemo(() => [...messages].reverse().find((message) => message.role === 'user')?.content ?? '', [messages]);
  const isStart = messages.length <= 1;
  const quickPrompts = [
    'Подберите генератор для дачи',
    'Сравните две модели',
    'Нужна виброплита для участка'
  ];

  useEffect(() => {
    createSession().then(setSessionId).catch(() => setError('Не удалось открыть чат'));
  }, []);

  useEffect(() => {
    const preventZoomGesture = (event: Event) => event.preventDefault();
    document.addEventListener('gesturestart', preventZoomGesture, { passive: false });
    document.addEventListener('gesturechange', preventZoomGesture, { passive: false });
    document.addEventListener('gestureend', preventZoomGesture, { passive: false });
    return () => {
      document.removeEventListener('gesturestart', preventZoomGesture);
      document.removeEventListener('gesturechange', preventZoomGesture);
      document.removeEventListener('gestureend', preventZoomGesture);
    };
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const interval = window.setInterval(async () => {
      if (cancelled) return;
      try {
        const response = await fetch(`${apiBase}/api/chat/sessions/${sessionId}/heartbeat`, { method: 'POST' });
        if (cancelled) return;
        // Session no longer exists on the server (deleted, expired, or DB reset).
        // Stop the interval, drop the stale id, and let createSession() spin up a fresh one.
        if (response.status === 404) {
          window.clearInterval(interval);
          sessionStorage.removeItem('bakaut_session_id');
          setSessionId(null);
          createSession().then((next) => {
            if (!cancelled) setSessionId(next);
          }).catch(() => undefined);
        }
      } catch {
        /* network blip — keep trying */
      }
    }, 25_000);
    const close = () => {
      const url = `${apiBase}/api/chat/sessions/${sessionId}/close`;
      navigator.sendBeacon?.(url, new Blob(['{}'], { type: 'application/json' }));
    };
    window.addEventListener('pagehide', close);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('pagehide', close);
    };
  }, [sessionId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, busy]);

  async function submitText(text: string, options: { clearInput?: boolean } = { clearInput: true }) {
    if (!text.trim() || busy) return;
    const userText = text.trim();
    if (options.clearInput !== false) setInput('');
    setError('');
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const assistantId = id();
    setMessages((current) => [
      ...current,
      { id: id(), role: 'user', content: userText, createdAt: nowIso() },
      {
        id: assistantId,
        role: 'assistant',
        content: '',
        createdAt: nowIso(),
        status: 'sending',
        progress: 'Проверяю каталог и контекст...'
      }
    ]);

    try {
      const activeSessionId = sessionId ?? await createSession(true);
      if (!activeSessionId) throw new Error('Не удалось создать сессию чата');
      if (activeSessionId !== sessionId) setSessionId(activeSessionId);
      const payload = await streamChatMessage(apiBase, activeSessionId, userText, {
        onDelta: (delta) => {
          setMessages((current) => current.map((message) => (
            message.id === assistantId ? { ...message, content: message.content + delta, progress: undefined } : message
          )));
        },
        onStatus: (progress) => {
          const recoveryRestart = /оборвался|восстанавливаю/iu.test(progress);
          setMessages((current) => current.map((message) => (
            message.id === assistantId && (recoveryRestart || !message.content)
              ? { ...message, content: recoveryRestart ? '' : message.content, progress }
              : message
          )));
        }
      }, controller.signal);
      if (payload?.leadRequested) setLeadAutoOpenKey((value) => value + 1);
      setMessages((current) => current.map((message) => (
        message.id === assistantId
          ? {
              ...message,
              content: message.content || payload?.answer || 'Ответ сформирован, но текст не был передан. Повторите запрос.',
              serverId: payload?.assistantMessageId,
              cards: payload?.productCards?.length ? payload.productCards : message.cards,
              cardDisplay: payload?.cardDisplay ?? payload?.metadata?.cardDisplay ?? message.cardDisplay,
              leadRequested: payload?.leadRequested,
              metadata: payload?.metadata ?? message.metadata,
              progress: undefined,
              status: 'done'
            }
          : message
      )));
    } catch (submitError) {
      if (controller.signal.aborted || (submitError instanceof DOMException && submitError.name === 'AbortError')) {
        setMessages((current) => current.map((message) => (
          message.id === assistantId ? { ...message, content: message.content || 'Ответ остановлен.', status: 'stopped' } : message
        )));
      } else {
        const safeMessage = submitError instanceof Error && /Не смог надежно завершить ответ|не смог надежно сформировать ответ|не удалось получить ответ/i.test(submitError.message)
          ? submitError.message
          : 'Сейчас не смог надежно сформировать ответ. Вопрос сохранен, повторите его через пару минут.';
        setMessages((current) => current.map((message) => (
          message.id === assistantId
            ? {
                ...message,
                content: message.content || safeMessage,
                progress: undefined,
                status: 'error'
              }
            : message
        )));
      setError(safeMessage);
      }
    } finally {
      setBusy(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await submitText(input);
  }

  function stopGeneration() {
    abortRef.current?.abort();
  }

  function editMessage(text: string) {
    setInput(text);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function copyMessage(text: string) {
    const task = navigator.clipboard?.writeText(text);
    if (task) await task.catch(() => undefined);
  }

  async function rateAssistantMessage(messageId: string, rating: FeedbackRating) {
    if (!sessionId) return;
    setMessages((current) => current.map((message) => (
      message.id === messageId ? { ...message, feedback: rating } : message
    )));
    const target = messages.find((message) => message.id === messageId);
    if (!target?.serverId) return;
    await sendAssistantFeedback(sessionId, target.serverId, rating).catch(() => {
      setError('Не удалось сохранить оценку ответа.');
    });
  }

  return (
    <main className={`widget-shell ${isStart ? 'is-start' : 'has-dialog'}`}>
      <header>
        <div>
          <p className="eyebrow">БАКАУТ</p>
          <h1>AI-консультант</h1>
          <p className="header-subtitle">Подбор строительного и силового оборудования</p>
        </div>
        <span className={busy ? 'status busy' : 'status'}>{busy ? 'Отвечаю' : 'Онлайн'}</span>
      </header>

      <section className="messages" aria-live="polite">
        {messages.map((message) => (
          <div className={`message ${message.role}`} key={message.id}>
            <div className="message-meta">
              <span>{message.role === 'user' ? 'Вы' : 'Консультант'}</span>
              <time>{formatTime(message.createdAt)}</time>
            </div>
            <div className="bubble">
              {message.content ? renderMarkdownText(message.content) : (message.role === 'assistant' ? (
                <span className="typing-line">
                  <span className="typing" aria-label="Консультант печатает"><span /><span /><span /></span>
                  {message.progress ? <span className="typing-text">{message.progress}</span> : null}
                </span>
              ) : null)}
            </div>
            {message.role === 'assistant' ? <AiDiagnosticsBadge metadata={message.metadata} /> : null}
            {message.role === 'user' ? (
              <div className="message-actions">
                <button type="button" onClick={() => editMessage(message.content)} disabled={busy}>
                  Исправить
                </button>
                <button type="button" onClick={() => submitText(message.content, { clearInput: false })} disabled={busy}>
                  Спросить снова
                </button>
              </div>
            ) : null}
            {message.role === 'assistant' && message.content ? (
              <div className="message-actions">
                <button type="button" aria-label="Копировать ответ" title="Копировать" onClick={() => copyMessage(message.content)}>
                  Копировать
                </button>
                {message.serverId ? (
                  <>
                    <button className={message.feedback === 'positive' ? 'active' : ''} type="button" onClick={() => rateAssistantMessage(message.id, 'positive')}>
                      Хорошо
                    </button>
                    <button className={message.feedback === 'negative' ? 'active' : ''} type="button" onClick={() => rateAssistantMessage(message.id, 'negative')}>
                      Плохо
                    </button>
                    <button className={message.feedback === 'wrong_cards' ? 'active' : ''} type="button" onClick={() => rateAssistantMessage(message.id, 'wrong_cards')}>
                      Карточки
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
            {message.cards ? <ProductCards cards={message.cards} initialVisibleCount={message.cardDisplay?.initialVisibleCount} /> : null}
          </div>
        ))}
        <div ref={endRef} />
      </section>

      {error ? <div className="error">{error}</div> : null}

      <form className="composer" onSubmit={submit}>
        {isStart ? (
          <div className="quick-actions" aria-label="Быстрые запросы">
            {quickPrompts.map((prompt) => (
              <button key={prompt} type="button" onClick={() => setInput(prompt)} disabled={busy}>
                {prompt}
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={inputRef}
          aria-label="Сообщение"
          placeholder="Например: нужен генератор для дачи на 5 кВт"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) submit(event);
          }}
          disabled={busy}
        />
        {busy ? (
          <button className="stop-button" type="button" onClick={stopGeneration}>
            Остановить
          </button>
        ) : null}
        <button type="submit" disabled={busy || !input.trim()}>{busy ? '...' : 'Отправить'}</button>
      </form>

      <LeadPanel sessionId={sessionId} latestQuestion={latestQuestion} autoOpenKey={leadAutoOpenKey} />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(window.location.pathname.startsWith('/admin') ? <AdminApp /> : <App />);
