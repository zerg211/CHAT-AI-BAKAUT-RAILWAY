import { z } from 'zod';

/** Reference immutable text, including Markdown, rather than asking a reviewer to copy it. */
export function reviewClaimReferences(answerText: string) {
  return answerText.split('\n').filter(text => text.trim()).map((text, index) => ({ id: `claim_${index + 1}`, text }));
}

export function expandReviewFindings(raw: unknown, claims: ReturnType<typeof reviewClaimReferences>, sourceIds: string[]) {
  const findings = z.array(z.object({ claimId: z.string(), sourceResultId: z.string(), reason: z.string().trim().min(1) }).strict()).max(5).parse(raw);
  return findings.map(finding => {
    const claim = claims.find(claim => claim.id === finding.claimId);
    if (!claim || !sourceIds.includes(finding.sourceResultId)) throw new Error('semantic_factual_review_unbound_evidence');
    return { claim: claim.text, sourceResultId: finding.sourceResultId, reason: finding.reason };
  });
}
