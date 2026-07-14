const token = process.env.ADMIN_PASSWORD || process.env.ADMIN_API_KEY;
if (!token) throw new Error('ADMIN_PASSWORD or ADMIN_API_KEY is required');

const baseUrl = 'https://chat-ai-production-3057.up.railway.app';
const headers = { Authorization: `Bearer ${token}` };
const listResponse = await fetch(`${baseUrl}/api/admin/conversations?limit=30&filter=withMessages`, { headers });
if (!listResponse.ok) throw new Error(`Admin list failed: ${listResponse.status}`);
const list = await listResponse.json() as { sessions: Array<{ id: string }> };

let detail: any;
for (const candidate of list.sessions) {
  const response = await fetch(`${baseUrl}/api/admin/conversations/${candidate.id}`, { headers });
  if (!response.ok) continue;
  const candidateDetail = await response.json() as any;
  if (candidateDetail.messages?.some((message: any) =>
    message.role === 'user' && message.content?.includes('не собираюсь ехать за ним ради первого выбора')
  )) {
    detail = candidateDetail;
    break;
  }
}
if (!detail) throw new Error('Attempt 6 conversation not found');

const turnsById = new Map(detail.turns.map((turn: any) => [turn.id, turn]));
const messages = detail.messages
  .filter((message: any) => message.role === 'assistant')
  .sort((left: any, right: any) => left.createdAt.localeCompare(right.createdAt));

console.log(JSON.stringify({
  sessionId: detail.session.id,
  commitSha: '31f965d277f0ef9e0377cb2955f4a0990fa22579',
  turns: detail.turns.map((turn: any) => ({
    id: turn.id,
    status: turn.status,
    stage: turn.stage,
    errorCode: turn.errorCode,
    errorMessage: turn.errorMessage,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt
  })),
  assistantMessages: messages.map((message: any, index: number) => {
    const metadata = message.metadata ?? {};
    const turn = turnsById.get(metadata.turnId) as any;
    return {
      index: index + 1,
      content: message.content,
      recovered: metadata.recovered,
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
        unit: requirement.unit,
        role: requirement.role,
        strictness: requirement.strictness,
        relation: requirement.relation,
        verification: requirement.verification
      })),
      toolResults: (metadata.toolResults ?? []).map((result: any) => ({
        requestId: result.requestId,
        tool: result.tool,
        status: result.status,
        productIds: result.payload?.productIds,
        generatorLoadFit: result.payload?.generatorLoadFit,
        structuredRecovery: result.payload?.retrieval?.structuredRecovery,
        candidateTiers: result.payload?.retrieval?.candidateTiers,
        warnings: result.warnings,
        errorCode: result.errorCode
      })),
      historicalSelectionEvidence: metadata.historicalSelectionEvidence,
      answerProductIds: (metadata.answerProductEvidence?.products ?? []).map((product: any) => product.id),
      answerProductWarnings: metadata.answerProductEvidence?.warnings,
      cardIds: (metadata.productCards ?? []).map((card: any) => card.id),
      cardWarnings: metadata.cardSelection?.warnings,
      selectionReadiness: metadata.selectionReadiness,
      preSendReview: metadata.preSendReview,
      warnings: metadata.warnings
    };
  })
}, null, 2));
