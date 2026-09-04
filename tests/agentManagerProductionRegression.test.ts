import { describe, expect, it, vi } from 'vitest';
import type { AgentIntentContract, ToolRequest } from '../src/ai/agentManagerContracts.js';
const structured = vi.hoisted(() => vi.fn());
vi.mock('../src/ai/openaiStructured.js', () => ({ createStructuredJsonResponse: structured }));
import { OpenAIAgentManagerModel, orderToolRequestsForSelectionDependencies } from '../src/ai/agentManagerOrchestrator.js';

describe('production consultation regressions', () => {
  it.each([
    {},
    { processDisclosure: 'false', evidence: '', rationale: 'ok', factualIssues: [] },
    { processDisclosure: false, evidence: '', factualIssues: [] },
    { processDisclosure: false, evidence: '', rationale: 'ok', factualIssues: null }
  ])('rejects malformed semantic reviewer output instead of interpreting it as permission to send: %j', async (parsed) => {
    structured.mockResolvedValueOnce({ parsed });
    await expect(new OpenAIAgentManagerModel().reviewCustomerLanguage({
      answerText: 'В руководстве указан объём масла.', products: [], toolResults: []
    })).rejects.toThrow('semantic_language_review_invalid_contract');
  });

  it.each(['independent_required', 'buyer_requested', 'conditional_on_catalog_gap'] as const)('reads product details before %s external verification', (webRequirement) => {
    const request = (id: string, tool: ToolRequest['tool']): ToolRequest => ({ id, tool, args: {}, required: true, rationale: 'Read the exact target', coversRequirementIds: [] });
    const requests = [request('web', 'web.researchProductFacts'), request('details', 'catalog.getProductDetails'), request('search', 'catalog.search')];
    const intent = { toolRequests: requests, grounding: { webRequirement } } as AgentIntentContract;
    expect(orderToolRequestsForSelectionDependencies(requests, intent).map(item => item.id)).toEqual(['search', 'details', 'web']);
  });

  it('passes buyer source-verification context to the same semantic review that checks the answer', async () => {
    structured.mockResolvedValueOnce({ parsed: { processDisclosure: false, evidence: '', rationale: 'Source attribution answers the buyer question.', factualIssues: [] } });
    const input = { userMessage: 'Проверьте первую замену по руководству производителя.', answerText: 'В руководстве указан интервал первой замены; для точной редакции нужен серийный номер.', products: [], toolResults: [] };
    await new OpenAIAgentManagerModel().reviewCustomerLanguage(input);
    const payload = JSON.parse(structured.mock.calls.at(-1)![0].request.input.find((item: {role: string}) => item.role === 'user').content);
    expect(payload.userMessage).toBe(input.userMessage);
    expect(payload.answerText).toBe(input.answerText);
  });
});
