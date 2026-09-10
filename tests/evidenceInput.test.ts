import { describe, expect, it } from 'vitest';
import { evidenceFingerprint, evidenceStrength, extractEvidenceInput } from '../src/ai/evidenceInput.js';

describe('evidence input normalization', () => {
  it('extracts a pure-digit article without LLM or embeddings', () => {
    const input = extractEvidenceInput('Подскажите по артикулу 1110511');
    expect(input.identifiers).toEqual([
      { kind: 'numeric_article', value: '1110511', normalized: '1110511', provenance: 'user_message' }
    ]);
    expect(input.urls).toEqual([]);
  });

  it('extracts a letter+digit model code and normalizes case', () => {
    const input = extractEvidenceInput('Что скажете про Tecener te6000glis?');
    expect(input.identifiers).toEqual([
      { kind: 'model_code', value: 'te6000glis', normalized: 'TE6000GLIS', provenance: 'user_message' }
    ]);
  });

  it('canonicalizes a first-party URL and strips tracking params', () => {
    const input = extractEvidenceInput(
      'Вот карточка https://bakautprof.ru/catalog/invertornye_generatory/generator_x/?roistat_visit=286219&utm_source=chat#top'
    );
    expect(input.urls).toHaveLength(1);
    expect(input.urls[0]).toMatchObject({
      host: 'bakautprof.ru',
      pathname: '/catalog/invertornye_generatory/generator_x',
      firstParty: true
    });
    expect(input.urls[0]!.canonical).toBe('https://bakautprof.ru/catalog/invertornye_generatory/generator_x');
  });

  it('marks foreign hosts as external and keeps semantic query params', () => {
    const input = extractEvidenceInput('Смотрите https://example.com/page?color=red&utm_medium=cpc');
    expect(input.urls[0]).toMatchObject({ firstParty: false });
    expect(input.urls[0]!.canonical).toBe('https://example.com/page?color=red');
  });

  it('skips phone-length digit runs and wrapping punctuation', () => {
    const input = extractEvidenceInput('Мой номер 88005508871, (артикул: 1110511).');
    expect(input.identifiers.map((id) => id.normalized)).toEqual(['1110511']);
  });

  it('dedupes repeated evidence and fingerprints it', () => {
    const input = extractEvidenceInput('1110511 и ещё раз 1110511');
    expect(input.identifiers).toHaveLength(1);
    expect(evidenceFingerprint(input)).toBe('numeric_article:1110511');
  });

  it('ranks first-party URL above article above model code', () => {
    expect(evidenceStrength(extractEvidenceInput('https://bakautprof.ru/catalog/x/'))).toBe(4);
    expect(evidenceStrength(extractEvidenceInput('1110511'))).toBe(3);
    expect(evidenceStrength(extractEvidenceInput('TE6000GLIS'))).toBe(2);
    expect(evidenceStrength(extractEvidenceInput('привет'))).toBe(0);
  });
});
