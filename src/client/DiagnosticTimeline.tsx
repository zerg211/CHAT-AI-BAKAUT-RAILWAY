import React, { useLayoutEffect, useRef, useState } from 'react';

export type DiagnosticIdType = 'turnId' | 'executionId' | 'requestId' | 'providerRequestId';
type TechnicalEvent = Record<string, string | number | boolean>;
const idTypes: DiagnosticIdType[] = ['turnId', 'executionId', 'requestId', 'providerRequestId'];
const tokenCharacters = (value: string) => [...value].every(c => /[a-zA-Z0-9_.:-]/.test(c));
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function validDiagnosticId(type: DiagnosticIdType, value: string): boolean {
  if (!idTypes.includes(type) || !value || value.length > 200 || !tokenCharacters(value)) return false;
  if (type === 'turnId' || type === 'executionId' || type === 'requestId') return uuid(value);
  return uuid(value) || /^req[_-][a-zA-Z0-9_.:-]+$/.test(value);
}

// Defense in depth: the server owns sanitization; the UI never renders arbitrary response objects.
const textFields = new Set('id eventId name sourceRevision snapshotId buildCommit deploymentId instanceId sessionId clientMessageId clientRequestId messageId jobId outboxId leadId knownOutcome stackFingerprint executionId turnId requestId providerRequestId spanId parentSpanId operation outcome errorCode errorType errorClass remoteStatus component stage phase method endpoint sqlState tool itemType abortSource basis jobType reason agentSessionId agentTurnId itemId callId model'.split(' '));
const numericFields = new Set('eventSeq sequence spanNumber parentSpanNumber timingActiveSpans legacyDroppedEvents emittedEvents schemaVersion rssBytes heapUsedBytes heapTotalBytes uptimeMs eventLoopLagP95Ms cpuUserMs cpuSystemMs durationMs offsetMs statusCode attempt pollCount pageNumber itemCount responseBytes headersMs bodyMs parseMs rowCount queueAgeMs remainingMs remainingTurnMs timeoutMs count droppedEvents activeSpans sinkFailures inputTokens cachedInputTokens outputTokens reasoningTokens totalTokens firstUsefulContentMs attemptCount elapsedMs totalCount idleCount waitingCount candidateCount updatedCount unknownCount failedCount'.split(' '));
const booleanFields = new Set('aborted checkpointFound submitted leaseAcquired deduplicated hasMore recovery backpressure persisted writableEnded destroyed errorCodeReported errorTypeReported usageKnown complete'.split(' '));
const endpoints = new Set(['/agents/:agentId', '/agents/sessions', '/agents/sessions/:sessionId', '/agents/sessions/:sessionId/events', '/agents/sessions/:sessionId/turns', '/agents/sessions/:sessionId/turns/:turnId', '/agents/sessions/:sessionId/turns/:turnId/items', '/search-full', '/health', 'site.product', 'email.send']);
export function safeDiagnosticEvent(input: unknown): TechnicalEvent {
  const result: TechnicalEvent = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
  for (const [key, value] of Object.entries(input)) {
    if (numericFields.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = value;
    else if (booleanFields.has(key) && typeof value === 'boolean') result[key] = value;
    else if (key === 'id' && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) result[key] = String(value);
    else if (key === 'timestamp' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value))) result[key] = value;
    else if (key === 'errorSite' && typeof value === 'string' && value.length<160 && /^[a-zA-Z0-9_./-]+\.[jt]s:[0-9]{1,8}:[0-9]{1,8}$/.test(value)) result[key]=value;
    else if (key === 'endpoint' && typeof value === 'string' && endpoints.has(value)) result[key] = value;
    else if (key !== 'endpoint' && textFields.has(key) && typeof value === 'string' && value.length <= 200 && tokenCharacters(value)) result[key] = value;
  }
  return result;
}
export function diagnosticEventFailed(event: TechnicalEvent): boolean {
  return (typeof event.statusCode === 'number' && event.statusCode >= 400)
    || ['failed', 'error', 'cancelled', 'aborted', 'timeout'].includes(String(event.outcome))
    || ['failed', 'cancelled', 'expired', 'incomplete'].includes(String(event.remoteStatus))
    || String(event.name).endsWith('.failed')
    || (typeof event.errorCode === 'string' && !['not_reported', 'none'].includes(event.errorCode));
}
export function mergeDiagnosticEvents(previous: TechnicalEvent[], incoming: unknown[]): TechnicalEvent[] {
  const events = new Map<string, TechnicalEvent>();
  [...previous, ...incoming.map(safeDiagnosticEvent)].forEach((event, index) => {
    events.set(String(event.id ?? event.eventId ?? `unidentified-${index}`), event);
  });
  return [...events.values()].sort((a, b) => String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? ''))
    || (a.executionId === b.executionId ? Number(a.eventSeq ?? 0) - Number(b.eventSeq ?? 0) : 0));
}
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : 'неизвестно';
export function diagnosticJournalSummary(journal: unknown): string {
  const value = journal && typeof journal === 'object' ? journal as Record<string, unknown> : {};
  return `Потеряно событий: ${count(value.dropped)}; ошибок записи: ${count(value.storageFailures)}; в очереди: ${count(value.queueDepth)}; очистка отстаёт: ${typeof value.retentionBacklog === 'boolean' ? value.retentionBacklog ? 'да' : 'нет' : 'неизвестно'}. Это состояние журнала процесса, не только выбранного запроса.`;
}

export function DiagnosticTimeline({ baseUrl, token }: { baseUrl: string; token: string }) {
  const [idType, setIdType] = useState<DiagnosticIdType>('turnId');
  const [identifier, setIdentifier] = useState('');
  const [events, setEvents] = useState<TechnicalEvent[]>([]);
  const [nextId, setNextId] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [journal, setJournal] = useState<unknown>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const current = useRef<{ generation: number; controller?: AbortController }>({ generation: 0 });
  useLayoutEffect(() => {
    current.current.generation++;
    current.current.controller?.abort();
    setEvents([]); setNextId(null); setHasMore(false); setLoaded(false); setJournal(null); setError(''); setLoading(false);
    return () => { current.current.generation++; current.current.controller?.abort(); };
  }, [baseUrl, token, idType, identifier]);

  async function load(more = false) {
    if (!token || !validDiagnosticId(idType, identifier) || loading || (more && !nextId)) return;
    current.current.controller?.abort();
    const controller = new AbortController();
    const generation = ++current.current.generation;
    current.current.controller = controller;
    const isCurrent = () => current.current.generation === generation && !controller.signal.aborted;
    setLoading(true); setError('');
    if (!more) { setEvents([]); setLoaded(false); setNextId(null); setHasMore(false); setJournal(null); }
    try {
      const query = new URLSearchParams({ [idType]: identifier, limit: '200' });
      if (more && nextId) query.set('afterId', nextId);
      const response = await fetch(`${baseUrl}/api/admin/diagnostics?${query}`, {
        method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: controller.signal
      });
      if (!isCurrent()) return;
      if (!response.ok) {
        setError(response.status === 401 ? 'Нужен действующий токен администратора.' : response.status === 403 ? 'У этого токена нет доступа к диагностике.' : response.status === 503 ? 'Журнал временно недоступен. Повторите загрузку позже.' : 'Не удалось загрузить журнал. Повторите попытку.');
        return;
      }
      const data: unknown = await response.json();
      if (!isCurrent()) return;
      if (!data || typeof data !== 'object' || !('events' in data) || !Array.isArray(data.events)) {
        setError('Ответ журнала имеет неизвестный формат. Повторите загрузку позже.'); return;
      }
      const page = data as { events: unknown[]; nextId?: unknown; hasMore?: unknown; journal?: unknown };
      const cursor = String(page.nextId ?? '');
      const safeCursor = /^\d{1,20}$/.test(cursor) && (!more || cursor !== nextId) ? cursor : null;
      setEvents(previous => mergeDiagnosticEvents(more ? previous : [], page.events));
      setNextId(safeCursor); setHasMore(page.hasMore === true); setJournal(page.journal); setLoaded(true);
      if (page.hasMore === true && !safeCursor) setError('Продолжение недоступно: журнал не вернул новый корректный курсор. Показана только часть событий.');
    } catch {
      if (isCurrent()) setError('Не удалось прочитать журнал. Проверьте соединение и повторите загрузку.');
    } finally { if (isCurrent()) setLoading(false); }
  }

  const valid = validDiagnosticId(idType, identifier);
  return <details className="outcome-dashboard">
    <summary>Техническая диагностика по ID</summary>
    <p>Только технические события, без переписки. Загрузка вручную, без обращения к модели.</p>
    <form onSubmit={event => { event.preventDefault(); void load(); }}>
      <label>Тип ID <select value={idType} onChange={event => setIdType(event.target.value as DiagnosticIdType)}>
        <option value="turnId">Ход (turnId)</option><option value="executionId">Выполнение (executionId)</option>
        <option value="requestId">HTTP-запрос (requestId)</option><option value="providerRequestId">Запрос провайдера (providerRequestId)</option>
      </select></label>{' '}
      <label>ID <input value={identifier} maxLength={200} autoComplete="off" spellCheck={false} onChange={event => setIdentifier(event.target.value)} /></label>{' '}
      <button type="submit" disabled={!token || !valid || loading}>{loading ? 'Загрузка…' : 'Загрузить события'}</button>
    </form>
    {!token ? <p>Введите токен администратора для доступа.</p> : null}
    {identifier && !valid ? <p role="status">Введите корректный ID: UUID для хода или выполнения, UUID для HTTP-запроса, req_… или UUID для провайдера.</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {loaded ? <>
      <p>Загружено событий: {events.length}. {hasMore ? 'Показана часть записей, есть следующая страница.' : 'Доступные страницы загружены; полнота истории не гарантирована.'}</p>
      <p>{diagnosticJournalSummary(journal)}</p>
      <p>Отсутствие события не означает успех. Возможны потери и удаление старых записей. Доставка в браузер не доказывает, что человек прочитал ответ. Время пересекающихся операций не суммируется.</p>
      {!events.length ? <p>События не найдены. Проверьте ID и срок хранения журнала.</p> : null}
      <ol style={{ paddingLeft: 24 }}>
        {events.map((event, index) => <li key={String(event.id ?? event.eventId ?? index)} style={{ marginBottom: 12, borderLeft: `3px solid ${diagnosticEventFailed(event) ? '#b42318' : '#cbd5e1'}`, paddingLeft: 8 }}>
          <strong>{diagnosticEventFailed(event) ? 'Ошибка / прерывание: ' : ''}{String(event.name ?? 'Событие')}</strong>
          <div>{String(event.timestamp ?? 'Время неизвестно')}{event.eventSeq !== undefined ? ` · № ${event.eventSeq}` : ''}{event.durationMs !== undefined ? ` · ${event.durationMs} мс` : ''}</div>
          <details><summary>Технические поля</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(event, null, 2)}</pre></details>
        </li>)}
      </ol>
      {hasMore ? <button type="button" disabled={loading || !token || !nextId} onClick={() => void load(true)}>Загрузить ещё</button> : null}
    </> : null}
  </details>;
}
