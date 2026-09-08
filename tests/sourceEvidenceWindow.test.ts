import { describe, expect, it } from 'vitest';
import { boundedSemanticSourceTextForEvidence } from '../src/ai/productComparisonResearch.js';
import { DOCUMENT_PASSAGE_GAP } from '../src/ai/documentEvidence.js';

describe('long document source context retrieval', () => {
  const prefix = 'Manufacturer manual for models UNIT-A and UNIT-B. ';
  const passage = 'Standard kit UNIT-A: Spark plug wrench with bar. Working handle assembly. Air filter cover with fastening screw. UNIT-B: filter cover only.';
  const source = prefix + 'General safety instruction. '.repeat(1600) + passage + ' Maintenance notes. '.repeat(1400);
  it('retrieves a late kit section for a stitched proposed quotation without inventing source text', () => {
    const proposal = 'For UNIT-A: "Spark plug wrench with bar", "Working handle assembly", "Air filter cover with fastening screw".';
    const result = boundedSemanticSourceTextForEvidence(source, proposal);
    expect(result.text.length).toBeLessThanOrEqual(18000);
    expect(result.text).toContain(prefix.trim());
    expect(result.text).toContain(passage);
    expect(result.text).not.toContain(proposal);
    for (const excerpt of result.text.split(DOCUMENT_PASSAGE_GAP)) expect(source.replace(/\s+/g, ' ').trim().includes(excerpt)).toBe(true);
  });
  it('retains the contrasting model and negative conditions for semantic verification', () => {
    const result = boundedSemanticSourceTextForEvidence(source, 'UNIT-B includes Spark plug wrench with bar and Working handle assembly.');
    expect(result.text).toContain('UNIT-B: filter cover only.');
    expect(result.text).toContain('Standard kit UNIT-A:');
  });
  it('does not insert unmatched claims or exceed the existing bound', () => {
    const result = boundedSemanticSourceTextForEvidence(source, 'Imaginary completely invented component');
    expect(result.text).toBe(source.slice(0,18000));
    expect(result.truncated).toBe(true);
  });
});
