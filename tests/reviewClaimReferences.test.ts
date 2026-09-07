import { describe, it, expect } from 'vitest';
import { reviewClaimReferences, expandReviewFindings } from '../src/ai/reviewClaimReferences.js';

describe('source-bound reviewer claim references', () => {
  const text = 'Двигатель **Loncin G210FA-BQ CN**, мощность **3,6 кВт**.\n\nHonda относится к другому варианту.';
  const claims = reviewClaimReferences(text);
  it('binds the exact immutable Markdown fragment without retyping a quote', () => {
    const [finding] = expandReviewFindings([{claimId:'claim_1',sourceResultId:'details',reason:'Мощность противоречит источнику.'}],claims,['details']);
    expect(finding.claim).toBe('Двигатель **Loncin G210FA-BQ CN**, мощность **3,6 кВт**.');
    expect(text.includes(finding.claim)).toBe(true);
    expect(finding.sourceResultId).toBe('details');
  });
  it('keeps a negation in a separate referenced fragment', () => {
    expect(expandReviewFindings([{claimId:'claim_2',sourceResultId:'details',reason:'Проверить область отрицания.'}],claims,['details'])[0].claim).toBe('Honda относится к другому варианту.');
  });
  it.each([
    {claimId:'claim_99',sourceResultId:'details',reason:'wrong'},
    {claimId:'claim_1',sourceResultId:'invented',reason:'wrong'},
    {claimId:'claim_1',sourceResultId:'details',reason:''},
    {claim:'paraphrased text',sourceResultId:'details',reason:'wrong'}
  ])('rejects an unbound or malformed finding %j',finding => {
    expect(()=>expandReviewFindings([finding],claims,['details'])).toThrow();
  });
});
