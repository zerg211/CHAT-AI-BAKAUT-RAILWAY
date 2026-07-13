const token = process.env.ADMIN_PASSWORD || process.env.ADMIN_API_KEY;
if (!token) throw new Error('ADMIN_PASSWORD or ADMIN_API_KEY is required');

const baseUrl = 'https://chat-ai-production-3057.up.railway.app';
const headers = { Authorization: `Bearer ${token}` };
const listResponse = await fetch(`${baseUrl}/api/admin/conversations?limit=20&filter=withMessages`, { headers });
if (!listResponse.ok) throw new Error(`Admin list failed: ${listResponse.status}`);
const list = await listResponse.json() as { sessions: Array<{ id: string }> };

let detail: any;
for (const candidate of list.sessions) {
  const response = await fetch(`${baseUrl}/api/admin/conversations/${candidate.id}`, { headers });
  if (!response.ok) continue;
  const candidateDetail = await response.json() as any;
  if (candidateDetail.messages?.some((message: any) =>
    message.role === 'user' &&
    message.content === 'Покажите 2–3 бензиновых однофазных варианта примерно 5–6 кВт с ценами. Шильдика насоса сейчас под рукой нет.'
  )) {
    detail = candidateDetail;
    break;
  }
}
if (!detail) throw new Error('Attempt 2 conversation not found');

const turnsById = new Map(detail.turns.map((turn: any) => [turn.id, turn]));
const assistantMessages = detail.messages
  .filter((message: any) => message.role === 'assistant' && message.metadata?.agentManager)
  .sort((left: any, right: any) => left.createdAt.localeCompare(right.createdAt));

console.log(JSON.stringify({
  sessionId: detail.session.id,
  commitSha: '5c3f0b223588a36b26b3beaee395dc7b1787cb35',
  assistantTurns: assistantMessages.map((message: any, index: number) => {
    const metadata = message.metadata;
    const turn = turnsById.get(metadata.turnId) as any;
    return {
      index: index + 1,
      turnId: metadata.turnId,
      turnStatus: turn?.status,
      turnStage: turn?.stage,
      errorCode: turn?.errorCode,
      errorMessage: turn?.errorMessage,
      selectionGoal: metadata.intentContract?.selectionPolicy?.selectionGoal,
      reusePreviousCards: metadata.intentContract?.selectionPolicy?.reusePreviousCards,
      requirements: (metadata.intentContract?.selectionPolicy?.requirements ?? []).map((requirement: any) => ({
        id: requirement.id,
        kind: requirement.kind,
        value: requirement.value,
        role: requirement.role,
        strictness: requirement.strictness,
        relation: requirement.relation,
        verification: requirement.verification
      })),
      historicalSelectionEvidence: metadata.historicalSelectionEvidence,
      toolResults: (metadata.toolResults ?? []).map((result: any) => ({
        requestId: result.requestId,
        tool: result.tool,
        status: result.status,
        productIds: result.payload?.productIds,
        generatorLoadFit: result.payload?.generatorLoadFit,
        structuredRecovery: result.payload?.retrieval?.structuredRecovery,
        candidateTiers: result.payload?.retrieval?.candidateTiers,
        warnings: result.warnings
      })),
      answerProducts: (metadata.answerProductEvidence?.products ?? []).map((product: any) => ({
        id: product.id,
        name: product.name,
        price: product.price
      })),
      cards: (metadata.productCards ?? []).map((card: any) => ({
        id: card.id,
        name: card.name,
        price: card.price
      })),
      cardSelectionWarnings: metadata.cardSelection?.warnings,
      selectionReadiness: metadata.selectionReadiness,
      preSendReview: metadata.preSendReview,
      warnings: metadata.warnings
    };
  })
}, null, 2));
