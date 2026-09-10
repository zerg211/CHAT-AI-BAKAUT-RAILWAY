import { describe, expect, it } from 'vitest';
import type { AgentIntentContract, ToolResult } from '../src/ai/agentManagerContracts.js';
import { injectFirstPartyPageReads, unreadFirstPartyUrls } from '../src/ai/firstPartyTurnInjection.js';
import { deriveTaskOutcome, firstPartyAnswerReviewIssues, stalledRepetitionReviewIssues, summarizeTurnOutcome, detectStalledRepetition } from '../src/ai/taskOutcome.js';

const okPageRead = (canonicalUrl: string): ToolResult => ({
  requestId: 'fp1',
  tool: 'site.readFirstPartyPage',
  status: 'ok',
  payload: { canonicalUrl },
  warnings: []
});

const baseIntent = { requiresTools: false, toolRequests: [] } as unknown as AgentIntentContract;

describe('first-party turn injection', () => {
  it('injects a deterministic read for a buyer-supplied first-party URL', () => {
    const intent = injectFirstPartyPageReads(baseIntent, 'Вот карточка https://bakautprof.ru/catalog/gen_x/');
    expect(intent.toolRequests).toHaveLength(1);
    expect(intent.toolRequests[0]).toMatchObject({ tool: 'site.readFirstPartyPage' });
    expect(intent.toolRequests[0]!.args.url).toBe('https://bakautprof.ru/catalog/gen_x');
    expect(intent.requiresTools).toBe(true);
    // Stable across restarts: same URL, same request id.
    const again = injectFirstPartyPageReads(baseIntent, 'Вот карточка https://bakautprof.ru/catalog/gen_x/');
    expect(again.toolRequests[0]!.id).toBe(intent.toolRequests[0]!.id);
  });

  it('never duplicates a planner-scheduled read of the same page', () => {
    const planned = {
      ...baseIntent,
      toolRequests: [{
        id: 'planner-1', tool: 'site.readFirstPartyPage',
        args: { url: 'https://bakautprof.ru/catalog/gen_x' },
        rationale: 'planner read', required: true, coversRequirementIds: []
      }]
    } as unknown as AgentIntentContract;
    expect(injectFirstPartyPageReads(planned, 'https://bakautprof.ru/catalog/gen_x/')).toBe(planned);
  });

  it('ignores external URLs', () => {
    expect(injectFirstPartyPageReads(baseIntent, 'Смотрите https://example.com/x').toolRequests).toEqual([]);
  });

  it('tracks unread URLs against successful reads', () => {
    const message = 'Вот карточка https://bakautprof.ru/catalog/gen_x/';
    expect(unreadFirstPartyUrls(message, [])).toEqual(['https://bakautprof.ru/catalog/gen_x']);
    expect(unreadFirstPartyUrls(message, [okPageRead('https://bakautprof.ru/catalog/gen_x')])).toEqual([]);
  });
});

describe('task outcome', () => {
  it('never resolves while a buyer-supplied URL stays unread', () => {
    const outcome = deriveTaskOutcome({
      goal: 'identify product',
      userMessage: 'Вот карточка https://bakautprof.ru/catalog/gen_x/',
      toolResults: []
    });
    expect(outcome.status).toBe('blocked_missing_evidence');
    expect(outcome.requiredNextAction).toContain('read');
  });

  it('resolves when the page was read and nothing blocks', () => {
    const outcome = deriveTaskOutcome({
      goal: 'identify product',
      userMessage: 'Вот карточка https://bakautprof.ru/catalog/gen_x/',
      toolResults: [okPageRead('https://bakautprof.ru/catalog/gen_x')],
      resolvedFacts: ['page identity confirmed']
    });
    expect(outcome.status).toBe('resolved');
  });

  it('captured lead is a human operation, not a resolution', () => {
    const outcome = deriveTaskOutcome({ goal: 'check stock', userMessage: 'позвоните мне', toolResults: [], leadCaptured: true });
    expect(outcome.status).toBe('needs_human_operation');
  });

  it('failed tools without evidence block on tool failure', () => {
    const outcome = deriveTaskOutcome({ goal: 'x', userMessage: 'x', toolResults: [], toolFailures: ['web.timeout'] });
    expect(outcome.status).toBe('blocked_tool_failure');
  });
});

describe('first-party answer review', () => {
  it('flags an answer when the URL was never attempted', () => {
    const issues = firstPartyAnswerReviewIssues({
      userMessage: 'Вот карточка https://bakautprof.ru/catalog/gen_x/',
      toolResults: []
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('first_party_evidence_unconsulted');
  });

  it('stays silent once a read was attempted, even on failure', () => {
    const failed = { ...okPageRead('https://bakautprof.ru/catalog/gen_x/'), status: 'error' as const };
    expect(firstPartyAnswerReviewIssues({ userMessage: 'https://bakautprof.ru/catalog/gen_x/', toolResults: [failed] })).toEqual([]);
  });
});

describe('stalled repetition detection', () => {
  it('fires when stronger evidence produces an identical blocking outcome with no new action', () => {
    const previous = summarizeTurnOutcome({
      userMessage: 'что по Tecener',
      toolResults: [],
      readinessStatus: 'needs_more_info',
      selectedProductIds: [],
      leadAction: 'none'
    });
    // Buyer adds an SKU but outcome stays blocked with zero coverage.
    const current = summarizeTurnOutcome({
      userMessage: 'артикул 1110511',
      toolResults: [],
      readinessStatus: 'needs_more_info',
      selectedProductIds: [],
      leadAction: 'none'
    });
    expect(previous.evidenceFingerprint).not.toBe(current.evidenceFingerprint);
    expect(detectStalledRepetition(previous, current)).toBe(true);
  });

  it('does not fire when the outcome changed', () => {
    const previous = summarizeTurnOutcome({ userMessage: 'что по Tecener', toolResults: [], readinessStatus: 'needs_more_info' });
    const current = summarizeTurnOutcome({
      userMessage: 'артикул 1110511',
      toolResults: [],
      readinessStatus: 'ready_for_exact_cards',
      selectedProductIds: ['p1'],
      leadAction: 'none'
    });
    expect(detectStalledRepetition(previous, current)).toBe(false);
  });

  it('does not fire when a materially new action clears the stall', () => {
    const previous = summarizeTurnOutcome({ userMessage: 'что по Tecener', toolResults: [] });
    const current = summarizeTurnOutcome({
      userMessage: 'артикул 1110511',
      toolResults: [{ requestId: 's1', tool: 'catalog.search', status: 'ok', payload: {}, warnings: [] }],
      toolRequests: [{ id: 's1', tool: 'catalog.search', args: { query: '1110511' } }]
    });
    expect(detectStalledRepetition(previous, current)).toBe(false);
  });

  it('emits a review issue from assistant history', () => {
    const history = [
      { role: 'user', content: 'что по Tecener', metadata: null },
      { role: 'assistant', content: 'не нашли', metadata: {
        answerContract: { selectionReadiness: { status: 'needs_more_info' }, selectedProductIds: [], leadAction: 'none' },
        toolResults: []
      } }
    ];
    const issues = stalledRepetitionReviewIssues({
      history,
      userMessage: 'вот артикул 1110511',
      toolResults: [],
      readinessStatus: 'needs_more_info',
      selectedProductIds: [],
      leadAction: 'none'
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('stalled_repeated_refusal');
  });
});
