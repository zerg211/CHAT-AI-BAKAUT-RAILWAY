import { describe, expect, it } from 'vitest';
import type { AnswerContract, ToolResult } from '../src/ai/agentManagerContracts.js';
import {
  answerEvidenceItemsForModel,
  bindUniqueMissingAnswerEvidenceItems,
  resolveAnswerEvidenceBindings
} from '../src/ai/answerEvidenceBindings.js';

const research: ToolResult = {
  requestId: 'research', tool: 'web.researchProductFacts', status: 'ok', warnings: [],
  payload: {
    products: [{ id: 'stale', name: 'Fubag BS 8000', specs: { weight_kg: 89.2 } }],
    facts: [{ productName: 'Fubag BS 8000', attribute: 'noise_value', value: '84 dB', evidence: 'Уровень шума, дб 84',
      sourceType: 'web', evidenceVerifiedExact: true }],
    answerGuidance: { coverage: [{ productName: 'Fubag BS 8000', attribute: 'weight_net_kg', status: 'not_confirmed', value: 'Масса нетто не указана', evidence: 'Вес, кг 93.5 — без обозначения массы нетто', evidenceVerifiedExact: true }] }
  }
};

const generatorLoad: ToolResult = {
  requestId: 'load', tool: 'calculator.generatorLoad', status: 'ok', warnings: [],
  payload: {
    loads: [
      { name: 'холодильник', runningKw: 0.3 },
      { name: 'насос', runningKw: 1.1 },
      { name: 'инструмент', runningKw: 1.5 }
    ],
    profile: { totalRunningKw: 2.9 }
  }
};

const productionGeneratorLoad: ToolResult = {
  requestId: 'calc_generator_workshop_1', tool: 'calculator.generatorLoad', status: 'ok', warnings: [],
  payload: {
    profile: {
      items: [
        { kind: 'refrigerator', name: 'холодильник', runningKw: 0.3 },
        { kind: 'pump', name: 'циркуляционный насос', runningKw: 1.1, startingKw: 3.3,
          startingSource: 'estimated_average' },
        { kind: 'handheld_tool', name: 'инструмент', runningKw: 1.5 }
      ],
      totalRunningKw: 2.9,
      missingStartingLoads: ['refrigerator:холодильник', 'handheld_tool:инструмент'],
      runningOnlyNominalFloorKw: 3
    }
  }
};

const countedGeneratorLoad: ToolResult = {
  requestId: 'counted-load', tool: 'calculator.generatorLoad', status: 'ok', warnings: [],
  payload: {
    loads: [{ name: 'насос', runningKw: 1, count: 2, simultaneousRunning: true, coRunningGroup: 'main' }],
    scenarios: [{ id: 'main', totalRunningKw: 2 }],
    profile: { totalRunningKw: 2, operationMode: 'strongest_scenario' }
  }
};

function answer(fact: AnswerContract['factsUsed'][number]): AnswerContract {
  return { answerText: 'x', factsUsed: [fact], questionsAsked: [], toolResultIds: ['research'],
    leadAction: 'none', riskFlags: [] };
}

describe('claim-level answer evidence bindings', () => {
  it('does not expose nested stale catalog context as web evidence', () => {
    const resolution = resolveAnswerEvidenceBindings({
      answer: answer({ factKey: 'weight', sourceEventIds: ['research'], evidenceItemIds: ['research:product:stale:spec:weight_kg'],
        productName: 'Fubag BS 8000', attribute: 'weight_kg', claimKind: 'confirmed_value', value: 89.2 }),
      toolResults: [research]
    });
    expect(resolution.issues.map((issue) => issue.code)).toContain('numeric_fact_evidence_binding_unknown');
  });

  it('rejects a changed number even with the same request id and evidence item', () => {
    const resolution = resolveAnswerEvidenceBindings({
      answer: answer({ factKey: 'noise', sourceEventIds: ['research'], evidenceItemIds: ['research:fact:0'],
        productName: 'Fubag BS 8000', attribute: 'noise_value', claimKind: 'confirmed_value', value: '88.1 dB' }),
      toolResults: [research]
    });
    expect(resolution.issues.map((issue) => issue.code)).toContain('numeric_fact_value_not_in_bound_evidence');
  });

  it('matches complete numeric tokens rather than substrings', () => {
    const changed = structuredClone(research);
    (changed.payload.facts as Array<Record<string, unknown>>)[0]!.value = '184 dB';
    (changed.payload.facts as Array<Record<string, unknown>>)[0]!.evidence = 'Уровень шума, дб 184';
    const resolution = resolveAnswerEvidenceBindings({
      answer: answer({ factKey: 'noise', sourceEventIds: ['research'], evidenceItemIds: ['research:fact:0'],
        productName: 'Fubag BS 8000', attribute: 'noise_value', claimKind: 'confirmed_value', value: '84 dB' }),
      toolResults: [changed]
    });
    expect(resolution.issues.map((issue) => issue.code)).toContain('numeric_fact_value_not_in_bound_evidence');
  });

  it('preserves leading-zero and long integer identifiers exactly', () => {
    const changed = structuredClone(research);
    (changed.payload.facts as Array<Record<string, unknown>>)[0]!.value = 'SKU 064109112345678901';
    (changed.payload.facts as Array<Record<string, unknown>>)[0]!.evidence = 'SKU 064109112345678901';
    const resolution = resolveAnswerEvidenceBindings({
      answer: answer({ factKey: 'sku', sourceEventIds: ['research'], evidenceItemIds: ['research:fact:0'],
        productName: 'Fubag BS 8000', attribute: 'noise_value', claimKind: 'confirmed_value', value: 'SKU 64109112345678901' }),
      toolResults: [changed]
    });
    expect(resolution.issues.map((issue) => issue.code)).toContain('numeric_fact_value_not_in_bound_evidence');
  });

  it('binds an exact confirmed value and preserves its evidence path', () => {
    const resolution = resolveAnswerEvidenceBindings({
      answer: answer({ factKey: 'noise', sourceEventIds: ['research'], evidenceItemIds: ['research:fact:0'],
        productName: 'Fubag BS 8000', attribute: 'noise_value', claimKind: 'confirmed_value', value: '84 dB' }),
      toolResults: [research]
    });
    expect(resolution.issues).toEqual([]);
    expect(resolution.bindings[0]).toMatchObject({ evidenceItemId: 'research:fact:0', evidencePath: 'payload.facts[0]' });
  });

  it('remaps the production calculator aggregate to its single canonical total', () => {
    const result = resolveAnswerEvidenceBindings({
      answer: answer({ factKey: 'combined_running_load', sourceEventIds: ['load'],
        evidenceItemIds: ['load:payload:loads:0:runningKw', 'load:payload:loads:1:runningKw', 'load:payload:loads:2:runningKw'],
        productName: null, attribute: 'totalRunningKw', claimKind: 'confirmed_value', value: 2.9 }),
      toolResults: [generatorLoad]
    });
    expect(result.issues).toEqual([]);
    expect(result.bindings).toEqual([expect.objectContaining({
      evidenceItemId: 'load:payload:profile:totalRunningKw',
      evidencePath: 'payload.profile.totalRunningKw'
    })]);
  });

  it('uses the calculator canonical total when counts and scenarios differ from a naive component sum', () => {
    const result = resolveAnswerEvidenceBindings({
      answer: answer({ factKey: 'combined_running_load', sourceEventIds: ['counted-load'],
        evidenceItemIds: ['counted-load:payload:loads:0:runningKw'], productName: null,
        attribute: 'totalRunningKw', claimKind: 'confirmed_value', value: 2 }),
      toolResults: [countedGeneratorLoad]
    });
    expect(result.issues).toEqual([]);
    expect(result.bindings).toEqual([expect.objectContaining({
      evidenceItemId: 'counted-load:payload:profile:totalRunningKw'
    })]);
  });

  it('canonicalizes exact calculator profile paths copied with mixed display separators', () => {
    const cases: Array<AnswerContract['factsUsed'][number]> = [
      { factKey: 'total_running_load', sourceEventIds: ['calc_generator_workshop_1'],
        evidenceItemIds: ['calc_generator_workshop_1:payload.profile:totalRunningKw'], productName: null,
        attribute: 'totalRunningKw', claimKind: 'confirmed_value', value: 2.9 },
      { factKey: 'running_only_nominal_floor', sourceEventIds: ['calc_generator_workshop_1'],
        evidenceItemIds: ['calc_generator_workshop_1:payload.profile:runningOnlyNominalFloorKw'], productName: null,
        attribute: 'runningOnlyNominalFloorKw', claimKind: 'confirmed_value', value: 3 },
      { factKey: 'pump_start_estimate', sourceEventIds: ['calc_generator_workshop_1'],
        evidenceItemIds: ['calc_generator_workshop_1:payload.profile.items:1:startingKw'], productName: null,
        attribute: 'startingKw', claimKind: 'confirmed_value', value: 3.3 },
      { factKey: 'unresolved_startup_refrigerator', sourceEventIds: ['calc_generator_workshop_1'],
        evidenceItemIds: ['calc_generator_workshop_1:payload.profile:missingStartingLoads:0'], productName: null,
        attribute: 'missingStartingLoads', claimKind: 'absence_or_unknown', value: 'refrigerator:холодильник' },
      { factKey: 'unresolved_startup_tool', sourceEventIds: ['calc_generator_workshop_1'],
        evidenceItemIds: ['calc_generator_workshop_1:payload.profile:missingStartingLoads:1'], productName: null,
        attribute: 'missingStartingLoads', claimKind: 'absence_or_unknown', value: 'handheld_tool:инструмент' }
    ];
    const result = resolveAnswerEvidenceBindings({
      answer: { answerText: 'x', factsUsed: cases, questionsAsked: [],
        toolResultIds: ['calc_generator_workshop_1'], leadAction: 'none', riskFlags: [] },
      toolResults: [productionGeneratorLoad]
    });
    expect(result.issues).toEqual([]);
    expect(result.bindings.map((binding) => binding.evidenceItemId)).toEqual([
      'calc_generator_workshop_1:payload:profile:totalRunningKw',
      'calc_generator_workshop_1:payload:profile:runningOnlyNominalFloorKw',
      'calc_generator_workshop_1:payload:profile:items:1:startingKw',
      'calc_generator_workshop_1:payload:profile:missingStartingLoads:0',
      'calc_generator_workshop_1:payload:profile:missingStartingLoads:1'
    ]);
  });

  it('keeps calculator profile aliases fail-closed outside one exact matching item', () => {
    const ambiguous = structuredClone(productionGeneratorLoad);
    ambiguous.payload.profile = {
      total: { RunningKw: 2.9 },
      'total:RunningKw': 2.9
    };
    const cases = [
      { answer: answer({ factKey: 'wrong_value', sourceEventIds: ['calc_generator_workshop_1'],
        evidenceItemIds: ['calc_generator_workshop_1:payload.profile:totalRunningKw'], productName: null,
        attribute: 'totalRunningKw', claimKind: 'confirmed_value', value: 3.1 }), toolResults: [productionGeneratorLoad] },
      { answer: answer({ factKey: 'wrong_attribute', sourceEventIds: ['calc_generator_workshop_1'],
        evidenceItemIds: ['calc_generator_workshop_1:payload.profile:totalRunningKw'], productName: null,
        attribute: 'startingKw', claimKind: 'confirmed_value', value: 2.9 }), toolResults: [productionGeneratorLoad] },
      { answer: answer({ factKey: 'starting_value_from_source_label', sourceEventIds: ['calc_generator_workshop_1'],
        evidenceItemIds: ['calc_generator_workshop_1:payload.profile.items:1:startingSource'], productName: null,
        attribute: 'startingKw', claimKind: 'confirmed_value', value: 3.3 }), toolResults: [productionGeneratorLoad] },
      { answer: answer({ factKey: 'wrong_product', sourceEventIds: ['calc_generator_workshop_1'],
        evidenceItemIds: ['calc_generator_workshop_1:payload.profile:totalRunningKw'], productName: 'насос',
        attribute: 'totalRunningKw', claimKind: 'confirmed_value', value: 2.9 }), toolResults: [productionGeneratorLoad] },
      { answer: answer({ factKey: 'outside_profile', sourceEventIds: ['calc_generator_workshop_1'],
        evidenceItemIds: ['calc_generator_workshop_1:payload.loads:0:runningKw'], productName: null,
        attribute: 'runningKw', claimKind: 'confirmed_value', value: 0.3 }), toolResults: [productionGeneratorLoad] },
      { answer: answer({ factKey: 'wrong_source', sourceEventIds: ['calc_generator_workshop_1'],
        evidenceItemIds: ['other:payload.profile:totalRunningKw'], productName: null,
        attribute: 'totalRunningKw', claimKind: 'confirmed_value', value: 2.9 }), toolResults: [productionGeneratorLoad] },
      { answer: answer({ factKey: 'ambiguous_address', sourceEventIds: ['calc_generator_workshop_1'],
        evidenceItemIds: ['calc_generator_workshop_1:payload.profile:total:RunningKw'], productName: null,
        attribute: 'RunningKw', claimKind: 'confirmed_value', value: 2.9 }), toolResults: [ambiguous] }
    ];
    for (const candidate of cases) {
      expect(resolveAnswerEvidenceBindings(candidate).issues.length).toBeGreaterThan(0);
    }
  });

  it('keeps malformed calculator aggregate claims fail-closed', () => {
    const base = { factKey: 'combined_running_load', sourceEventIds: ['load'], productName: null,
      attribute: 'totalRunningKw', claimKind: 'confirmed_value' as const };
    const componentIds = ['load:payload:loads:0:runningKw', 'load:payload:loads:1:runningKw',
      'load:payload:loads:2:runningKw'];
    const missingCanonical = structuredClone(generatorLoad);
    delete (missingCanonical.payload as Record<string, unknown>).profile;
    const otherRequest = structuredClone(generatorLoad);
    otherRequest.requestId = 'other-load';
    const cases = [{
      answer: answer({ ...base, value: 3.1, evidenceItemIds: componentIds }),
      toolResults: [generatorLoad]
    }, {
      answer: answer({ ...base, value: 2.9, evidenceItemIds: componentIds }),
      toolResults: [missingCanonical]
    }, {
      answer: answer({ ...base, sourceEventIds: ['load', 'other-load'], value: 2.9,
        evidenceItemIds: ['load:payload:loads:0:runningKw', 'other-load:payload:loads:1:runningKw'] }),
      toolResults: [generatorLoad, otherRequest]
    }, {
      answer: answer({ ...base, value: 2.9, evidenceItemIds: ['load:payload:loads:0:name'] }),
      toolResults: [generatorLoad]
    }, {
      answer: answer({ ...base, productName: 'TSS SGG5000EI', value: 2.9, evidenceItemIds: componentIds }),
      toolResults: [generatorLoad]
    }];
    for (const input of cases) expect(resolveAnswerEvidenceBindings(input).issues.length).toBeGreaterThan(0);
  });

  it('keeps the canonical calculator total inside the per-tool evidence cap', () => {
    const crowded: ToolResult = { requestId: 'crowded', tool: 'calculator.generatorLoad', status: 'ok', warnings: [],
      payload: { loads: Array.from({ length: 100 }, (_, index) => ({ name: `load-${index}`, runningKw: index + 1 })),
        profile: { totalRunningKw: 5_050 } } };
    expect(answerEvidenceItemsForModel([crowded], 80).map((item) => item.id))
      .toContain('crowded:payload:profile:totalRunningKw');
  });

  it('allows a source label but not a confirmed net value from not-confirmed coverage', () => {
    const base = { factKey: 'weight-label', sourceEventIds: ['research'], evidenceItemIds: ['research:coverage:0'],
      productName: 'Fubag BS 8000', attribute: 'weight_net_kg', value: 'Вес, кг 93.5' };
    expect(resolveAnswerEvidenceBindings({ answer: answer({ ...base, claimKind: 'source_label' }), toolResults: [research] }).issues).toEqual([]);
    expect(resolveAnswerEvidenceBindings({ answer: answer({ ...base, claimKind: 'confirmed_value' }), toolResults: [research] }).issues
      .map((issue) => issue.code)).toContain('unconfirmed_evidence_used_as_confirmed_value');
  });

  it('does not let a null or related-model name bypass product scope', () => {
    for (const productName of [null, 'Fubag BS 8000 A ES']) {
      const resolution = resolveAnswerEvidenceBindings({
        answer: answer({ factKey: 'noise', sourceEventIds: ['research'], evidenceItemIds: ['research:fact:0'],
          productName, attribute: 'noise_value', claimKind: 'confirmed_value', value: '84 dB' }),
        toolResults: [research]
      });
      expect(resolution.issues.map((issue) => issue.code)).toContain('fact_evidence_product_mismatch');
    }
  });

  it('excludes unverified web facts and requires page text to be presented as a source label', () => {
    const unverified = structuredClone(research);
    delete (unverified.payload.facts as Array<Record<string, unknown>>)[0]!.evidenceVerifiedExact;
    expect(resolveAnswerEvidenceBindings({
      answer: answer({ factKey: 'noise', sourceEventIds: ['research'], evidenceItemIds: ['research:fact:0'],
        productName: 'Fubag BS 8000', attribute: 'noise_value', claimKind: 'confirmed_value', value: '84 dB' }),
      toolResults: [unverified]
    }).issues.map((issue) => issue.code)).toContain('numeric_fact_evidence_binding_unknown');

    const page: ToolResult = { requestId: 'page', tool: 'site.readFirstPartyPage', status: 'ok', warnings: [],
      payload: { title: 'Купить генератор выгодно', productIdentity: { title: 'Fubag BS 8000' }, text: 'Вес, кг 93.5' } };
    const base = { factKey: 'weight-label', sourceEventIds: ['page'], evidenceItemIds: ['page:page:text:0'],
      productName: 'Fubag BS 8000', attribute: 'page_text', value: 'Вес, кг 93.5' };
    expect(resolveAnswerEvidenceBindings({ answer: answer({ ...base, claimKind: 'confirmed_value' }), toolResults: [page] })
      .issues.map((issue) => issue.code)).toContain('unconfirmed_evidence_used_as_confirmed_value');
    expect(resolveAnswerEvidenceBindings({ answer: answer({ ...base, claimKind: 'source_label' }), toolResults: [page] })
      .issues).toEqual([]);

    const unverifiedCoverage = structuredClone(research);
    const unverifiedGuidance = unverifiedCoverage.payload.answerGuidance as { coverage: Array<Record<string, unknown>> };
    delete unverifiedGuidance.coverage[0]!.evidenceVerifiedExact;
    expect(resolveAnswerEvidenceBindings({
      answer: answer({ factKey: 'weight-label', sourceEventIds: ['research'], evidenceItemIds: ['research:coverage:0'],
        productName: 'Fubag BS 8000', attribute: 'weight_net_kg', claimKind: 'source_label', value: 'Вес, кг 93.5' }),
      toolResults: [unverifiedCoverage]
    }).issues.map((issue) => issue.code)).toContain('numeric_source_label_evidence_unverified');
  });

  it('prioritizes validated research and bounds writer evidence previews', () => {
    const catalog: ToolResult = { requestId: 'catalog', tool: 'catalog.search', status: 'ok', warnings: [], payload: {
      products: Array.from({ length: 50 }, (_, index) => ({ id: `p${index}`, name: `P${index}`,
        specs: { [`spec_${index}`]: 'x'.repeat(1000), another: index } }))
    } };
    const hints = answerEvidenceItemsForModel([catalog, research], 5);
    expect(hints[0]?.id).toBe('research:fact:0');
    expect(hints).toHaveLength(5);
    expect(hints.every((item) => item.evidence.length <= 640 && String(item.value).length <= 320)).toBe(true);
  });

  it('restores stable evidence ids for uniquely matching exact verified-memory facts', () => {
    const productName = 'Генератор бензиновый A-iPower A6500 (6,0 кВт) 20108';
    const memoryResearch: ToolResult = {
      requestId: 'research-memory', tool: 'web.researchProductFacts', status: 'ok', warnings: [], payload: {
        usedWebSearch: false, searchDisposition: 'memory_hit',
        facts: [
          { verifiedFactId: 'power-id', productName, attribute: 'nominal_power_kw', value: '6000 Вт',
            evidence: 'Номинальная мощность 6000 Вт', sourceType: 'web', evidenceVerifiedExact: true },
          { verifiedFactId: 'phase-id', productName, attribute: 'phases', value: '1, 230 В / 50 Гц, ток 26,1 А, cosφ 1',
            evidence: 'Число фаз 1; 230 В / 50 Гц; 26,1 А; cosφ 1', sourceType: 'web', evidenceVerifiedExact: true },
          { verifiedFactId: 'fuel-id', productName, attribute: 'fuel_type', value: 'бензиновый',
            evidence: 'Тип двигателя бензиновый', sourceType: 'web', evidenceVerifiedExact: true }
        ],
        answerGuidance: { coverage: [
          { productName, attribute: 'nominal_power_kw', status: 'confirmed', value: '6000 Вт',
            evidence: 'Номинальная мощность 6000 Вт', evidenceVerifiedExact: true },
          { productName, attribute: 'phases', status: 'confirmed', value: '1, 230 В / 50 Гц, ток 26,1 А, cosφ 1',
            evidence: 'Число фаз 1; 230 В / 50 Гц; 26,1 А; cosφ 1', evidenceVerifiedExact: true },
          { productName, attribute: 'fuel_type', status: 'confirmed', value: 'бензиновый',
            evidence: 'Тип двигателя бензиновый', evidenceVerifiedExact: true }
        ] }
      }
    };
    const draft: AnswerContract = {
      answerText: 'A-iPower: 6 кВт, одна фаза, бензиновый.', questionsAsked: [], toolResultIds: ['research-memory'],
      leadAction: 'none', riskFlags: [], factsUsed: [
        { factKey: 'power', sourceEventIds: ['research-memory'], productName, attribute: 'nominal power',
          claimKind: 'confirmed_value', value: '6 кВт' },
        { factKey: 'phase', sourceEventIds: ['research-memory'], productName, attribute: 'phases',
          claimKind: 'confirmed_value', value: '1, 230 В / 50 Гц, ток 26,1 А, cosφ 1' },
        { factKey: 'fuel', sourceEventIds: ['research-memory'], productName, attribute: 'fuel_type',
          claimKind: 'confirmed_value', value: 'бензиновый' }
      ]
    };
    const bound = bindUniqueMissingAnswerEvidenceItems({ answer: draft, toolResults: [memoryResearch] });
    expect(bound.factsUsed.map((fact) => fact.evidenceItemIds)).toEqual([
      ['research-memory:verified_fact:power-id:nominal_power'],
      ['research-memory:verified_fact:phase-id:phases'],
      ['research-memory:verified_fact:fuel-id:fuel_type']
    ]);
    const resolution = resolveAnswerEvidenceBindings({ answer: bound, toolResults: [memoryResearch] });
    expect(resolution.issues).toEqual([]);
    expect(resolution.bindings.map((binding) => binding.evidenceItemId)).toEqual(
      expect.arrayContaining(bound.factsUsed.flatMap((fact) => fact.evidenceItemIds ?? []))
    );
    expect(resolution.items.filter((item) => item.verifiedFactId).map((item) => item.verifiedFactId))
      .toEqual(['power-id', 'phase-id', 'fuel-id']);
  });

  it('keeps legacy, ambiguous and mismatched memory facts fail-closed', () => {
    const productName = 'A-iPower A6500';
    const exactFact = { verifiedFactId: 'first', productName, attribute: 'fuel_type', value: 'бензиновый',
      evidence: 'Тип двигателя бензиновый', sourceType: 'web', evidenceVerifiedExact: true };
    const draft = answer({ factKey: 'fuel', sourceEventIds: ['research'], productName, attribute: 'fuel_type',
      claimKind: 'confirmed_value', value: 'бензиновый' });

    const legacy = structuredClone(research);
    legacy.payload.facts = [{ ...exactFact, evidenceVerifiedExact: false }];
    (legacy.payload.answerGuidance as { coverage: unknown[] }).coverage = [];
    expect(bindUniqueMissingAnswerEvidenceItems({ answer: draft, toolResults: [legacy] }).factsUsed[0]?.evidenceItemIds)
      .toBeUndefined();

    const ambiguous = structuredClone(legacy);
    ambiguous.payload.facts = [{ ...exactFact }, { ...exactFact, verifiedFactId: 'second' }];
    expect(bindUniqueMissingAnswerEvidenceItems({ answer: draft, toolResults: [ambiguous] }).factsUsed[0]?.evidenceItemIds)
      .toBeUndefined();

    const freshCompeting = structuredClone(legacy);
    freshCompeting.payload.facts = [{ ...exactFact }, {
      ...exactFact, verifiedFactId: undefined, evidence: 'Свежий источник: тип двигателя бензиновый'
    }];
    expect(bindUniqueMissingAnswerEvidenceItems({ answer: draft, toolResults: [freshCompeting] })
      .factsUsed[0]?.evidenceItemIds).toBeUndefined();

    const wrongValue = structuredClone(legacy);
    wrongValue.payload.facts = [{ ...exactFact, value: 'дизельный', evidence: 'Тип двигателя дизельный' }];
    expect(bindUniqueMissingAnswerEvidenceItems({ answer: draft, toolResults: [wrongValue] }).factsUsed[0]?.evidenceItemIds)
      .toBeUndefined();

    const wrongProduct = structuredClone(legacy);
    wrongProduct.payload.facts = [{ ...exactFact, productName: 'A-iPower A7500' }];
    expect(bindUniqueMissingAnswerEvidenceItems({ answer: draft, toolResults: [wrongProduct] }).factsUsed[0]?.evidenceItemIds)
      .toBeUndefined();
  });

  it('requires bindings and exact scalar compatibility for nonnumeric tool facts', () => {
    const productName = 'A-iPower A6500';
    const fuelResearch: ToolResult = { requestId: 'fuel-research', tool: 'web.researchProductFacts', status: 'ok', warnings: [],
      payload: { facts: [{ verifiedFactId: 'fuel-id', productName, attribute: 'fuel_type', value: 'бензиновый',
        evidence: 'Тип двигателя бензиновый', sourceType: 'web', evidenceVerifiedExact: true }],
      answerGuidance: { coverage: [] } } };
    const missing = answer({ factKey: 'fuel', sourceEventIds: ['fuel-research'], productName, attribute: 'fuel_type',
      claimKind: 'confirmed_value', value: 'бензиновый' });
    expect(resolveAnswerEvidenceBindings({ answer: missing, toolResults: [fuelResearch] }).issues.map((issue) => issue.code))
      .toContain('fact_evidence_binding_missing');

    const wrong = answer({ factKey: 'fuel', sourceEventIds: ['fuel-research'],
      evidenceItemIds: ['fuel-research:verified_fact:fuel-id:fuel_type'], productName, attribute: 'fuel_type',
      claimKind: 'confirmed_value', value: 'дизельный' });
    expect(resolveAnswerEvidenceBindings({ answer: wrong, toolResults: [fuelResearch] }).issues.map((issue) => issue.code))
      .toContain('fact_value_not_in_bound_evidence');
  });
});
