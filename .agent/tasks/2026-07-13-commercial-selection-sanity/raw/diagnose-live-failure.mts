const token = process.env.ADMIN_PASSWORD || process.env.ADMIN_API_KEY;
if (!token) throw new Error('ADMIN_PASSWORD or ADMIN_API_KEY is required');

const baseUrl = 'https://chat-ai-production-3057.up.railway.app';
const headers = { Authorization: `Bearer ${token}` };
const listResponse = await fetch(`${baseUrl}/api/admin/conversations?limit=30&filter=withMessages`, { headers });
if (!listResponse.ok) throw new Error(`Admin list failed: ${listResponse.status}`);
const list = await listResponse.json() as { sessions: Array<{ id: string; createdAt?: string; updatedAt?: string }> };

let detail: any;
for (const candidate of list.sessions) {
  const response = await fetch(`${baseUrl}/api/admin/conversations/${candidate.id}`, { headers });
  if (!response.ok) continue;
  const candidateDetail = await response.json() as any;
  if (candidateDetail.messages?.some((message: any) =>
    message.role === 'user' && message.content === 'Нужен генератор для дачи. Что можете предложить?'
  )) {
    detail = candidateDetail;
    break;
  }
}
if (!detail) throw new Error('Live failure conversation not found');

const assistantMessages = detail.messages
  .filter((message: any) => message.role === 'assistant' && message.metadata?.agentManager)
  .sort((left: any, right: any) => left.createdAt.localeCompare(right.createdAt));

const compactToolResult = (result: any) => ({
  requestId: result.requestId,
  tool: result.tool,
  status: result.status,
  warnings: result.warnings,
  productIds: result.payload?.productIds,
  generatorLoadFit: result.payload?.generatorLoadFit,
  retrieval: result.payload?.retrieval && {
    intent: result.payload.retrieval.intent,
    query: result.payload.retrieval.query,
    candidateTiers: result.payload.retrieval.candidateTiers,
    structuredRecovery: result.payload.retrieval.structuredRecovery
  }
});

console.log(JSON.stringify({
  sessionId: detail.session.id,
  commitSha: '50ee8a5d8d7b64346933c628844a20842c3ebeb0',
  turns: detail.turns.map((turn: any) => ({
    id: turn.id,
    status: turn.status,
    stage: turn.stage,
    errorCode: turn.errorCode,
    errorMessage: turn.errorMessage
  })),
  assistantTurns: assistantMessages.map((message: any, index: number) => ({
    index: index + 1,
    createdAt: message.createdAt,
    answer: message.content,
    selectionPolicy: message.metadata.intentContract?.selectionPolicy,
    grounding: message.metadata.intentContract?.grounding,
    productMentions: message.metadata.intentContract?.productMentions,
    historicalSelectionEvidence: message.metadata.historicalSelectionEvidence,
    toolResults: (message.metadata.toolResults ?? []).map(compactToolResult),
    answerProducts: (message.metadata.answerProductEvidence?.products ?? []).map((product: any) => ({
      id: product.id,
      name: product.name,
      price: product.price,
      specs: product.specs
    })),
    answerProductEvidence: {
      droppedProductIds: message.metadata.answerProductEvidence?.droppedProductIds,
      warnings: message.metadata.answerProductEvidence?.warnings,
      candidateTiers: message.metadata.answerProductEvidence?.candidateTiers
    },
    cards: (message.metadata.productCards ?? []).map((card: any) => ({
      id: card.id,
      name: card.name,
      price: card.price,
      specs: card.specs
    })),
    cardSelection: message.metadata.cardSelection,
    selectionReadiness: message.metadata.selectionReadiness,
    preSendReview: message.metadata.preSendReview,
    warnings: message.metadata.warnings
  }))
}, null, 2));
