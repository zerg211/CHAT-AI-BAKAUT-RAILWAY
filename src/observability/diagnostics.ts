import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export type DiagnosticEvent = Record<string, string | number | boolean | null>;
type Sink = (event: DiagnosticEvent) => void;
type Context = { identity: DiagnosticEvent; started: number; state: { sequence: number; dropped: number; active: number; critical: number; sinkFailures: number }; spanId?: string; sink?: Sink };
const storage = new AsyncLocalStorage<Context>();
let durableSink: Sink | undefined;
const MAX_EVENTS = 20_000;
const numeric = new Set(('rssBytes heapUsedBytes heapTotalBytes uptimeMs eventLoopLagP95Ms cpuUserMs cpuSystemMs durationMs offsetMs statusCode attempt pollCount pageNumber itemCount responseBytes headersMs bodyMs parseMs retryAfterSeconds rateLimitRemainingRequests rateLimitRemainingTokens rowCount totalCount idleCount waitingCount candidateCount updatedCount unknownCount failedCount queueAgeMs nextRetryMs remainingMs remainingTurnMs timeoutMs count sequence droppedEvents activeSpans firstUsefulContentMs inputTokens cachedInputTokens outputTokens reasoningTokens totalTokens maxOutputTokens outputTokenCap attemptCount elapsedMs queueDepth storageFailures sinkFailures requestedCount persistedCount missingCount legacyDroppedEvents timingActiveSpans emittedEvents spanNumber parentSpanNumber').split(' '));
const booleans = new Set(('aborted checkpointFound submitted leaseAcquired deduplicated hasMore recovery backpressure persisted writableEnded destroyed errorCodeReported errorTypeReported usageKnown complete').split(' '));
const uuids = new Set(('sessionId turnId executionId clientMessageId messageId clientRequestId jobId outboxId leadId causalEventId spanId parentSpanId').split(' '));
const providerIds = new Set(('agentSessionId agentTurnId itemId callId providerRequestId').split(' '));
const labels = new Set(('component stage operation method outcome knownOutcome abortSource basis jobType phase eventType kind type name reason').split(' '));
const statuses = new Set(['queued','pending','in_progress','running','completed','failed','cancelled','cancelling','incomplete','requires_action','expired','unknown','not_reported']);
const tools = new Set(['catalog.search','catalog.search_full','search_products','semantic_rank_products','get_product','get_products_batch','get_product_details','web_search','web_search_call','file_search','code_interpreter','computer','unknown']);
const itemTypes = new Set(['message','mcp_call','mcp_list_tools','mcp_approval_request','function_call','function_call_output','web_search_call','file_search_call','code_interpreter_call','reasoning','computer_call','unknown']);
export const diagnosticErrorCodes = new Set(('unknown not_reported configuration_error checkpoint_missing unsafe_outbound_url outbound_response_too_large invalid_api_key insufficient_quota rate_limit_exceeded server_error internal_error internal_server_error billing_hard_limit_reached resource_not_found invalid_request_error authentication_error permission_denied model_not_found unsupported_country_region_territory context_length_exceeded content_filter tokens_exceeded timeout request_timeout aborted invalid_json invalid_response remote_failed remote_cancelled catalog_contract validation_failed ECONNRESET ECONNREFUSED ENOTFOUND EAI_AGAIN ETIMEDOUT UND_ERR_CONNECT_TIMEOUT UND_ERR_HEADERS_TIMEOUT UND_ERR_BODY_TIMEOUT UND_ERR_SOCKET FST_ERR_CTP_INVALID_JSON_BODY FST_ERR_VALIDATION FST_ERR_CTP_BODY_TOO_LARGE').split(' '));
const errorTypes = new Set(['unknown','not_reported','invalid_request_error','authentication_error','permission_error','rate_limit_error','server_error','api_error','insufficient_quota','tokens','requests','not_found_error']);
const errorClasses = new Set(['Error','TypeError','SyntaxError','RangeError','AbortError','TimeoutError','ZodError','PlatformAgentRequestError','CatalogClassificationError','TurnExecutionInProgressError','RecoveryAttemptUnavailableError','AgentManagerTurnBudgetExceededError','DatabaseError','UnsafeOutboundUrlError','OutboundResponseTooLargeError','UnknownError']);

const sourceFiles = new Set(['ai/platformAgentAssistant.ts','ai/platformAgentClient.ts','ai/fullCatalogClient.ts','ai/openaiUsageGuard.ts','ai/leadOutbox.ts','catalog/currentSitePrice.ts','email/httpEmail.ts','security/outboundHttp.ts','db/repositories.ts','routes/chat.ts','routes/sse.ts','app.ts']);
const messageCodes = new Map([
  ['Platform agent turn did not complete','remote_failed'],['Platform agent returned an empty answer','invalid_response'],
  ['Agent items pagination failed','invalid_response'],['Agent historical items pagination failed','invalid_response'],
  ['Agent historical turns pagination failed','invalid_response'],['Platform agent requires an unsupported action','invalid_response'],
  ['Saved agent instructions are unavailable','invalid_response'],['Platform agent session ID missing','invalid_response'],
  ['Agent classification is not valid JSON','invalid_json'],['Agent answer is invalid','validation_failed'],
  ['Agent classification is invalid','validation_failed'],['Catalog revision is unavailable','catalog_contract'],
  ['Catalog pages are incomplete','catalog_contract'],['Catalog pages are incomplete or inconsistent','catalog_contract'],
  ['Catalog result is incomplete or changed while loading','catalog_contract'],['Full catalog snapshot did not match the agent search','catalog_contract'],
  ['Turn deadline expired','timeout'],['Recovery was aborted','aborted'],['Turn was cancelled by the user','aborted'],
  ['Platform agent request aborted','aborted'],['Platform agent is not configured','configuration_error'],
  ['Agent submission is not recoverable without a saved identity','checkpoint_missing']
]);
function safeSourceLocation(value: string) {
  const parts=value.split(':');
  return parts.length===3 && (sourceFiles.has(parts[0]) || (parts[0].endsWith('.js') && sourceFiles.has(parts[0].slice(0,-3)+'.ts'))) && parts.slice(1).every(p=>p.length>0 && p.length<9 && [...p].every(c=>c>='0'&&c<='9'));
}

function asciiToken(value: unknown, max = 100): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && [...value].every(c =>
    (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || '._:-'.includes(c));
}
function isUuid(value: unknown): boolean {
  return typeof value === 'string' && value.length === 36 && value.split('-').map(p => p.length).join(',') === '8,4,4,4,12' &&
    [...value.toLowerCase()].every(c => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || c === '-');
}
function providerId(value: unknown) {
  if (!asciiToken(value, 200)) return undefined;
  return isUuid(value) || ['req_','req-','sess_','session_','turn_','item_','call_','fc_','msg_','mcp_','ws_','rs_','agent_','agent_session_','agsess_','ags_','as_','agt_','agturn_','resp_'].some(prefix => value.startsWith(prefix)) ? value : undefined;
}

/** The only boundary into every diagnostics sink. Never copy arbitrary objects. */
export function projectDiagnosticFields(input: Record<string, unknown>): DiagnosticEvent {
  const output: DiagnosticEvent = {};
  for (const [key, value] of Object.entries(input)) {
    if (numeric.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0) output[key] = value;
    else if (booleans.has(key) && typeof value === 'boolean') output[key] = value;
    else if (uuids.has(key) && isUuid(value)) output[key] = value as string;
    else if (key === 'requestId' && (isUuid(value) || (asciiToken(value, 40) && value.startsWith('req-')))) output[key] = value as string;
    else if (providerIds.has(key)) { const id = providerId(value); if (id) output[key] = id; }
    else if (labels.has(key) && asciiToken(value, 100)) output[key] = value;
    else if (key === 'errorCode') output[key] = diagnosticErrorCodes.has(String(value)) ? String(value) : 'unknown';
    else if (key === 'errorType') output[key] = errorTypes.has(String(value)) ? String(value) : 'unknown';
    else if (key === 'errorClass') output[key] = errorClasses.has(String(value)) ? String(value) : 'UnknownError';
    else if (key === 'remoteStatus') output[key] = statuses.has(String(value)) ? String(value) : 'unknown';
    else if (key === 'itemType') output[key] = itemTypes.has(String(value)) ? String(value) : 'unknown';
    else if (key === 'tool') output[key] = tools.has(String(value)) ? String(value) : 'unknown';
    else if (key === 'sqlState' && typeof value === 'string' && value.length === 5 && [...value].every(c => (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z'))) output[key] = value;
    else if (key === 'model' && asciiToken(value, 80) && ['gpt-','o1','o3','o4','chatgpt-'].some(p => value.startsWith(p))) output[key] = value;
    else if (key === 'endpoint' && ['/agents/:agentId','/agents/sessions','/agents/sessions/:sessionId','/agents/sessions/:sessionId/events','/agents/sessions/:sessionId/turns','/agents/sessions/:sessionId/turns/:turnId','/agents/sessions/:sessionId/turns/:turnId/items','/search-full','/health','site.product','email.send'].includes(String(value))) output[key] = String(value);
    else if (key === 'route' && typeof value === 'string' && value.startsWith('/api/') && value.length < 150 && !value.includes('?') && [...value].every(c => asciiToken(c) || c === '/')) output[key] = value;
    else if (['sourceRevision','snapshotId'].includes(key) && typeof value === 'string' && (isUuid(value) || (value.length>=8 && value.length<=128 && [...value.toLowerCase()].every(c=>'0123456789abcdef'.includes(c))))) output[key]=value;
    else if (key === 'errorSite' && typeof value === 'string' && safeSourceLocation(value)) output[key]=value;
    else if (key === 'stackFingerprint' && typeof value === 'string' && value.length === 16 && [...value].every(c => '0123456789abcdef'.includes(c))) output[key] = value;
  }
  return output;
}

export function safeErrorFields(error: unknown): DiagnosticEvent {
  try {
    const e = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    const cause = e.cause && typeof e.cause === 'object' ? e.cause as Record<string, unknown> : {};
    const result = projectDiagnosticFields({ errorClass: e.name ?? (error instanceof Error ? error.constructor.name : 'UnknownError'),
      errorCode: e.code ?? e.errorCode ?? cause.code ?? messageCodes.get(String(e.message ?? '')) ?? (e.name === 'SyntaxError' ? 'invalid_json' : e.name === 'AbortError' ? 'aborted' : e.name === 'TimeoutError' ? 'timeout' : 'unknown'),
      errorType: e.errorType, statusCode: e.statusCode ?? e.status, providerRequestId: e.providerRequestId,
      sqlState: typeof e.code === 'string' && e.code.length === 5 ? e.code : undefined });
    // Hash code locations only, never the error message, arbitrary paths or values.
    const header = `${String(e.name ?? 'Error')}: ${String(e.message ?? '')}`;
    const stack = typeof e.stack === 'string' && e.stack.startsWith(header) ? e.stack.slice(header.length) : '';
    const locations = stack.split('\n').flatMap(line => {
      const marker=line.lastIndexOf('/src/');
      const compiled=line.lastIndexOf('/dist/server/');
      if (marker<0 && compiled<0) return [];
      const suffix=line.slice(marker>=0 ? marker+5 : compiled+13).split(')')[0];
      return safeSourceLocation(suffix) ? [suffix] : [];
    }).slice(0,5);
    if (locations.length) {
      result.errorSite=locations[0];
      result.stackFingerprint=createHash('sha256').update(locations.join('\n')).digest('hex').slice(0,16);
    }
    return result;
  } catch { return { errorClass: 'UnknownError', errorCode: 'unknown' }; }
}

export function diagnosticAbortSource(signal?: AbortSignal) {
  if (!signal?.aborted) return 'none';
  if (signal.reason === 'platform_agent_explicit_cancel') return 'client_cancel';
  if (signal.reason === 'turn_deadline_exceeded') return 'server_deadline';
  if (signal.reason === 'recovery_grace_exceeded') return 'recovery_grace';
  return signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 'dependency_timeout' : 'unknown';
}
export function setDiagnosticSink(sink?: Sink) { durableSink = sink; }
function stdout(event: DiagnosticEvent) { console.info(JSON.stringify(event)); }
function elapsed(start: number) { return Math.max(0, Math.round((performance.now() - start) * 10) / 10); }
export function diagnosticEvent(name: string, fields: Record<string, unknown> = {}): string | undefined {
  try {
    const context = storage.getStore();
    const terminal = ['timing.complete','request.complete','request.rejected','answer.ready'].includes(name);
    const critical = name.endsWith('.failed') || name.endsWith('.failure') || name.endsWith('.error');
    if (context && context.state.sequence >= MAX_EVENTS && !terminal && !(critical && context.state.critical++ < 100)) { context.state.sequence++; context.state.dropped++; return undefined; }
    const eventId = randomUUID();
    const event: DiagnosticEvent = { event: 'diagnostic', schemaVersion: 1, eventId, timestamp: new Date().toISOString(),
      service: 'chat-ai', ...context?.identity, ...projectDiagnosticFields(fields),
      name: asciiToken(name,120) ? name : 'invalid_event_name', eventSeq: context ? ++context.state.sequence : 1,
      offsetMs: context ? elapsed(context.started) : 0 };
    const commit = process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA;
    if (commit && (commit.length === 40 || commit.length === 64) && [...commit].every(c => '0123456789abcdef'.includes(c))) event.buildCommit = commit;
    for (const [key, value] of [['deploymentId',process.env.RAILWAY_DEPLOYMENT_ID],['instanceId',process.env.RAILWAY_REPLICA_ID]]) if (isUuid(value)) event[key!] = value!;
    if (context?.spanId) event.parentSpanId = context.spanId;
    try { (context?.sink ?? stdout)(event); } catch { if (context) context.state.sinkFailures++; /* Keep business outcome unchanged. */ }
    if (!context?.sink) try { durableSink?.(event); } catch { stdout({event:'diagnostic_health',name:'telemetry.enqueue.failed',timestamp:new Date().toISOString()}); }
    return eventId;
  } catch { return undefined; }
}
export function diagnosticError(name: string, error: unknown, fields: Record<string, unknown> = {}) {
  return diagnosticEvent(name, {...fields,...safeErrorFields(error),outcome:'error'});
}
export function runWithDiagnostics<T>(identity: Record<string, unknown>, operation: () => T, sink?: Sink): T {
  const parent = storage.getStore();
  return storage.run({identity:{...parent?.identity,executionId:randomUUID(),...projectDiagnosticFields(identity)},
    started:performance.now(),state:{sequence:0,dropped:0,active:0,critical:0,sinkFailures:0},sink:sink ?? parent?.sink}, operation);
}
export function bindDiagnosticIdentity(identity: Record<string, unknown>) {
  const context = storage.getStore();
  if (context) Object.assign(context.identity,projectDiagnosticFields(identity));
}
export function diagnosticCompleteness() {
  const context = storage.getStore();
  return {droppedEvents:context?.state.dropped ?? 0, sinkFailures:context?.state.sinkFailures ?? 0, activeSpans:context?.state.active ?? 0, count:context?.state.sequence ?? 0, emittedEvents:(context?.state.sequence ?? 0)-(context?.state.dropped ?? 0)};
}
export async function diagnosticSpan<T>(name: string, operation: () => Promise<T>, fields: Record<string, unknown> = {}): Promise<T> {
  const context = storage.getStore();
  const spanId = randomUUID();
  const started = performance.now();
  if (context) context.state.active++;
  diagnosticEvent(`${name}.started`, {...fields,spanId});
  try {
    const result = await (context ? storage.run({...context, identity:context.identity,spanId},operation) : operation());
    diagnosticEvent(`${name}.complete`,{...fields,spanId,durationMs:elapsed(started),outcome:'ok'});
    return result;
  } catch (error) {
    diagnosticError(`${name}.failed`,error,{...fields,spanId,durationMs:elapsed(started),knownOutcome:'unknown'});
    throw error;
  } finally { if (context) context.state.active--; }
}

export function bindDiagnosticCallback<T extends (...args: any[]) => any>(callback: T): T {
  const context = storage.getStore();
  return function(this: unknown,...args: any[]) {
    return context ? storage.run(context,()=>callback.apply(this,args)) : storage.exit(()=>callback.apply(this,args));
  } as T;
}

export function hasDiagnosticContext() { return Boolean(storage.getStore()); }

/** Defense in depth for persistent storage; unknown envelope/payload fields cannot be written. */
export function projectDiagnosticEnvelope(input: DiagnosticEvent): DiagnosticEvent | undefined {
  if (!isUuid(input.eventId) || typeof input.timestamp !== 'string' || !Number.isFinite(Date.parse(input.timestamp)) ||
      !asciiToken(input.name,120) || typeof input.eventSeq !== 'number' || !Number.isSafeInteger(input.eventSeq) || input.eventSeq<1) return undefined;
  const event: DiagnosticEvent = {...projectDiagnosticFields(input),event:'diagnostic',schemaVersion:1,eventId:input.eventId,
    timestamp:new Date(input.timestamp).toISOString(),service:'chat-ai',name:input.name,eventSeq:input.eventSeq};
  if (typeof input.buildCommit==='string' && [40,64].includes(input.buildCommit.length) && [...input.buildCommit].every(c=>'0123456789abcdef'.includes(c))) event.buildCommit=input.buildCommit;
  for (const key of ['deploymentId','instanceId']) if (isUuid(input[key])) event[key]=input[key];
  return event;
}
