import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyNeedState } from '../src/ai/needState.js';
import { AgentIntentContractSchema, type AgentIntentContract, type ToolRequest, type ToolResult } from '../src/ai/agentManagerContracts.js';
import { AgentManagerTurnBudget } from '../src/ai/agentManagerTurnBudget.js';
import { validateToolResultOutput } from '../src/ai/agentManagerToolRegistry.js';
import type { AgentManagerModel } from '../src/ai/agentManagerOrchestrator.js';
import type { ConversationSession, ConversationTurn, Message, Product, VerifiedProductFact, VerifiedProductFactInput } from '../src/shared/types.js';

const researchProductComparisonFacts = vi.hoisted(() => vi.fn());
const extractCatalogProductComparisonFacts = vi.hoisted(() => vi.fn());

vi.mock('../src/ai/productComparisonResearch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ai/productComparisonResearch.js')>();
  return {
    ...actual,
    researchProductComparisonFacts,
    extractCatalogProductComparisonFacts
  };
});

const { AgentManagerOrchestrator } = await import('../src/ai/agentManagerOrchestrator.js');

const sessionId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';
const userMessageId = '33333333-3333-4333-8333-333333333333';

function message(content: string, role: Message['role'] = 'user'): Message {
  return {
    id: role === 'user' ? userMessageId : 'assistant-id',
    sessionId,
    role,
    content,
    metadata: {},
    createdAt: new Date('2026-05-19T12:00:00.000Z').toISOString()
  };
}

function session(): ConversationSession {
    const now = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // fresh: inside 90d fact TTL
    return {
      id: sessionId,
    status: 'active',
    conversationNumber: 1,
    title: 'Dialog #1',
    needState: emptyNeedState(),
    createdAt: now,
    updatedAt: now,
    lastHeartbeatAt: now
  };
}

function turn(): ConversationTurn {
  const now = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // fresh: inside 90d fact TTL
  return {
    id: turnId,
    sessionId,
    userMessageId,
    assistantMessageId: null,
    status: 'received',
    requestHash: 'hash',
    createdAt: now,
    updatedAt: now
  };
}

function product(id: string, name: string, specs: Record<string, unknown>, description?: string): Product {
  return {
    id,
    name,
    brand: name.split(' ')[0],
    category: 'Generators',
    price: 1000,
    currency: 'RUB',
    sourceUrl: `https://example.test/${id}`,
    description,
    specs
  };
}

class FakeConversations {
  messages: Message[] = [message('Compare SUMEC and BISON generators by power and noise.')];
  turn: ConversationTurn = turn();
  ledgerEvents: unknown[] = [];
  toolArtifacts: unknown[] = [];
  answerContracts: unknown[] = [];
  traces: unknown[] = [];
  assistantSaves: unknown[] = [];
  async getSession() { return session(); }
  async listMessages() { return this.messages; }
  async getTurn() { return this.turn; }
  async updateTurn(input: Partial<ConversationTurn>) {
    this.turn = { ...this.turn, ...input } as ConversationTurn;
    return this.turn;
  }
  async upsertTurnCheckpoint(input: unknown) { return input; }
  async listDialogueLedgerEvents() { return this.ledgerEvents; }
  async upsertDialogueLedgerEvent(input: unknown) { this.ledgerEvents.push(input); return input; }
  async saveToolArtifact(input: unknown) { this.toolArtifacts.push(input); return input; }
  async saveAnswerContract(input: unknown) { this.answerContracts.push(input); return input; }
  async getFinalAnswerContract() { return null; }
  async addAgentTrace(input: unknown) { this.traces.push(input); return input; }
  async addAssistantMessageForTurn(input: { content: string; metadata?: Record<string, unknown> }) {
    this.assistantSaves.push(input);
    const saved = message(input.content, 'assistant');
    this.messages.push(saved);
    return saved;
  }
}

class FakeProducts {
  recordedIssues: unknown[] = [];
  verifiedFacts: VerifiedProductFact[] = [];
  savedVerifiedFacts: VerifiedProductFactInput[] = [];
  mirroredWebFacts: unknown[] = [];
  usedVerifiedFactIds: string[] = [];
  async searchProducts() {
    return [
      product('sumec', 'SUMEC FIRMAN 6 kW', { noiseDb: '74 dB', nominalPowerKw: 5.5 }),
      product('bison', 'BISON 6 kW', { nominalPowerKw: 5.5 })
    ];
  }
  async searchVerifiedProductFacts() {
    return this.verifiedFacts;
  }
  async markVerifiedProductFactsUsed(ids: string[]) {
    this.usedVerifiedFactIds.push(...ids);
    return ids.length;
  }
  async upsertVerifiedProductFact(input: VerifiedProductFactInput) {
    this.savedVerifiedFacts.push(input);
    const now = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // fresh: inside 90d fact TTL
    const saved: VerifiedProductFact = {
      id: `verified-${this.savedVerifiedFacts.length}`,
      productId: input.productId ?? null,
      productKey: input.productName.toLocaleLowerCase('ru-RU'),
      productName: input.productName,
      attribute: input.attribute,
      value: input.value,
      sourceType: input.sourceType,
      sourceUrl: input.sourceUrl ?? null,
      sourceTitle: input.sourceTitle ?? null,
      evidence: input.evidence ?? null,
      sourceTier: input.sourceTier ?? null,
      sourceAuthority: input.sourceAuthority ?? null,
      observedAt: input.observedAt ?? now,
      confidence: input.confidence,
      status: 'active',
      firstSeenAt: now,
      lastVerifiedAt: now,
      hitCount: 0,
      createdAt: now,
      updatedAt: now
    };
    this.verifiedFacts.push(saved);
    return saved;
  }
  async upsertVerifiedWebFact(input: unknown) {
    this.mirroredWebFacts.push(input);
    return input;
  }
  async recordDataQualityIssue(input: unknown) {
    this.recordedIssues.push(input);
    return input;
  }
}

function model(): AgentManagerModel {
  return {
    async proposeLedgerDelta() {
      return {
        rationale: 'comparison request',
        events: [{
          eventType: 'fact.confirmed',
          scope: 'dialogue',
          payload: { factKey: 'comparison.targets', value: ['SUMEC', 'BISON'] },
          evidence: 'Compare SUMEC and BISON',
          source: 'llm_state_delta',
          status: 'active'
        }]
      };
    },
    async planTurn() {
      return {
        userMessageSummary: 'buyer compares SUMEC and BISON',
        dialogueUnderstanding: 'needs model comparison with missing facts',
        nextStepRationale: 'get catalog products and research missing facts',
        requiresTools: true,
        toolRequests: [{
          id: 'catalog:test',
          tool: 'catalog.search',
          args: { query: 'SUMEC BISON generators', limit: 4 },
          rationale: 'bind comparison targets to catalog products',
          required: true
        }, {
          id: 'web:test',
          tool: 'web.researchProductFacts',
          args: { productNames: ['SUMEC FIRMAN 6 kW', 'BISON 6 kW'] },
          rationale: 'fill missing comparison facts and adjudicate conflicts',
          required: true
        }],
        productMentions: [{
          name: 'SUMEC FIRMAN 6 kW',
          role: 'comparison_subject',
          productClass: 'generator',
          evidence: 'SUMEC'
        }, {
          name: 'BISON 6 kW',
          role: 'comparison_subject',
          productClass: 'generator',
          evidence: 'BISON'
        }],
        mustNotAskQuestionIds: [],
        riskFlags: ['comparison']
      };
    },
    async composeAnswer() {
      return {
        answerText: 'SUMEC has checked noise in catalog; BISON noise must be treated as uncertain.',
        factsUsed: [],
        questionsAsked: [],
        toolResultIds: ['catalog:test', 'web:test'],
        leadAction: 'none',
        riskFlags: []
      };
    },
    async reviewCustomerLanguage() {
      return { processDisclosure: false, evidence: '', rationale: 'test answer contains no process disclosure' };
    }
  };
}

const allowedToolArgKeys: Record<ToolRequest['tool'], Set<string>> = {
  'catalog.search': new Set([
    'query', 'semanticQuery', 'productIntent', 'canonicalProductIntent', 'powerSource', 'phase',
    'limit', 'comparisonAttributes', 'reason', 'notes'
  ]),
  'catalog.getProductDetails': new Set([
    'query', 'semanticQuery', 'productIntent', 'canonicalProductIntent', 'powerSource', 'phase',
    'productIds', 'productNames', 'comparisonAttributes', 'limit', 'reason', 'notes'
  ]),
  'calculator.generatorLoad': new Set([
    'query', 'semanticQuery', 'productIntent', 'canonicalProductIntent', 'powerSource', 'phase',
    'loads', 'simultaneousRunning', 'simultaneousStarting', 'simultaneousStartingKinds', 'estimateBasis', 'reason', 'notes'
  ]),
  'web.researchProductFacts': new Set([
    'query', 'semanticQuery', 'productIntent', 'canonicalProductIntent', 'powerSource', 'phase',
    'productNames', 'comparisonAttributes', 'limit', 'reason', 'notes'
  ]),
  'lead.capture': new Set(['contact', 'reason', 'notes'])
};

function withStrictToolFixtures(
  implementation: AgentManagerModel,
  webRequirement?: NonNullable<AgentIntentContract['grounding']>['webRequirement']
): AgentManagerModel {
  const planTurn = implementation.planTurn;
  const strictPlanTurn = async (input: Parameters<AgentManagerModel['planTurn']>[0]) => {
    const intent = await planTurn(input);
    const canonicalProductClass = intent.selectionPolicy
      ? intent.selectionPolicy.canonicalProductClass
      : 'generator';
    const targetProductClass = intent.selectionPolicy?.targetProductClass ?? canonicalProductClass ?? 'generator';
    const selectionPolicy = intent.selectionPolicy ?? {
      targetProductClass,
      canonicalProductClass: canonicalProductClass ?? 'generator',
      selectionGoal: 'browse_catalog' as const,
      needAction: 'continue' as const,
      alternativePolicy: 'open_to_alternatives' as const,
      reusePreviousCards: false,
      maxCards: 4,
      powerSource: 'any' as const,
      phase: 'any' as const,
      requirements: [],
      rankingObjectives: [],
      rationale: 'Test fixture carries an explicit no-filter selection policy.'
    };
    const requirementIds = new Set(selectionPolicy.requirements.map((requirement) => requirement.id));
    const currentEvidenceForName = (name: string) => {
      const index = input.userMessage.toLocaleLowerCase('en-US').indexOf(name.toLocaleLowerCase('en-US'));
      return index >= 0 ? input.userMessage.slice(index, index + name.length) : null;
    };
    const productMentions = (intent.productMentions ?? []).map((mention) => {
      if (input.userMessage.includes(mention.evidence)) return mention;
      const evidence = currentEvidenceForName(mention.name);
      return evidence ? { ...mention, evidence } : mention;
    });
    const mentionedNames = new Set(productMentions.map((mention) => mention.name.toLocaleLowerCase('en-US')));
    for (const targetName of intent.toolRequests.flatMap((request) => request.args.productNames ?? [])) {
      const evidence = currentEvidenceForName(targetName);
      if (!evidence || mentionedNames.has(targetName.toLocaleLowerCase('en-US'))) continue;
      productMentions.push({
        name: targetName,
        role: 'target_product',
        productClass: targetProductClass,
        evidence
      });
      mentionedNames.add(targetName.toLocaleLowerCase('en-US'));
    }
    const requiredTools = [...new Set(intent.toolRequests
      .filter((request) => request.required)
      .map((request) => request.tool))];
    const hasCatalog = requiredTools.some((tool) => tool === 'catalog.search' || tool === 'catalog.getProductDetails');
    const hasWeb = requiredTools.includes('web.researchProductFacts');
    const hasNamedWebTarget = intent.toolRequests.some((request) =>
      request.tool === 'web.researchProductFacts' && (request.args.productNames?.length ?? 0) > 0
    );
    const grounding = intent.grounding ?? {
      taskType: hasCatalog || hasNamedWebTarget ? 'comparison' as const : 'technical_answer' as const,
      buyerRequestedWeb: false,
      catalogRequirement: hasCatalog ? 'required' as const : 'none' as const,
      responseMode: hasCatalog || hasNamedWebTarget ? 'compare' as const : 'answer' as const,
      sourcePolicy: hasWeb ? 'web_required' as const : hasCatalog ? 'catalog_required' as const : 'conversation_only' as const,
      webPurpose: hasWeb ? 'technical_specs' as const : 'none' as const,
      webRequirement: hasWeb ? 'independent_required' as const : 'none' as const,
      requiredToolKinds: requiredTools,
      technicalAttributes: [...new Set(intent.toolRequests.flatMap((request) => request.args.comparisonAttributes ?? []))],
      buyerQuestion: input.userMessage,
      rationale: 'Test fixture explicitly declares the grounding needed by its planned tools.'
    };
    return {
      ...intent,
      productMentions,
      selectionPolicy,
      grounding: webRequirement ? { ...grounding, webRequirement } : grounding,
      toolRequests: intent.toolRequests.map((request) => ({
        ...request,
        args: {
          ...Object.fromEntries(Object.entries(request.args).filter(([key]) =>
            allowedToolArgKeys[request.tool].has(key)
          )),
          ...(
            request.tool === 'catalog.search' ||
            request.tool === 'catalog.getProductDetails' ||
            request.tool === 'web.researchProductFacts'
              ? { canonicalProductIntent: request.args.canonicalProductIntent ?? canonicalProductClass }
              : {}
          )
        },
        coversRequirementIds: (request.coversRequirementIds ?? []).filter((requirementId) =>
          requirementIds.has(requirementId)
        )
      })) as ToolRequest[]
    } as AgentIntentContract;
  };
  return {
    ...implementation,
    planTurn: strictPlanTurn,
    async decideTurn(input): Promise<import('../src/ai/agentManagerContracts.js').AgentSemanticDecision> {
      if (implementation.decideTurn) return implementation.decideTurn(input);
      const ledgerDelta = await implementation.proposeLedgerDelta(input);
      const intent = await strictPlanTurn({ ...input, ledgerState: input.ledgerState! });
      return { ledgerDelta, intent } as import('../src/ai/agentManagerContracts.js').AgentSemanticDecision;
    }
  };
}

describe('AgentManager comparison research flow', () => {
  beforeEach(() => {
    researchProductComparisonFacts.mockReset();
    extractCatalogProductComparisonFacts.mockReset();
    extractCatalogProductComparisonFacts.mockResolvedValue(null);
  });

  it('passes the revised continuation search goal and prior failed source observations to nested research', async () => {
    const sourceDiagnostic = { url: 'https://manufacturer.example/manual.pdf', reason: 'timeout', elapsedMs: 10000 };
    researchProductComparisonFacts.mockResolvedValue({
      usedWebSearch: true, searchDisposition: 'completed', sourcesExhausted: false, facts: [], conflicts: [],
      sourceDiagnostics: [sourceDiagnostic], warnings: ['source_evidence_fetch_failed'],
      summaryForAnswer: 'Exact source is unreadable.',
      answerGuidance: { directAnswer: '', completeness: 'partially_answered', coverage: [] }
    });
    const initialGoal = { query: 'SUMEC BISON manufacturer noise specifications', semanticQuery: 'Check the exact noise rating',
      reason: 'Missing model specification', notes: 'Use a manufacturer source first.' };
    const revisedGoal = { query: 'SUMEC BISON manual copies noise table', semanticQuery: 'Find a readable copy of the exact manual',
      reason: 'The first source could not be read', notes: 'Look for another reliable source of the same model specification.' };
    const implementation = model();
    let observationCalls = 0;
    const conversations = new FakeConversations();
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never,
      { async createLead() { return null; } } as never, withStrictToolFixtures({
        ...implementation,
        async planTurn(input) {
          const intent = await implementation.planTurn(input);
          return { ...intent, toolRequests: intent.toolRequests.map(request => request.tool === 'web.researchProductFacts'
            ? { ...request, args: { ...request.args, ...initialGoal, comparisonAttributes: ['noise'] } } : request) };
        },
        async assessObservations(input) {
          observationCalls += 1;
          return { action: observationCalls === 1 ? 'continue' : 'answer', rationale: 'Use actual source outcomes.',
            missingFacts: ['Verified noise rating'], candidateProductIds: input.products.map(item => item.id),
            toolRequests: observationCalls === 1 ? [{ id: 'web:refined', tool: 'web.researchProductFacts', required: true,
              rationale: 'Read another source for the same exact targets', coversRequirementIds: [],
              args: { ...revisedGoal, productNames: ['SUMEC FIRMAN 6 kW', 'BISON 6 kW'], comparisonAttributes: ['noise'] }
            }] : [] };
        },
        async composeAnswer() {
          return { answerText: 'Точный уровень шума этих моделей пока не подтверждён.', factsUsed: [], questionsAsked: [],
            toolResultIds: ['web:test', 'web:refined'], selectedProductIds: [], leadAction: 'none', riskFlags: [] };
        }
      }));
    await orchestrator.generateAnswer({ sessionId, turnId, userMessage: conversations.messages[0]!.content });
    expect(researchProductComparisonFacts).toHaveBeenCalledTimes(2);
    expect(researchProductComparisonFacts.mock.calls[0]![0].documentReadContext).toEqual({});
    expect(researchProductComparisonFacts.mock.calls[1]![0].documentReadContext)
      .toBe(researchProductComparisonFacts.mock.calls[0]![0].documentReadContext);
    expect(researchProductComparisonFacts.mock.calls[0]![0]).toMatchObject({ researchGoal: initialGoal, previousResearch: [] });
    expect(researchProductComparisonFacts.mock.calls[1]![0]).toMatchObject({ researchGoal: revisedGoal,
      previousResearch: [{ requestId: 'web:test', status: 'ok', payload: {
        targetProductNames: ['SUMEC FIRMAN 6 kW', 'BISON 6 kW'], sourceDiagnostics: [sourceDiagnostic]
      } }] });
  });

  it('passes grounded product evidence to semantic review and repairs a scoped factual contradiction', async () => {
    researchProductComparisonFacts.mockResolvedValue({
      usedWebSearch: true, searchDisposition: 'completed', sourcesExhausted: false,
      facts: [{ productName: 'BISON 6 kW', attribute: 'manual starter', value: 'present', sourceType: 'web', confidence: 'high', evidence: 'A recoil starter is fitted.', sourceUrl: 'https://manufacturer.example/bison' }],
      conflicts: [], warnings: [], summaryForAnswer: 'BISON has a manual starter.',
      answerGuidance: { directAnswer: 'BISON has a manual starter.', completeness: 'answered', coverage: [] }
    });
    const reviewCustomerLanguage = vi.fn<NonNullable<AgentManagerModel['reviewCustomerLanguage']>>()
      .mockResolvedValueOnce({
        processDisclosure: false, evidence: '', rationale: 'The answer contradicts the scoped product fact.',
        factualIssues: [{ claim: 'BISON has no manual starter.', sourceResultId: 'web:test', reason: 'BISON manual starter is confirmed present by the source.' }]
      })
      .mockResolvedValue({ processDisclosure: false, evidence: '', rationale: 'The repaired answer matches the evidence.', factualIssues: [] });
    const composeAnswer = vi.fn<AgentManagerModel['composeAnswer']>()
      .mockImplementation(async (input) => ({
        answerText: input.reviewIssuesFeedback?.length ? 'BISON has a manual starter.' : 'BISON has no manual starter.',
        factsUsed: [], questionsAsked: [], toolResultIds: ['web:test'], leadAction: 'none', riskFlags: []
      }));
    const conversations = new FakeConversations();
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, {} as never,
      withStrictToolFixtures({ ...model(), composeAnswer, reviewCustomerLanguage }));

    const result = await orchestrator.generateAnswer({ sessionId, turnId, userMessage: conversations.messages[0]!.content });

    expect(result.answer).toBe('BISON has a manual starter.');
    expect(reviewCustomerLanguage).toHaveBeenCalledTimes(2);
    expect(reviewCustomerLanguage.mock.calls[0]![0]).toMatchObject({
      products: expect.arrayContaining([expect.objectContaining({ id: 'bison' })]),
      toolResults: expect.arrayContaining([expect.objectContaining({ requestId: 'web:test', payload: expect.objectContaining({ facts: expect.arrayContaining([expect.objectContaining({ productName: 'BISON 6 kW', value: 'present' })]) }) })])
    });
    expect(composeAnswer.mock.calls[1]![0].reviewIssuesFeedback?.join(' ')).toContain('BISON manual starter is confirmed present');
    expect(conversations.assistantSaves).toHaveLength(1);
  });

  it('rejects semantic factual findings that invent a quote or source identity', async () => {
    researchProductComparisonFacts.mockResolvedValue({
      usedWebSearch: true, facts: [], conflicts: [], warnings: [], summaryForAnswer: '',
      answerGuidance: { directAnswer: '', completeness: 'partially_answered', coverage: [] }
    });
    const orchestrator = new AgentManagerOrchestrator(new FakeConversations() as never, new FakeProducts() as never, {} as never,
      withStrictToolFixtures({
        ...model(),
        async reviewCustomerLanguage() {
          return { processDisclosure: false, evidence: '', rationale: '', factualIssues: [
            { claim: 'This quote is absent from the answer.', sourceResultId: 'invented-tool', reason: 'Unbound finding.' }
          ] };
        }
      }));
    await expect(orchestrator.generateAnswer({ sessionId, turnId, userMessage: 'Compare SUMEC and BISON generators by power and noise.' }))
      .rejects.toThrow('customer_output_semantic_review_unavailable');
  });

  describe('required external verification with complete local evidence', () => {
    const targetName = 'FIRMAN RD3910E';
    const attribute = 'nominal power';
    const catalogFact = {
      productName: targetName,
      attribute,
      value: '2.8 kW',
      sourceType: 'catalog' as const,
      confidence: 'high' as const,
      evidence: 'Rated output: 2.8 kW',
      sourceUrl: 'https://example.test/rd3910e',
      sourceTitle: targetName
    };
    const completeCatalog = {
      usedWebSearch: false,
      searchDisposition: 'not_needed',
      sourcesExhausted: false,
      sourceAttempts: [{ tier: 'catalog', outcome: 'confirmed' }],
      facts: [catalogFact],
      conflicts: [],
      answerGuidance: {
        directAnswer: 'Rated output is 2.8 kW.',
        completeness: 'answered',
        coverage: [{ ...catalogFact, status: 'confirmed' }]
      },
      summaryForAnswer: 'The catalog confirms rated output.',
      warnings: []
    };
    const completedWeb = {
      ...completeCatalog,
      usedWebSearch: true,
      searchDisposition: 'completed',
      sourceAttempts: [{ tier: 'official_page', outcome: 'confirmed' }],
      facts: [{ ...catalogFact, sourceType: 'web', sourceUrl: 'https://manufacturer.example/rd3910e' }]
    };

    async function executeResearch(webRequirement: 'buyer_requested' | 'independent_required' | 'conditional_on_catalog_gap', localSource: 'catalog' | 'memory', verifyWebOnlyReplay = false) {
      const products = new FakeProducts();
      vi.spyOn(products, 'searchProducts').mockResolvedValue([product('rd3910e', targetName, { nominalPowerKw: 2.8 })]);
      if (localSource === 'catalog') extractCatalogProductComparisonFacts.mockResolvedValue(completeCatalog);
      else {
        const now = new Date().toISOString();
        products.verifiedFacts = [{
          ...catalogFact,
          id: 'verified-rated-output',
          productId: 'rd3910e',
          productKey: 'firman rd3910e',
          sourceType: 'web',
          sourceUrl: 'https://manufacturer.example/rd3910e',
          status: 'active',
          firstSeenAt: now,
          lastVerifiedAt: now,
          hitCount: 0,
          createdAt: now,
          updatedAt: now
        }];
      }
      const intent = AgentIntentContractSchema.parse({
        userMessageSummary: `Verify ${targetName} rated output.`,
        dialogueUnderstanding: 'Check the named catalog candidate before recommending it.',
        nextStepRationale: 'Use the declared source policy.',
        requiresTools: true,
        toolRequests: [{
          id: 'catalog:source-policy',
          tool: 'catalog.search',
          args: { query: targetName, canonicalProductIntent: 'generator', productIntent: 'generator' },
          rationale: 'Read the current catalog candidate.',
          required: true
        }, {
          id: 'web:source-policy',
          tool: 'web.researchProductFacts',
          args: { productNames: [targetName], comparisonAttributes: [attribute], canonicalProductIntent: 'generator', productIntent: 'generator' },
          rationale: 'Apply the requested source requirement.',
          required: true
        }],
        productMentions: [{ name: targetName, role: 'target_product', productClass: 'generator', evidence: targetName }],
        selectionPolicy: {
          targetProductClass: 'generator', canonicalProductClass: 'generator', selectionGoal: 'preliminary_fit',
          needAction: 'continue', alternativePolicy: 'exact_only', reusePreviousCards: false,
          maxCards: 1, powerSource: 'any', phase: 'any', requirements: [], rankingObjectives: [], rationale: 'Named candidate.'
        },
        grounding: {
          taskType: 'product_selection', sourcePolicy: 'web_required', webPurpose: 'technical_specs', webRequirement,
          requiredToolKinds: ['catalog.search', 'web.researchProductFacts'], technicalAttributes: [attribute],
          buyerQuestion: `Verify ${targetName} rated output.`, rationale: 'Source policy is explicit.'
        },
        mustNotAskQuestionIds: [], riskFlags: []
      });
      const orchestrator = new AgentManagerOrchestrator(new FakeConversations() as never, products as never, {} as never, withStrictToolFixtures(model()));
      const executor = orchestrator as unknown as {
        executeTools(input: Record<string, unknown>): Promise<{ toolResults: ToolResult[]; products: Product[] }>;
      };
      if (verifyWebOnlyReplay) intent.toolRequests = intent.toolRequests.filter(request => request.tool === 'web.researchProductFacts');
      const result = await executor.executeTools({
        session: session(), turnId, executionOwner: 'source-policy-test', userMessage: `Verify ${targetName} rated output.`,
        history: [], intent, toolRequests: intent.toolRequests, needState: emptyNeedState(),
        pendingLeadCaptureDraft: null, persistedToolResults: new Map(), budget: new AgentManagerTurnBudget()
      });
      if (verifyWebOnlyReplay) {
        expect(result.products.map(item => item.id)).toEqual(['rd3910e']);
        const searches = vi.spyOn(products, 'searchProducts');
        const searchCount = searches.mock.calls.length;
        const webCount = researchProductComparisonFacts.mock.calls.length;
        const replay = await executor.executeTools({
          session: session(), turnId, executionOwner: 'source-policy-replay', userMessage: `Verify ${targetName} rated output.`,
          history: [], intent: structuredClone(intent), toolRequests: structuredClone(intent.toolRequests), needState: emptyNeedState(),
          pendingLeadCaptureDraft: null, persistedToolResults: new Map(structuredClone(result.toolResults).map(item => [item.requestId, item])), budget: new AgentManagerTurnBudget()
        });
        expect(replay.products).toEqual(result.products);
        expect(searches.mock.calls.length).toBe(searchCount);
        expect(researchProductComparisonFacts.mock.calls.length).toBe(webCount);
      }
      return result.toolResults.find((item) => item.requestId === 'web:source-policy');
    }

    it('replays product identity and facts discovered inside a web-only turn without another lookup', async () => {
      researchProductComparisonFacts.mockResolvedValue(completedWeb);
      await executeResearch('independent_required', 'catalog', true);
    });

    it.each(['buyer_requested', 'independent_required'] as const)('performs %s web verification even when the catalog covers every requested attribute', async (webRequirement) => {
      researchProductComparisonFacts.mockResolvedValue(completedWeb);
      const result = await executeResearch(webRequirement, 'catalog');
      expect(researchProductComparisonFacts).toHaveBeenCalledTimes(1);
      expect(researchProductComparisonFacts).toHaveBeenCalledWith(expect.objectContaining({
        allowCatalogOnlyAnswer: false, targetProductNames: [targetName], comparisonAttributes: [attribute]
      }));
      expect(result?.payload).toMatchObject({ usedWebSearch: true, searchDisposition: 'completed' });
    });

    it('performs independent web verification even when verified memory covers every requested attribute', async () => {
      researchProductComparisonFacts.mockResolvedValue(completedWeb);
      const result = await executeResearch('independent_required', 'memory');
      expect(researchProductComparisonFacts).toHaveBeenCalledTimes(1);
      expect(researchProductComparisonFacts).toHaveBeenCalledWith(expect.objectContaining({
        allowCatalogOnlyAnswer: false, targetProductNames: [targetName], comparisonAttributes: [attribute]
      }));
      expect(result?.payload).toMatchObject({ usedWebSearch: true, searchDisposition: 'completed' });
    });

    it.each(['catalog', 'memory'] as const)('reuses complete %s evidence for a genuinely conditional preliminary check', async (localSource) => {
      const result = await executeResearch('conditional_on_catalog_gap', localSource);
      expect(researchProductComparisonFacts).not.toHaveBeenCalled();
      expect(result?.status).toBe('ok');
      expect(result?.payload).toMatchObject({ usedWebSearch: false });
    });

    it('does not claim successful verification when the required external attempt fails', async () => {
      researchProductComparisonFacts.mockRejectedValue(new Error('external lookup unavailable'));
      const result = await executeResearch('buyer_requested', 'catalog');
      expect(researchProductComparisonFacts).toHaveBeenCalled();
      expect(result?.status).toBe('error');
      expect(result?.payload).not.toMatchObject({ usedWebSearch: true, searchDisposition: 'completed' });
    });
  });

  it('rejects a premature handoff instead of replacing it when web execution fails', async () => {
    researchProductComparisonFacts.mockRejectedValue(
      new Error('product_comparison_research did not return a JSON object')
    );

    const clausesSeen: Array<{ code?: string; sourceRequestId?: string; instruction?: string }> = [];
    const groundingModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks why THD matters for boiler electronics',
          dialogueUnderstanding: 'technical fact explanation needs web verification when exact catalog data is missing',
          nextStepRationale: 'try web research, then answer only at the grounded level if the research fails',
          requiresTools: true,
          toolRequests: [{
            id: 'web:thd',
            tool: 'web.researchProductFacts',
            args: {
              query: 'THD inverter generator boiler electronics',
              semanticQuery: 'practical THD importance for boiler and sensitive electronics',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: [],
              comparisonAttributes: ['THD'],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'verify technical facts',
              notes: 'technical explanation only'
            },
            rationale: 'the buyer explicitly asked to check facts',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: ['web_required']
        };
      },
      async composeAnswer(input) {
        clausesSeen.push(...(input.requiredResponseClauses ?? []));
        return {
          answerText: 'THD важен для чувствительной электроники, но точное значение по выбранной модели подтвердить не удалось. Могу передать этот вопрос техническому специалисту и сообщить результат. Оставьте номер и скажите, как удобнее связаться — написать или позвонить?',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['web:thd'],
          leadAction: 'offer_form',
          riskFlags: ['web_research_unavailable']
        };
      }
    };

    const conversations = new FakeConversations();
    conversations.messages = [message('Explain why THD matters for an inverter generator and check facts if catalog data is missing.')];
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      { async createLead() { return null; } } as never,
      withStrictToolFixtures(groundingModel)
    );

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Explain why THD matters for an inverter generator and check facts if catalog data is missing.'
    })).rejects.toThrow('premature_handoff_before_web_exhausted');

    expect(clausesSeen).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'web_research_incomplete_grounding',
        sourceRequestId: 'web:thd'
      })
    ]));
    expect(clausesSeen[0]?.instruction).toContain('available sources are not exhausted');
    expect(clausesSeen[0]?.instruction).toContain('Requested facts: ["THD"]');
    expect(clausesSeen[0]?.instruction).toContain('do not mention tools, web/external search, retries, timeout');
    expect(clausesSeen[0]?.instruction).not.toContain('say plainly that the external check did not complete');
    expect(clausesSeen[0]?.instruction).not.toContain('leadAction="offer_form"');
    expect(conversations.assistantSaves).toEqual([]);
    expect(conversations.answerContracts).toContainEqual(expect.objectContaining({ status: 'rejected' }));
    expect(researchProductComparisonFacts).toHaveBeenCalledTimes(2);
    const firstAttempt = researchProductComparisonFacts.mock.calls[0]?.[0];
    const secondAttempt = researchProductComparisonFacts.mock.calls[1]?.[0];
    expect(firstAttempt?.signal).not.toBe(secondAttempt?.signal);
    expect(firstAttempt?.deadlineAtMs).toEqual(expect.any(Number));
    expect(secondAttempt?.deadlineAtMs).toEqual(expect.any(Number));
    expect(secondAttempt!.deadlineAtMs!).toBeGreaterThanOrEqual(firstAttempt!.deadlineAtMs!);
  });

  it('blocks a technical handoff after a successful but still partial web result', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: true,
      searchDisposition: 'completed',
      sourcesExhausted: false,
      facts: [],
      conflicts: [],
      answerGuidance: {
        directAnswer: 'По доступному источнику подтверждена только часть сведений.',
        completeness: 'partial',
        coverage: [{
          attribute: 'совместимость с Hatz 1D42S',
          status: 'not_confirmed',
          value: '',
          evidence: 'Точная совместимость пока не подтверждена.'
        }]
      },
      summaryForAnswer: 'Поиск выполнен частично; решающий факт остаётся неподтверждённым.',
      warnings: ['missing_fact_deep_search_required']
    });

    const partialModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks for exact engine compatibility',
          dialogueUnderstanding: 'compatibility is still only partially researched',
          nextStepRationale: 'continue autonomous research before any handoff',
          requiresTools: true,
          toolRequests: [{
            id: 'web:partial-compatibility',
            tool: 'web.researchProductFacts',
            args: {
              query: 'filter kit Hatz 1D42S compatibility',
              semanticQuery: 'exact compatibility with Hatz 1D42S',
              productIntent: 'plateAccessory',
              canonicalProductIntent: 'plateAccessory',
              productNames: ['Filter kit KA-00042730'],
              comparisonAttributes: ['совместимость с Hatz 1D42S'],
              limit: 4
            },
            rationale: 'the decisive compatibility fact is still missing',
            required: true,
            coversRequirementIds: ['req-partial-compatibility']
          }],
          productMentions: [{
            name: 'Filter kit KA-00042730',
            role: 'target_product',
            productClass: 'plateAccessory',
            evidence: 'комплект'
          }],
          mustNotAskQuestionIds: [],
          riskFlags: ['web_required']
        };
      },
      async composeAnswer() {
        return {
          answerText: 'Совместимость пока подтверждена частично. Могу передать вопрос техническому специалисту. Оставьте номер — написать вам или позвонить?',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['web:partial-compatibility'],
          leadAction: 'offer_form',
          riskFlags: ['compatibility_unconfirmed']
        };
      }
    };
    const conversations = new FakeConversations();
    conversations.messages = [message('Подойдёт ли комплект к Hatz 1D42S?')];
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      { async createLead() { return null; } } as never,
      withStrictToolFixtures(partialModel)
    );

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: conversations.messages[0]!.content
    })).rejects.toThrow('premature_handoff_before_web_exhausted');
    expect(conversations.assistantSaves).toEqual([]);
  });

  it('rejects a technical handoff when research stopped before source exhaustion', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: true,
      searchDisposition: 'skipped_budget',
      sourcesExhausted: false,
      sourceAttempts: [
        { tier: 'catalog', outcome: 'confirmed' },
        { tier: 'official_page', outcome: 'confirmed', query: 'CHAMPION PC5332F transport wheels' }
      ],
      facts: [{
        productName: 'CHAMPION PC5332F',
        attribute: 'штатные транспортировочные колёса',
        value: 'Опция; приобретаются отдельно транспортировочные колеса.',
        sourceType: 'web',
        confidence: 'medium',
        evidence: 'Транспортировочные колеса — опция; приобретаются отдельно',
        sourceUrl: 'https://example.test/champion-pc5332f',
        sourceTitle: 'CHAMPION PC5332F'
      }],
      conflicts: [],
      answerGuidance: {
        directAnswer: '',
        completeness: 'partially_answered',
        coverage: [{
          attribute: 'штатные транспортировочные колёса',
          status: 'not_confirmed',
          value: '',
          evidence: 'Штатная комплектация не подтверждена.'
        }]
      },
      summaryForAnswer: '',
      warnings: ['exact_target_external_retry_skipped_insufficient_budget']
    });

    const incompleteModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'Есть ли у CHAMPION PC5332F штатные транспортировочные колёса?',
          dialogueUnderstanding: 'Нужен точный факт по комплектации выбранной виброплиты.',
          nextStepRationale: 'Проверить внешние источники до любого предложения специалиста.',
          requiresTools: true,
          toolRequests: [{
            id: 'web:champion-wheels',
            tool: 'web.researchProductFacts',
            args: {
              query: 'CHAMPION PC5332F транспортировочные колёса комплектация',
              semanticQuery: 'штатные транспортировочные колёса CHAMPION PC5332F',
              productIntent: 'plate',
              productNames: ['CHAMPION PC5332F'],
              comparisonAttributes: ['штатные транспортировочные колёса'],
              limit: 4
            },
            rationale: 'Факт влияет на перевозку одним человеком без трапа.',
            required: true,
            coversRequirementIds: ['req-champion-wheels']
          }],
          mustNotAskQuestionIds: [],
          riskFlags: ['web_required']
        };
      },
      async composeAnswer() {
        return {
          answerText: 'В описании колёса указаны как отдельная опция, но штатная комплектация не подтверждена. Можем отдельно уточнить комплектацию вашей поставки. Оставьте номер — написать вам или позвонить?',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['web:champion-wheels'],
          leadAction: 'offer_form',
          riskFlags: ['wheel_kit_unconfirmed']
        };
      }
    };
    const conversations = new FakeConversations();
    conversations.messages = [message('У CHAMPION PC5332F свои транспортировочные колёса есть?')];
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      { async createLead() { return null; } } as never,
      withStrictToolFixtures(incompleteModel)
    );

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: conversations.messages[0]!.content
    })).rejects.toThrow('premature_handoff_before_web_exhausted');
    expect(conversations.assistantSaves).toEqual([]);
  });

  it('treats a completed research call with no confirmed answer as exhausted', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: true,
      searchDisposition: 'completed',
      sourcesExhausted: true,
      sourceAttempts: [
        { tier: 'catalog', outcome: 'not_found' },
        { tier: 'official_page', outcome: 'not_found', query: 'Hatz 1D42S filter kit official product page' },
        { tier: 'official_manual', outcome: 'not_found', query: 'Hatz 1D42S official manual filter compatibility PDF' },
        { tier: 'reliable_secondary', outcome: 'not_found', query: 'Hatz 1D42S filter kit reliable distributor compatibility' }
      ],
      facts: [],
      conflicts: [],
      answerGuidance: {
        directAnswer: 'Совместимость с Hatz 1D42S по доступным источникам не подтверждена.',
        completeness: 'not_answered',
        coverage: [{
          attribute: 'совместимость комплекта с Hatz 1D42S',
          status: 'not_confirmed',
          value: '',
          evidence: 'В доступных официальных материалах точной привязки комплекта нет.'
        }]
      },
      summaryForAnswer: 'Точный факт не подтверждён.',
      warnings: ['missing_fact_deep_search_still_unresolved']
    });

    const clausesSeen: Array<{ code?: string; instruction?: string }> = [];
    const exhaustedModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks whether a filter kit fits Hatz 1D42S',
          dialogueUnderstanding: 'compatibility must be verified before recommending the kit',
          nextStepRationale: 'search official sources before any human handoff',
          requiresTools: true,
          toolRequests: [{
            id: 'web:compatibility',
            tool: 'web.researchProductFacts',
            args: {
              query: 'filter kit compatibility Hatz 1D42S',
              semanticQuery: 'exact filter kit compatibility with Hatz 1D42S engine',
              productIntent: 'plateAccessory',
              canonicalProductIntent: 'plateAccessory',
              productNames: ['Filter kit KA-00042730'],
              comparisonAttributes: ['совместимость комплекта с Hatz 1D42S'],
              limit: 4
            },
            rationale: 'compatibility is decision-critical',
            required: true,
            coversRequirementIds: ['req-engine-compatibility']
          }],
          productMentions: [{
            name: 'Filter kit KA-00042730',
            role: 'target_product',
            productClass: 'plateAccessory',
            evidence: 'комплект фильтров'
          }],
          mustNotAskQuestionIds: [],
          riskFlags: ['web_required']
        };
      },
      async composeAnswer(input) {
        clausesSeen.push(...(input.requiredResponseClauses ?? []));
        return {
          answerText: 'По каталожной цене комплект выгоднее, но совместимость именно с Hatz 1D42S подтвердить не удалось. Могу уточнить этот конкретный факт у технического специалиста. Оставьте номер и скажите, как удобнее получить результат — сообщением или звонком?',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['web:compatibility'],
          leadAction: 'offer_form',
          riskFlags: ['compatibility_unconfirmed']
        };
      }
    };
    const conversations = new FakeConversations();
    conversations.messages = [message('Подойдёт ли комплект фильтров к двигателю Hatz 1D42S?')];
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      { async createLead() { return null; } } as never,
      withStrictToolFixtures(exhaustedModel)
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: conversations.messages[0]!.content
    });
    const metadata = payload.metadata as {
      toolResults?: Array<{
        status?: string;
        payload?: { researchOutcome?: string; sourcesExhausted?: boolean; unconfirmedFacts?: unknown[] };
      }>;
    };

    expect(metadata.toolResults?.[0]).toMatchObject({
      status: 'ok',
      payload: {
        researchOutcome: 'exhausted',
        sourcesExhausted: true,
        unconfirmedFacts: [expect.objectContaining({
          requirementIds: [],
          attribute: 'совместимость комплекта с Hatz 1D42S',
          status: 'not_confirmed'
        })]
      }
    });
    expect(clausesSeen).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'web_research_exhausted_grounding',
        instruction: expect.stringContaining('совместимость комплекта с Hatz 1D42S')
      })
    ]));
    expect(clausesSeen.map((clause) => clause.code)).not.toContain('answer_checked_research_guidance');
    expect(payload.answer).toContain('совместимость именно с Hatz 1D42S');
    expect(payload.answer).toContain('сообщением или звонком');
    expect(payload.leadRequested).toBe(true);
  });

  it('rejects a failed web result used as a fact instead of rewriting the answer', async () => {
    researchProductComparisonFacts.mockRejectedValue(
      new Error('product_comparison_research did not return a JSON object')
    );

    const thdModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks why THD matters for inverter generator boiler electronics',
          dialogueUnderstanding: 'technical fact explanation needs web verification when exact catalog data is missing',
          nextStepRationale: 'try web research and keep any answer truthful if the research fails',
          requiresTools: true,
          toolRequests: [{
            id: 'web:thd',
            tool: 'web.researchProductFacts',
            args: {
              query: 'THD inverter generator boiler electronics',
              semanticQuery: 'practical THD importance for boiler and sensitive electronics',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: [],
              comparisonAttributes: ['THD', 'harmonic distortion', 'boiler electronics'],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'verify technical facts',
              notes: 'technical explanation only'
            },
            rationale: 'the buyer explicitly asked to check facts',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: ['web_required']
        };
      },
      async composeAnswer() {
        return {
          answerText: 'The web check confirmed a THD fact for boiler electronics.',
          factsUsed: [{
            factKey: 'thd.general',
            sourceEventIds: ['web:thd'],
            value: 'checked'
          }],
          questionsAsked: [],
          toolResultIds: ['web:thd'],
          leadAction: 'none',
          riskFlags: ['web_research_failed']
        };
      }
    };

    const conversations = new FakeConversations();
    conversations.messages = [message('Explain why THD matters for an inverter generator and check facts if catalog data is missing.')];
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      { async createLead() { return null; } } as never,
      withStrictToolFixtures(thdModel)
    );

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Explain why THD matters for an inverter generator and check facts if catalog data is missing.'
    })).rejects.toThrow('failed_tool_result_used_as_fact_source');
    expect(conversations.assistantSaves).toEqual([]);
  });

  it('rejects web-required grounding when the planner omitted the web tool', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: true,
      facts: [{
        productName: 'general inverter generator',
        attribute: 'THD',
        value: 'lower THD means a cleaner waveform for sensitive electronics',
        sourceType: 'web',
        confidence: 'medium',
        evidence: 'engineering reference for harmonic distortion'
      }],
      conflicts: [],
      answerGuidance: {
        directAnswer: 'Lower THD reduces waveform distortion for boiler boards and sensitive electronics.',
        completeness: 'answered',
        coverage: [{
          attribute: 'THD practical effect',
          status: 'confirmed',
          value: 'lower distortion is better for sensitive electronics',
          evidence: 'web grounding'
        }]
      },
      summaryForAnswer: 'THD is a waveform distortion metric; lower values are preferable for sensitive electronics.',
      warnings: []
    });

    const toolResultIdsSeen: string[] = [];
    const groundingRepairModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks why THD matters and asks to check facts if catalog data is missing',
          dialogueUnderstanding: 'technical answer needs external grounding, but the planner omitted the tool request',
          nextStepRationale: 'answer after web grounding',
          requiresTools: false,
          toolRequests: [],
          grounding: {
            taskType: 'technical_answer',
            sourcePolicy: 'web_required',
            webPurpose: 'technical_specs',
            requiredToolKinds: ['web.researchProductFacts'],
            technicalAttributes: ['THD', 'waveform distortion', 'boiler electronics'],
            rationale: 'buyer requested technical fact verification'
          },
          productMentions: [{
            name: 'inverter generator',
            role: 'target_product',
            productClass: 'generator',
            evidence: 'buyer asks about THD of an inverter generator'
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        toolResultIdsSeen.push(...input.toolResults.map((result) => result.requestId));
        return {
          answerText: 'THD показывает, насколько форма напряжения отличается от чистой синусоиды. Для котла и электроники ниже THD обычно лучше: меньше риск сбоев платы, перегрева блоков питания и помех.',
          factsUsed: [{
            factKey: 'thd.practical_effect',
            sourceEventIds: [input.toolResults[0]?.requestId ?? 'auto:web-grounding'],
            value: 'lower THD is safer for sensitive electronics'
          }],
          questionsAsked: [],
          toolResultIds: input.toolResults.map((result) => result.requestId),
          leadAction: 'none',
          riskFlags: []
        };
      }
    };

    const conversations = new FakeConversations();
    conversations.messages = [message('Explain why THD matters for an inverter generator and check facts if catalog data is missing.')];
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      { async createLead() { return null; } } as never,
      withStrictToolFixtures(groundingRepairModel)
    );

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Explain why THD matters for an inverter generator and check facts if catalog data is missing.'
    })).rejects.toThrow('required_tool_request_missing:web.researchProductFacts');
    expect(researchProductComparisonFacts).not.toHaveBeenCalled();
    expect(toolResultIdsSeen).toEqual([]);
    expect(conversations.assistantSaves).toEqual([]);
  });

  it('rejects exact-model claims that cite failed web research as fact evidence', async () => {
    researchProductComparisonFacts.mockRejectedValue(
      new Error('product_comparison_research did not return a JSON object')
    );

    class ExactCatalogProducts extends FakeProducts {
      async searchProducts() {
        return [
          product('g7000is', 'SUNREKA G7000iS generator 6 kW', { starter: 'с ручным стартером' })
        ];
      }
    }

    const badGroundingModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks whether SUNREKA G7000iS starts by cord or button',
          dialogueUnderstanding: 'exact named-model technical fact needs web verification',
          nextStepRationale: 'verify exact start control',
          requiresTools: true,
          toolRequests: [{
            id: 'web:g7000is',
            tool: 'web.researchProductFacts',
            args: {
              query: 'SUNREKA G7000iS starting method button recoil electric start',
              semanticQuery: 'Verify whether SUNREKA G7000iS starts by recoil cord or by button/electric starter.',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: ['SUNREKA G7000iS'],
              comparisonAttributes: ['starting method', 'button start', 'electric start', 'recoil start'],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'exact model start method',
              notes: 'answer only the direct technical question'
            },
            rationale: 'exact start-control fact must be grounded',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'По данным из карточки, SUNREKA G7000iS запускается ручным стартером, то есть шнурком. Кнопочного запуска для этой модели в данных не вижу.',
          factsUsed: [{
            factKey: 'g7000is.start_method',
            sourceEventIds: ['web:g7000is'],
            value: 'manual starter only'
          }],
          questionsAsked: [],
          toolResultIds: ['web:g7000is'],
          leadAction: 'none',
          riskFlags: ['web_research_failed_for_named_model']
        };
      }
    };

    const conversations = new FakeConversations();
    conversations.messages = [message('SUNREKA G7000iS нужно заводить шнурком или он запускается кнопкой?')];
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new ExactCatalogProducts() as never,
      { async createLead() { return null; } } as never,
      withStrictToolFixtures(badGroundingModel)
    );

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'SUNREKA G7000iS нужно заводить шнурком или он запускается кнопкой?'
    })).rejects.toThrow('failed_tool_result_used_as_fact_source');
    expect(conversations.assistantSaves).toEqual([]);
  });

  it('preserves a useful catalog-grounded comparison when a failed web result is referenced only as status', async () => {
    researchProductComparisonFacts.mockRejectedValue(
      new Error('product_comparison_research did not return a JSON object')
    );

    const catalogGroundedModel: AgentManagerModel = {
      ...model(),
      async composeAnswer() {
        return {
          answerText: 'Обе модели дают одинаковую номинальную мощность. SUMEC дешевле, поэтому без требования к инверторному выходу я бы не переплачивал; BISON имеет смысл выбирать именно ради инверторного типа.',
          factsUsed: [{
            factKey: 'catalog.comparison',
            sourceEventIds: ['catalog:test'],
            value: 'same nominal power; different price and generator type'
          }],
          questionsAsked: [],
          toolResultIds: ['catalog:test', 'web:test'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };
    const conversations = new FakeConversations();
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      { async createLead() { return null; } } as never,
      withStrictToolFixtures(catalogGroundedModel)
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Compare SUMEC and BISON generators by power and noise.'
    });

    expect(payload.answer).toContain('я бы не переплачивал');
    expect(payload.answer).toContain('инверторного типа');
    expect(payload.answer).not.toContain('внешняя проверка не завершилась');
    expect(payload.metadata?.answerContract).toMatchObject({
      toolResultIds: ['catalog:test', 'web:test']
    });
    expect(payload.metadata?.preSendValidation).toEqual({ verdict: 'pass', issues: [] });
  });

  it('answers exact external facts for a named model absent from catalog and exposes nearby catalog models', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: true,
      facts: [{
        productName: 'FIRMAN RD8910E',
        attribute: 'start method',
        value: 'electric start with ignition key; manual recoil starter also available',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'external specification lists electric starter, ignition keys, and recoil starter',
        sourceUrl: 'https://example.test/firman-rd8910e',
        sourceTitle: 'FIRMAN RD8910E specification'
      }],
      conflicts: [],
      summaryForAnswer: 'RD8910E starts with a key and also has manual recoil start.',
      warnings: []
    });

    class MissingCatalogProducts extends FakeProducts {
      async searchProducts() {
        return [
          product('rd7910e', 'FIRMAN RD7910E generator 5 kW', { starter: 'manual / electric' }),
          product('rd10910e', 'FIRMAN RD10910E generator 7.2 kW', { starter: 'manual / electric' }),
          product('other', 'BISON BS7500 generator 6 kW', { starter: 'electric' })
        ];
      }
    }

    const exactFactModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks how FIRMAN RD8910E starts',
          dialogueUnderstanding: 'single exact technical fact for a named model',
          nextStepRationale: 'look up the exact model fact and do not infer from nearby catalog models',
          requiresTools: true,
          toolRequests: [{
            id: 'web:exact-model',
            tool: 'web.researchProductFacts',
            args: {
              query: 'FIRMAN RD8910E start method',
              semanticQuery: 'FIRMAN RD8910E key start or push button start',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: ['FIRMAN RD8910E'],
              comparisonAttributes: ['start method'],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'exact model technical fact',
              notes: 'answer direct question first'
            },
            rationale: 'exact model fact is missing from catalog context',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        const result = input.toolResults[0]?.payload as {
          catalogPresence?: Array<{ status?: string }>;
          nearbyCatalogProducts?: Array<{ name?: string }>;
        };
        expect(result.catalogPresence?.[0]?.status).toBe('unknown');
        expect(result.nearbyCatalogProducts?.map((item) => item.name)).toEqual([
          'FIRMAN RD7910E generator 5 kW',
          'FIRMAN RD10910E generator 7.2 kW'
        ]);
        return {
          answerText: 'RD8910E starts with a key, not a push button. It also has manual recoil start. The exact catalog match was not confirmed in this check; nearby FIRMAN catalog models include RD7910E and RD10910E.',
          factsUsed: [{
            factKey: 'firman_rd8910e.start_method',
            sourceEventIds: ['web:exact-model'],
            value: 'key electric start plus manual recoil'
          }],
          questionsAsked: [],
          toolResultIds: ['web:exact-model'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };
    const conversations = new FakeConversations();
    conversations.messages = [message('Firman RD8910E - заводится с ключа или с кнопки?')];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new MissingCatalogProducts() as never, {} as never, withStrictToolFixtures(exactFactModel));

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Firman RD8910E - заводится с ключа или с кнопки?'
    });

    expect(researchProductComparisonFacts).toHaveBeenCalledWith(expect.objectContaining({
      targetProductNames: ['FIRMAN RD8910E'],
      comparisonAttributes: ['start method'],
      products: expect.arrayContaining([
        expect.objectContaining({ name: 'FIRMAN RD7910E generator 5 kW' }),
        expect.objectContaining({ name: 'FIRMAN RD10910E generator 7.2 kW' })
      ])
    }));
    const metadata = payload.metadata as { toolResults?: Array<{ payload?: { catalogPresence?: unknown[]; nearbyCatalogProducts?: unknown[] }; warnings?: string[] }> };
    expect(metadata.toolResults?.[0]?.payload?.catalogPresence).toEqual([{
      productName: 'FIRMAN RD8910E',
      status: 'unknown',
      exactProductIds: []
    }]);
    expect(metadata.toolResults?.[0]?.warnings).not.toContain('exact_catalog_product_absent:FIRMAN RD8910E');
    expect(payload.answer).toContain('starts with a key');
    expect(payload.answer).toContain('not confirmed in this check');
    expect(payload.answer).toContain('RD7910E');
    const lowerAnswer = payload.answer.toLocaleLowerCase('en-US');
    for (const forbidden of ['availability', 'delivery', 'discount', 'callback', 'lead', 'price']) {
      expect(lowerAnswer).not.toContain(forbidden);
    }
    expect(payload.productCards).toEqual([]);
  });

  it('does not auto-promote context load devices into exact catalog targets', async () => {
    researchProductComparisonFacts.mockClear();

    const baxiContextModel: AgentManagerModel = {
      ...model(),
      async proposeLedgerDelta() {
        return {
          rationale: 'generator load request with context device',
          events: [{
            eventType: 'fact.observed',
            scope: 'dialogue',
            payload: { factKey: 'load.boiler_model', value: 'Baxi 24' },
            evidence: 'котел Baxi 24 is a load device for generator sizing',
            source: 'llm_state_delta',
            status: 'active'
          }, {
            eventType: 'fact.confirmed',
            scope: 'dialogue',
            payload: {
              factKey: 'generator_load_scenario',
              value: {
                loads: [{
                  kind: 'boiler',
                  name: 'Baxi 24 boiler',
                  count: 1,
                  runningKw: 0.15,
                  startingKw: 0.2,
                  source: 'estimated_average',
                  runningSource: 'estimated_average',
                  startingSource: 'estimated_average',
                  operationMode: 'continuous',
                  coRunningGroup: 'household',
                  evidence: 'газовый котел Baxi 24',
                  basisKind: 'specific_type_or_function',
                  basisSignals: ['consumer_type_known', 'consumer_function_known', 'voltage_or_phase_known']
                }, {
                  kind: 'pump',
                  name: 'deep well pump',
                  count: 1,
                  runningKw: 1.1,
                  startingKw: 3.3,
                  source: 'explicit_user',
                  runningSource: 'explicit_user',
                  startingSource: 'explicit_user',
                  operationMode: 'continuous',
                  coRunningGroup: 'household',
                  evidence: 'насос 1,1 кВт',
                  basisKind: 'exact_power',
                  basisSignals: ['explicit_power', 'voltage_or_phase_known']
                }],
                simultaneousRunning: true,
                simultaneousStarting: true
              },
              role: 'hard_requirement',
              confidence: 1
            },
            evidence: 'The Baxi boiler and 1.1 kW pump define the executable load scenario.',
            source: 'llm_state_delta',
            status: 'active'
          }]
        };
      },
      async planTurn() {
        return {
          userMessageSummary: 'buyer sizes a generator for Baxi 24 boiler and pump',
          dialogueUnderstanding: 'Baxi 24 is a powered load, not the product being bought',
          nextStepRationale: 'calculate generator load and do not check Baxi catalog presence',
          requiresTools: true,
          toolRequests: [{
            id: 'calc:baxi-load',
            tool: 'calculator.generatorLoad',
            args: {
              query: 'generator for Baxi 24 boiler and 1.1 kW pump',
              semanticQuery: 'size generator for boiler, deep well pump, refrigerator and lights',
              productIntent: 'generator',
              limit: null,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [{
                kind: 'boiler',
                name: 'Baxi 24 boiler',
                count: 1,
                runningKw: 0.15,
                startingKw: 0.2,
                source: 'estimated_average',
                runningSource: 'estimated_average',
                startingSource: 'estimated_average',
                operationMode: 'continuous',
                coRunningGroup: 'household',
                evidence: 'газовый котел Baxi 24',
                basisKind: 'specific_type_or_function',
                basisSignals: ['consumer_type_known', 'consumer_function_known', 'voltage_or_phase_known']
              }, {
                kind: 'pump',
                name: 'deep well pump',
                count: 1,
                runningKw: 1.1,
                startingKw: 3.3,
                source: 'explicit_user',
                runningSource: 'explicit_user',
                startingSource: 'explicit_user',
                operationMode: 'continuous',
                coRunningGroup: 'household',
                evidence: 'насос 1,1 кВт',
                basisKind: 'exact_power',
                basisSignals: ['explicit_power', 'voltage_or_phase_known']
              }],
              simultaneousRunning: true,
              simultaneousStarting: true,
              simultaneousStartingKinds: ['pump'],
              estimateBasis: 'bounded_assumption',
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'calculate generator size',
              notes: 'Baxi 24 is only a load device'
            },
            rationale: 'load sizing for generator',
            required: true,
            coversRequirementIds: ['baxi-load-scenario']
          }],
          productMentions: [{
            name: 'Baxi 24',
            role: 'context_load_device',
            productClass: 'boiler',
            evidence: 'котел Baxi 24 is one of the loads connected to the generator'
          }],
          selectionPolicy: {
            targetProductClass: 'generator',
            canonicalProductClass: 'generator',
            selectionGoal: 'preliminary_fit',
            needAction: 'continue',
            alternativePolicy: 'same_class_only',
            reusePreviousCards: false,
            maxCards: 4,
            powerSource: 'fuel',
            phase: 'single_phase',
            requirements: [{
              id: 'baxi-load-scenario',
              kind: 'generator_load_scenario',
              value: true,
              unit: null,
              relation: 'must_have',
              role: 'hard_constraint',
              strictness: 'strict',
              evidence: 'Baxi boiler and pump load scenario',
              verification: {
                mode: 'typed_tool',
                toolRequestId: 'calc:baxi-load',
                tool: 'calculator.generatorLoad',
                verifier: 'generator_load_profile',
                bindAs: 'nominal_power_min_kw'
              }
            }],
            rationale: 'calculate the declared load without treating Baxi as a catalog target'
          },
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        expect(input.intent.toolRequests.map((request) => request.tool)).toEqual(['calculator.generatorLoad']);
        expect(input.toolResults.map((result) => result.tool)).toEqual(['calculator.generatorLoad']);
        return {
          answerText: 'Для такой нагрузки я бы смотрел генератор примерно от 5 кВт. Baxi 24 тут просто нагрузка, по каталогу котел проверять не нужно.',
          factsUsed: [{
            factKey: 'calc.requiredNominalKw',
            sourceEventIds: ['calc:baxi-load'],
            value: 4
          }],
          questionsAsked: [],
          toolResultIds: ['calc:baxi-load'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };

    const conversations = new FakeConversations();
    conversations.messages = [message('Нужен генератор для котла Baxi 24, насоса 1,1 кВт, холодильника и света.')];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, {} as never, withStrictToolFixtures(baxiContextModel));

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Нужен генератор для котла Baxi 24, насоса 1,1 кВт, холодильника и света.'
    });

    expect(researchProductComparisonFacts).not.toHaveBeenCalled();
    const metadata = payload.metadata as { toolResults?: Array<{ warnings?: string[] }> };
    expect(metadata.toolResults?.flatMap((result) => result.warnings ?? [])).not.toContain('exact_catalog_product_absent:Baxi 24');
  });

  it('suppresses context load devices accidentally placed into exact web target names', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: false,
      facts: [],
      conflicts: [],
      summaryForAnswer: 'No exact target research was needed for the context boiler.',
      warnings: []
    });

    const baxiSanitizingModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks generator sizing for Baxi 24',
          dialogueUnderstanding: 'Baxi 24 is a context load device, but a bad tool request included it as productNames',
          nextStepRationale: 'runtime should suppress Baxi 24 as an exact target',
          requiresTools: true,
          toolRequests: [{
            id: 'web:baxi-context',
            tool: 'web.researchProductFacts',
            args: {
              query: 'Baxi 24 electrical consumption for generator sizing',
              semanticQuery: 'boiler consumption context for generator sizing, not catalog availability',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: ['Baxi 24'],
              comparisonAttributes: ['electrical consumption'],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'verify load context',
              notes: 'Baxi 24 is not the product target'
            },
            rationale: 'badly scoped context research request',
            required: true
          }],
          productMentions: [{
            name: 'Baxi 24',
            role: 'context_load_device',
            productClass: 'boiler',
            evidence: 'Baxi 24 is the boiler powered by the generator'
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        const result = input.toolResults[0]?.payload as {
          targetProductNames?: string[];
          catalogPresence?: unknown[];
          suppressedTargetProductNames?: string[];
        };
        expect(result.targetProductNames).toEqual([]);
        expect(result.catalogPresence).toEqual([]);
        expect(result.suppressedTargetProductNames).toEqual(['Baxi 24']);
        return {
          answerText: 'Baxi 24 учитываю как нагрузку для генератора, а не как товар для проверки в каталоге.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['web:baxi-context'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };

    const conversations = new FakeConversations();
    conversations.messages = [message('Подберите генератор для Baxi 24 и насоса 1,1 кВт.')];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, {} as never, withStrictToolFixtures(baxiSanitizingModel));

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Подберите генератор для Baxi 24 и насоса 1,1 кВт.'
    });

    expect(researchProductComparisonFacts).toHaveBeenCalledWith(expect.objectContaining({
      targetProductNames: [],
      comparisonAttributes: ['electrical consumption']
    }));
    const metadata = payload.metadata as { toolResults?: Array<{ warnings?: string[] }> };
    const warnings = metadata.toolResults?.flatMap((result) => result.warnings ?? []) ?? [];
    expect(warnings).toContain('exact_target_suppressed_by_product_role:Baxi 24');
    expect(warnings).not.toContain('exact_catalog_product_absent:Baxi 24');
  });

  it('does not mark a suffix model as exact and passes practical start-control guidance to the answer', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: true,
      facts: [{
        productName: 'FIRMAN RD2910E',
        attribute: 'start control',
        value: 'electric starter operated by the engine/ignition switch in START; push-button start is not confirmed',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'exact-target manual says to move the engine switch to START and hold it briefly',
        sourceUrl: 'https://example.test/firman-rd2910e-manual',
        sourceTitle: 'FIRMAN RD2910E manual'
      }],
      conflicts: [],
      answerGuidance: {
        directAnswer: 'RD2910E starts by electric starter through the engine/ignition switch turned to START; it is not evidenced as a push-button start.',
        completeness: 'answered',
        coverage: [{
          attribute: 'start control',
          status: 'confirmed',
          value: 'engine/ignition switch to START',
          evidence: 'exact-target manual start procedure',
          sourceUrl: 'https://example.test/firman-rd2910e-manual',
          sourceTitle: 'FIRMAN RD2910E manual'
        }]
      },
      summaryForAnswer: 'RD2910E uses an electric starter through a START switch; push-button start is not confirmed.',
      warnings: []
    });

    class SuffixCatalogProducts extends FakeProducts {
      async searchProducts() {
        return [
          product('rd2910e1', 'FIRMAN RD2910E1 generator 2 kW', { starter: 'manual / electric' }),
          product('rd3910e', 'FIRMAN RD3910E generator 2.5 kW', { starter: 'manual / electric' }),
          product('rd10910e', 'FIRMAN RD10910E generator 7.2 kW', { starter: 'manual / electric' })
        ];
      }
    }

    const exactFactModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks how FIRMAN RD2910E starts',
          dialogueUnderstanding: 'single exact technical fact for a named model',
          nextStepRationale: 'look up exact model start-control mechanism',
          requiresTools: true,
          toolRequests: [{
            id: 'web:start-control',
            tool: 'web.researchProductFacts',
            args: {
              query: 'FIRMAN RD2910E key or button start',
              semanticQuery: 'FIRMAN RD2910E ignition key or push-button start control',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: ['FIRMAN RD2910E'],
              comparisonAttributes: ['key start', 'push-button start', 'start control'],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'exact model start-control fact',
              notes: 'answer key/button mechanism directly'
            },
            rationale: 'exact model fact must not be inferred from suffix model RD2910E1',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        const result = input.toolResults[0]?.payload as {
          catalogPresence?: Array<{ status?: string; exactProductIds?: string[] }>;
          nearbyCatalogProducts?: Array<{ name?: string }>;
          answerGuidance?: { directAnswer?: string };
        };
        expect(result.catalogPresence?.[0]).toEqual({
          productName: 'FIRMAN RD2910E',
          status: 'unknown',
          exactProductIds: []
        });
        expect(result.nearbyCatalogProducts?.map((item) => item.name)).toEqual(expect.arrayContaining([
          'FIRMAN RD2910E1 generator 2 kW',
          'FIRMAN RD3910E generator 2.5 kW'
        ]));
        expect(input.requiredResponseClauses?.map((clause) => clause.code)).toEqual(expect.arrayContaining([
          'answer_checked_research_guidance',
          'catalog_presence_unverified'
        ]));
        expect(input.requiredResponseClauses?.map((clause) => clause.instruction).join('\n')).toContain('engine/ignition switch turned to START');
        return {
          answerText: 'RD2910E запускается электростартером через поворот выключателя/замка в START; кнопочный запуск по источнику не подтвержден. В нашем каталоге точной RD2910E нет, рядом есть RD2910E1 и RD3910E.',
          factsUsed: [{
            factKey: 'firman_rd2910e.start_control',
            sourceEventIds: ['web:start-control'],
            value: 'engine/ignition switch to START'
          }],
          questionsAsked: [],
          toolResultIds: ['web:start-control'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };
    const conversations = new FakeConversations();
    conversations.messages = [message('Firman RD2910E - заводится с ключа или с кнопки?')];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new SuffixCatalogProducts() as never, {} as never, withStrictToolFixtures(exactFactModel));

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Firman RD2910E - заводится с ключа или с кнопки?'
    })).rejects.toThrow('research_guidance_uncertainty_mismatch');

    expect(researchProductComparisonFacts).toHaveBeenCalledWith(expect.objectContaining({
      targetProductNames: ['FIRMAN RD2910E'],
      comparisonAttributes: ['key start', 'push-button start', 'start control'],
      products: expect.arrayContaining([
        expect.objectContaining({ name: 'FIRMAN RD2910E1 generator 2 kW' })
      ])
    }));
    expect(conversations.assistantSaves).toEqual([]);
  });

  it('blocks an exact-model answer that diverges from checked ambiguous guidance', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: true,
      facts: [{
        productName: 'FIRMAN RD3910E',
        attribute: 'starting method',
        value: 'electrostarter; key/button control not confirmed',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'exact-target specification confirms electrostarter only',
        sourceUrl: 'https://example.test/firman-rd3910e',
        sourceTitle: 'FIRMAN RD3910E specification'
      }],
      conflicts: [],
      answerGuidance: {
        directAnswer: 'По точной спецификации у FIRMAN RD3910E электростартер; ключ/замок и кнопка в источниках не подтверждены.',
        completeness: 'partially_answered',
        coverage: [{
          attribute: 'ignition control',
          status: 'ambiguous',
          value: 'key/button control not confirmed',
          evidence: 'exact-target sources only say electrostarter',
          sourceUrl: 'https://example.test/firman-rd3910e',
          sourceTitle: 'FIRMAN RD3910E specification'
        }]
      },
      summaryForAnswer: 'RD3910E has electrostarter; key/button control is not confirmed.',
      warnings: []
    });

    class PresentCatalogProducts extends FakeProducts {
      async searchProducts() {
        return [
          product('rd3910e', 'FIRMAN RD3910E generator 2.5 kW', { starter: 'manual / electric' })
        ];
      }
    }

    const overconfidentModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks whether FIRMAN RD3910E is key or button start',
          dialogueUnderstanding: 'single exact technical fact for a named model',
          nextStepRationale: 'look up exact model start-control mechanism',
          requiresTools: true,
          toolRequests: [{
            id: 'web:rd3910e',
            tool: 'web.researchProductFacts',
            args: {
              query: 'FIRMAN RD3910E key or button start',
              semanticQuery: 'FIRMAN RD3910E ignition key or push-button start control',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: ['FIRMAN RD3910E'],
              comparisonAttributes: ['key start', 'push-button start', 'start control'],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'exact model start-control fact',
              notes: 'answer key/button mechanism directly'
            },
            rationale: 'exact model fact must be grounded',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: ['answer_policy_catalog_presence_relevant']
        };
      },
      async composeAnswer() {
        return {
          answerText: 'RD3910E есть и запускается ключом/замком зажигания, а не кнопкой.',
          factsUsed: [{
            factKey: 'firman_rd3910e.start_control',
            sourceEventIds: ['web:rd3910e'],
            value: 'key start'
          }],
          questionsAsked: [],
          toolResultIds: ['web:rd3910e'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };
    const conversations = new FakeConversations();
    conversations.messages = [message('Firman RD3910E есть? Он с ключа или с кнопки?')];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new PresentCatalogProducts() as never, {} as never, withStrictToolFixtures({ ...overconfidentModel, reviewCustomerLanguage: async () => ({ processDisclosure: false, evidence: '', rationale: 'Semantic fact review fixture.', factualIssues: [{ claim: 'RD3910E есть и запускается ключом/замком зажигания, а не кнопкой.', sourceResultId: 'web:rd3910e', reason: 'The exact start control remains unconfirmed; the answer asserts a key mechanism.' }] }) }));

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Firman RD3910E есть? Он с ключа или с кнопки?'
    })).rejects.toThrow('research_guidance_uncertainty_mismatch');
    expect(conversations.assistantSaves).toEqual([]);
  });

  it('blocks an exact-model answer that omits checked catalog description guidance', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: false,
      facts: [{
        productName: 'FIRMAN RD3910E',
        attribute: 'start control',
        value: 'запуск поворотом ключа электростартера',
        sourceType: 'catalog',
        confidence: 'high',
        evidence: 'catalog.description: запуск двигателя осуществляется поворотом ключа электростартера',
        sourceUrl: 'https://example.test/rd3910e',
        sourceTitle: 'FIRMAN RD3910E catalog card'
      }],
      conflicts: [],
      answerGuidance: {
        directAnswer: 'RD3910E запускается с ключа электростартера, плюс есть ручной запуск. Кнопочный запуск не подтвержден.',
        completeness: 'answered',
        coverage: [{
          attribute: 'key start',
          status: 'confirmed',
          value: 'поворот ключа электростартера',
          evidence: 'catalog.description',
          sourceUrl: 'https://example.test/rd3910e',
          sourceTitle: 'FIRMAN RD3910E catalog card'
        }]
      },
      summaryForAnswer: 'Catalog description confirms key electric start and manual start.',
      warnings: ['catalog_fact_extraction_used', 'exact_catalog_description_extracted']
    });

    class PresentCatalogProducts extends FakeProducts {
      async searchProducts() {
        return [
          product(
            'rd3910e',
            'FIRMAN RD3910E generator 2.5 kW',
            { starter: 'manual / electric' },
            'Запуск двигателя осуществляется поворотом ключа электростартера. Также предусмотрен ручной стартер.'
          )
        ];
      }
    }

    const omittingModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks whether FIRMAN RD3910E is key or button start',
          dialogueUnderstanding: 'single exact technical fact for a named catalog model',
          nextStepRationale: 'verify exact model start-control mechanism',
          requiresTools: true,
          toolRequests: [{
            id: 'web:rd3910e-catalog',
            tool: 'web.researchProductFacts',
            args: {
              query: 'FIRMAN RD3910E key or button start',
              semanticQuery: 'FIRMAN RD3910E ignition key or push-button start control',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: ['FIRMAN RD3910E'],
              comparisonAttributes: ['key start', 'push-button start', 'start control'],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'exact model start-control fact',
              notes: 'answer key/button mechanism directly'
            },
            rationale: 'exact model fact must be grounded in catalog description when present',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        expect(input.requiredResponseClauses?.map((clause) => clause.code)).toContain('answer_checked_research_guidance');
        return {
          answerText: 'RD3910E есть в каталоге, стартер ручной/электро. По ключу или кнопке точной строки нет.',
          factsUsed: [({
            factKey: 'firman_rd3910e.start_control',
            sourceEventIds: ['web:rd3910e-catalog'],
            value: 'manual / electric'
          })],
          questionsAsked: [],
          toolResultIds: ['web:rd3910e-catalog'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };
    const conversations = new FakeConversations();
    conversations.messages = [message('Firman RD3910E - заводится с ключа или с кнопки?')];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new PresentCatalogProducts() as never, {} as never, withStrictToolFixtures({ ...omittingModel, reviewCustomerLanguage: async () => ({ processDisclosure: false, evidence: '', rationale: 'Semantic fact review fixture.', factualIssues: [{ claim: 'По ключу или кнопке точной строки нет.', sourceResultId: 'web:rd3910e-catalog', reason: 'The source explicitly confirms key control, so claiming there is no data contradicts it.' }] }) }));

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Firman RD3910E - заводится с ключа или с кнопки?'
    })).rejects.toThrow('research_guidance_uncertainty_mismatch');
    expect(conversations.assistantSaves).toEqual([]);
  });

  it('blocks a primary answer that drops confirmed starter guidance', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: false,
      facts: [{
        productName: 'FIRMAN RD3910E',
        attribute: 'start method',
        value: 'электростартер, запуск поворотом ключа',
        sourceType: 'catalog',
        confidence: 'high',
        evidence: 'Запуск генератора осуществляется простым поворотом ключа электростартера.',
        sourceUrl: 'https://example.test/rd3910e',
        sourceTitle: 'FIRMAN RD3910E catalog card'
      }],
      conflicts: [],
      answerGuidance: {
        directAnswer: 'RD3910E заводится с ключа, через электростартер. Кнопочного запуска тут не вижу.',
        completeness: 'answered',
        coverage: [
          {
            attribute: 'start method',
            status: 'confirmed',
            value: 'электростартер, запуск поворотом ключа',
            evidence: 'Запуск генератора осуществляется простым поворотом ключа электростартера.',
            sourceUrl: 'https://example.test/rd3910e',
            sourceTitle: 'FIRMAN RD3910E catalog card'
          },
          {
            attribute: 'electric start',
            status: 'confirmed',
            value: 'есть',
            evidence: 'стартер: ручной стартер / электростартер',
            sourceUrl: 'https://example.test/rd3910e',
            sourceTitle: 'FIRMAN RD3910E catalog card'
          },
          {
            attribute: 'starter button',
            status: 'not_found',
            value: '',
            evidence: 'В specs и description нет упоминания кнопки запуска.'
          }
        ]
      },
      summaryForAnswer: 'Catalog card confirms key electric start and manual starter; button start is not found.',
      warnings: ['catalog_fact_extraction_used', 'exact_catalog_description_extracted']
    });

    class PresentCatalogProducts extends FakeProducts {
      async searchProducts() {
        return [
          product(
            'rd3910e',
            'FIRMAN RD3910E generator 2.5 kW',
            { starter: 'manual / electric' },
            'Запуск двигателя осуществляется поворотом ключа электростартера. Также предусмотрен ручной стартер.'
          )
        ];
      }
    }

    const modelThatDropsCoverageFacts: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks whether FIRMAN RD3910E is key or button start',
          dialogueUnderstanding: 'single exact technical fact for a named catalog model',
          nextStepRationale: 'verify exact model start-control mechanism',
          requiresTools: true,
          toolRequests: [{
            id: 'web:rd3910e-catalog',
            tool: 'web.researchProductFacts',
            args: {
              query: 'FIRMAN RD3910E key or button start',
              semanticQuery: 'FIRMAN RD3910E ignition key or push-button start control',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: ['FIRMAN RD3910E'],
              comparisonAttributes: ['start method', 'electric start', 'key start', 'starter button'],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'exact model start-control fact',
              notes: 'answer key/button mechanism directly'
            },
            rationale: 'exact model fact must be grounded in catalog description when present',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'RD3910E есть в каталоге, стартер ручной/электро. По ключу или кнопке точной строки нет.',
          factsUsed: [{
            factKey: 'firman_rd3910e.start_control',
            sourceEventIds: ['web:rd3910e-catalog'],
            value: 'manual / electric'
          }],
          questionsAsked: [],
          toolResultIds: ['web:rd3910e-catalog'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };
    const conversations = new FakeConversations();
    conversations.messages = [message('Firman RD3910E - заводится с ключа или с кнопки?')];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new PresentCatalogProducts() as never, {} as never, withStrictToolFixtures({ ...modelThatDropsCoverageFacts, reviewCustomerLanguage: async () => ({ processDisclosure: false, evidence: '', rationale: 'Semantic fact review fixture.', factualIssues: [{ claim: 'По ключу или кнопке точной строки нет.', sourceResultId: 'web:rd3910e-catalog', reason: 'The source confirms key start; the response falsely reports that the data are absent.' }] }) }));

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Firman RD3910E - заводится с ключа или с кнопки?'
    })).rejects.toThrow('research_guidance_uncertainty_mismatch');
    expect(conversations.assistantSaves).toEqual([]);
  });

  it('blocks an unsupported key-start answer when checked guidance remains uncertain', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: true,
      facts: [{
        productName: 'FIRMAN RD4910E',
        attribute: 'starting method',
        value: 'manual starter / electric starter',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'exact source confirms manual and electric starter',
        sourceUrl: 'https://example.test/firman-rd4910e',
        sourceTitle: 'FIRMAN RD4910E specification'
      }],
      conflicts: [],
      answerGuidance: {
        directAnswer: 'Электростартер есть, ручной запуск тоже есть. А вот чем включается электростартер — ключом, кнопкой или переключателем — источники не подтвердили.',
        completeness: 'partially_answered',
        coverage: [
          {
            attribute: 'electric start',
            status: 'confirmed',
            value: 'electric starter',
            evidence: 'exact source confirms electric starter',
            sourceUrl: 'https://example.test/firman-rd4910e',
            sourceTitle: 'FIRMAN RD4910E specification'
          },
          {
            attribute: 'manual starter',
            status: 'confirmed',
            value: 'manual starter',
            evidence: 'exact source confirms manual starter',
            sourceUrl: 'https://example.test/firman-rd4910e',
            sourceTitle: 'FIRMAN RD4910E specification'
          },
          {
            attribute: 'key start',
            status: 'not_confirmed',
            value: '',
            evidence: 'exact sources do not prove key control',
            sourceUrl: 'https://example.test/firman-rd4910e',
            sourceTitle: 'FIRMAN RD4910E specification'
          },
          {
            attribute: 'button start',
            status: 'not_confirmed',
            value: '',
            evidence: 'exact sources do not prove button control',
            sourceUrl: 'https://example.test/firman-rd4910e',
            sourceTitle: 'FIRMAN RD4910E specification'
          }
        ]
      },
      summaryForAnswer: 'Starter type is confirmed; control is not confirmed.',
      warnings: ['source_evidence_validation_failed:key_start']
    });

    const badModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks if FIRMAN RD4910E starts with a key or button',
          dialogueUnderstanding: 'single exact technical fact for a named model',
          nextStepRationale: 'look up exact model start control',
          requiresTools: true,
          toolRequests: [{
            id: 'web:rd4910e',
            tool: 'web.researchProductFacts',
            args: {
              query: 'FIRMAN RD4910E key or button start',
              semanticQuery: 'FIRMAN RD4910E key button electric starter',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: ['FIRMAN RD4910E'],
              comparisonAttributes: ['key start', 'push-button start', 'start control'],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'exact model start-control fact',
              notes: 'answer key/button mechanism directly'
            },
            rationale: 'exact model fact must be grounded',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'RD4910E запускается с ключа.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['web:rd4910e'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };
    const conversations = new FakeConversations();
    conversations.messages = [message('Firman RD4910E заводится с ключа или с кнопки?')];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, {} as never, withStrictToolFixtures({ ...badModel, reviewCustomerLanguage: async () => ({ processDisclosure: false, evidence: '', rationale: 'Semantic fact review fixture.', factualIssues: [{ claim: 'RD4910E запускается с ключа.', sourceResultId: 'web:rd4910e', reason: 'The exact starter control is unconfirmed and cannot be stated as key start.' }] }) }));

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Firman RD4910E заводится с ключа или с кнопки?'
    })).rejects.toThrow('research_guidance_uncertainty_mismatch');
    expect(conversations.assistantSaves).toEqual([]);
  });

  it('does not append uncertainty for a start-control label that later coverage confirms', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: true,
      facts: [{
        productName: 'SUNREKA G7000iS',
        attribute: 'button start',
        value: 'есть',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'exact source says start by START button',
        sourceUrl: 'https://example.test/sunreka-g7000is',
        sourceTitle: 'SUNREKA G7000iS specification'
      }],
      conflicts: [{
        productName: 'SUNREKA G7000iS',
        attribute: 'starting method',
        catalogValue: 'ручной стартер',
        webValues: ['ручной стартер + электростартер, кнопка START'],
        resolution: 'catalog is incomplete; exact external source confirms button start and manual start'
      }],
      answerGuidance: {
        directAnswer: 'Кнопочный запуск подтвержден. Ручной запуск тоже есть.',
        completeness: 'answered',
        coverage: [
          {
            attribute: 'button start',
            status: 'not_found',
            value: '',
            evidence: 'catalog specs do not mention a button',
            sourceUrl: 'https://example.test/catalog-g7000is',
            sourceTitle: 'Catalog card'
          },
          {
            attribute: 'button start',
            status: 'confirmed',
            value: 'есть',
            evidence: 'exact external source confirms START button',
            sourceUrl: 'https://example.test/sunreka-g7000is',
            sourceTitle: 'SUNREKA G7000iS specification'
          },
          {
            attribute: 'recoil start',
            status: 'confirmed',
            value: 'есть',
            evidence: 'exact external source confirms manual starter',
            sourceUrl: 'https://example.test/sunreka-g7000is',
            sourceTitle: 'SUNREKA G7000iS specification'
          }
        ]
      },
      summaryForAnswer: 'Button start and manual start are confirmed; catalog had only manual starter.',
      warnings: ['source_conflict_adjudicated']
    });

    class PresentCatalogProducts extends FakeProducts {
      async searchProducts() {
        return [
          product('g7000is', 'SUNREKA G7000iS generator 6 kW', { starter: 'с ручным стартером' })
        ];
      }
    }

    const badModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks whether SUNREKA G7000iS starts by cord or button',
          dialogueUnderstanding: 'single exact technical fact for a named catalog model',
          nextStepRationale: 'verify exact start-control mechanism',
          requiresTools: true,
          toolRequests: [{
            id: 'web:g7000is',
            tool: 'web.researchProductFacts',
            args: {
              query: 'SUNREKA G7000iS button start recoil start',
              semanticQuery: 'SUNREKA G7000iS START button and manual starter',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: ['SUNREKA G7000iS'],
              comparisonAttributes: ['button start', 'recoil start', 'starting method'],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'exact model start-control fact',
              notes: 'answer button vs cord directly'
            },
            rationale: 'exact model fact must be grounded',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'По карточке вижу только ручной стартер.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['web:g7000is'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };
    const conversations = new FakeConversations();
    conversations.messages = [message('SUNREKA G7000iS нужно заводить шнурком или он запускается кнопкой?')];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new PresentCatalogProducts() as never, {} as never, withStrictToolFixtures({ ...badModel, reviewCustomerLanguage: async () => ({ processDisclosure: false, evidence: '', rationale: 'Semantic fact review fixture.', factualIssues: [{ claim: 'По карточке вижу только ручной стартер.', sourceResultId: 'web:g7000is', reason: 'Later checked evidence confirms button start; only manual start is incorrect.' }] }) }));

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'SUNREKA G7000iS нужно заводить шнурком или он запускается кнопкой?'
    })).rejects.toThrow('research_guidance_uncertainty_mismatch');
    expect(conversations.assistantSaves).toEqual([]);
  });

  it('saves high-confidence exact web facts into reusable product memory', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: true,
      searchDisposition: 'completed',
      sourcesExhausted: false,
      sourceAttempts: [{
        tier: 'official_page',
        outcome: 'confirmed',
        query: 'SUNREKA G7000iS button start recoil start'
      }],
      facts: [
        {
          productName: 'SUNREKA G7000iS',
          attribute: 'button start',
          value: 'has START button start',
          sourceType: 'web',
          confidence: 'high',
          evidence: 'SUNREKA G7000iS has START button start',
          sourceUrl: 'https://sunreka.example/g7000is',
          sourceTitle: 'SUNREKA G7000iS specification',
          sourceTier: 'official_page',
          sourceAuthority: 'manufacturer',
          evidenceVerifiedExact: true
        },
        {
          productName: 'SUNREKA G7000iS',
          attribute: 'recoil start',
          value: 'manual recoil starter is also available',
          sourceType: 'web',
          confidence: 'high',
          evidence: 'SUNREKA G7000iS manual recoil starter is also available',
          sourceUrl: 'https://sunreka.example/g7000is',
          sourceTitle: 'SUNREKA G7000iS specification',
          sourceTier: 'official_page',
          sourceAuthority: 'manufacturer',
          evidenceVerifiedExact: true
        }
      ],
      conflicts: [],
      answerGuidance: {
        directAnswer: 'Starts by START button; manual recoil start is also available.',
        completeness: 'answered',
        coverage: []
      },
      summaryForAnswer: 'Button and recoil start are confirmed.',
      warnings: []
    });

    class PresentCatalogProducts extends FakeProducts {
      async searchProducts() {
        return [
          product('g7000is', 'SUNREKA G7000iS generator 6 kW', { starter: 'manual starter' })
        ];
      }
    }

    const fakeProducts = new PresentCatalogProducts();
    const savingModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks if G7000iS starts by button or cord',
          dialogueUnderstanding: 'exact technical fact for a named model',
          nextStepRationale: 'verify exact model start controls',
          requiresTools: true,
          toolRequests: [{
            id: 'web:g7000is',
            tool: 'web.researchProductFacts',
            args: {
              query: 'SUNREKA G7000iS button start recoil start',
              semanticQuery: 'SUNREKA G7000iS START button and recoil starter',
              productNames: ['SUNREKA G7000iS'],
              comparisonAttributes: ['button start', 'recoil start']
            },
            rationale: 'exact model fact must be grounded',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'Starts by START button; manual recoil start is also available.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['web:g7000is'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };

    const conversations = new FakeConversations();
    conversations.messages = [message('SUNREKA G7000iS starts by cord or button?')];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, fakeProducts as never, {} as never, withStrictToolFixtures(savingModel));

    await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'SUNREKA G7000iS starts by cord or button?'
    });

    expect(fakeProducts.savedVerifiedFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        productId: 'g7000is',
        productName: 'SUNREKA G7000iS',
        attribute: 'button start',
        value: 'has START button start',
        sourceType: 'web',
        sourceUrl: 'https://sunreka.example/g7000is',
        sourceTitle: 'SUNREKA G7000iS specification',
        evidence: 'SUNREKA G7000iS has START button start',
        confidence: 'high'
      }),
      expect.objectContaining({
        productId: 'g7000is',
        productName: 'SUNREKA G7000iS',
        attribute: 'recoil start',
        value: 'manual recoil starter is also available'
      })
    ]));
    expect(fakeProducts.mirroredWebFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        productId: 'g7000is',
        attribute: 'button start',
        value: 'has START button start',
        sourceUrl: 'https://sunreka.example/g7000is',
        confidence: 0.9
      })
    ]));
  });

  it.each(['web_search', 'known_document'] as const)('persists validated coverage through the tool boundary and reuses its exact manual source on the next turn: %s', async (execution) => {
    const fakeProducts = new FakeProducts();
    const orchestrator = new AgentManagerOrchestrator(new FakeConversations() as never, fakeProducts as never, {} as never, withStrictToolFixtures(model()));
    const memory = orchestrator as any;
    const coverage = { productName: 'ТСС SGG 5000N', attribute: 'first_oil_change_interval', status: 'confirmed', value: 'После первых 20 часов работы',
      evidence: 'ПЕРВЫЕ 20 ЧАСОВ РАБОТЫ • Замените моторное масло',
      sourceUrl: 'https://cdn.vseinstrumenti.ru/instruction/nomenclaturecontent/202308/24193970.pdf/tss-sgg-2000n-059999-3187610.pdf',
      sourceTitle: 'Руководство по эксплуатации ТСС SGG 5000N', sourceTier: 'reliable_secondary', sourceAuthority: 'secondary',
      evidenceVerifiedExact: true, targetApplicability: 'shared_instruction', scopeQuote: 'Инструкция применима к ТСС SGG 2000N и ТСС SGG 5000N.' };
    const validated = validateToolResultOutput({ requestId: 'web1', tool: 'web.researchProductFacts', status: 'ok', warnings: [], payload: {
      usedWebSearch: execution === 'web_search', usedDocumentRead: execution === 'known_document',
      searchDisposition: 'completed', sourcesExhausted: false, sourceAttempts: [], facts: [], conflicts: [],
      answerGuidance: { directAnswer: coverage.value, completeness: 'partially_answered', coverage: [coverage] }, summaryForAnswer: '', warnings: []
    } });
    const input = { sessionId, turnId, targetProductNames: ['ТСС SGG 5000N'], comparisonAttributes: ['first_oil_change_interval'], selectedProducts: [] };
    expect(await memory.persistVerifiedResearchFacts({ ...input, research: validated.payload })).toBe(1);
    expect(fakeProducts.savedVerifiedFacts[0]).toEqual(expect.objectContaining({ productId: null, productName: coverage.productName,
      value: coverage.value, sourceUrl: coverage.sourceUrl, sourceAuthority: 'secondary', evidence: coverage.evidence, confidence: 'medium' }));
    const next = await memory.researchFromVerifiedFactMemory({ ...input, turnId: '44444444-4444-4444-8444-444444444444' });
    expect(next.attributesCovered).toBe(true);
    expect(next.research.facts).toContainEqual(expect.objectContaining({ productName: coverage.productName, value: coverage.value, sourceUrl: coverage.sourceUrl }));
    const otherQuestion = await memory.researchFromVerifiedFactMemory({ ...input, comparisonAttributes: ['dipstick_check_position'] });
    expect(otherQuestion?.attributesCovered).toBe(false);
    expect(otherQuestion?.research).toBeNull();
    expect(otherQuestion?.knownSourceCandidates).toContainEqual({ url: coverage.sourceUrl, title: coverage.sourceTitle });
    expect(await memory.persistVerifiedResearchFacts({ ...input, research: { ...validated.payload,
      searchDisposition: 'memory_hit', usedWebSearch: false, usedDocumentRead: true } })).toBe(0);
    expect(await memory.persistVerifiedResearchFacts({ ...input, research: { ...validated.payload,
      searchDisposition: 'completed', usedWebSearch: false, usedDocumentRead: false } })).toBe(0);
    expect(fakeProducts.savedVerifiedFacts).toHaveLength(1);
    expect(await memory.researchFromVerifiedFactMemory({ ...input, targetProductNames: ['ТСС SGG 2000N'] })).toBeNull();
    fakeProducts.verifiedFacts[0]!.lastVerifiedAt = '2025-01-01T00:00:00.000Z';
    expect(await memory.researchFromVerifiedFactMemory(input)).toBeNull();
  });

  it('does not promote unconfirmed, rejected or foreign-model coverage into fact memory', async () => {
    const fakeProducts = new FakeProducts();
    const orchestrator = new AgentManagerOrchestrator(new FakeConversations() as never, fakeProducts as never, {} as never, withStrictToolFixtures(model()));
    const coverage = { productName: 'Maker GX400', attribute: 'first_oil_change_interval', status: 'confirmed', value: '20 hours',
      evidence: 'Maker GX400: change oil after 20 hours', sourceUrl: 'https://manufacturer.example/GX400.pdf', sourceTitle: 'Maker GX400 manual',
      sourceTier: 'official_manual', sourceAuthority: 'manufacturer', evidenceVerifiedExact: true, targetApplicability: 'exact_model' };
    for (const changes of [{ status: 'not_confirmed' }, { evidenceVerifiedExact: false }, { evidenceVerifiedExact: undefined },
      { productName: 'Maker GX500' }, { sourceAuthority: undefined }]) {
      expect(await (orchestrator as any).persistVerifiedResearchFacts({ sessionId, turnId, targetProductNames: ['Maker GX400'], selectedProducts: [], research: {
        usedWebSearch: true, searchDisposition: 'completed', sourcesExhausted: false, facts: [], conflicts: [],
        answerGuidance: { directAnswer: '', completeness: 'partially_answered', coverage: [{ ...coverage, ...changes }] }
      } })).toBe(0);
    }
    expect(fakeProducts.savedVerifiedFacts).toEqual([]);
  });

  it('does not persist the same checked assertion twice when both facts and coverage contain it', async () => {
    const fakeProducts = new FakeProducts();
    const orchestrator = new AgentManagerOrchestrator(new FakeConversations() as never, fakeProducts as never, {} as never, withStrictToolFixtures(model()));
    const fact = { productName: 'Maker GX400', attribute: 'oil_capacity_l', value: '0.6', sourceType: 'web', confidence: 'high',
      evidence: 'Maker GX400 oil capacity 0.6 litres', sourceUrl: 'https://manufacturer.example/GX400.pdf', sourceTitle: 'Maker GX400 manual',
      sourceTier: 'official_manual', sourceAuthority: 'manufacturer', evidenceVerifiedExact: true };
    expect(await (orchestrator as any).persistVerifiedResearchFacts({ sessionId, turnId, targetProductNames: ['Maker GX400'], selectedProducts: [], research: {
      usedWebSearch: true, searchDisposition: 'completed', facts: [fact], conflicts: [],
      answerGuidance: { directAnswer: '', completeness: 'answered', coverage: [{ ...fact, status: 'confirmed' }] }
    } })).toBe(1);
    expect(fakeProducts.savedVerifiedFacts).toHaveLength(1);
  });

  it('does not bind an absent exact-model fact to a neighbouring selected catalog product', async () => {
    const fakeProducts = new FakeProducts();
    const conversations = new FakeConversations();
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      fakeProducts as never,
      {} as never,
      withStrictToolFixtures(model())
    );
    const persist = orchestrator as unknown as {
      persistVerifiedResearchFacts(input: Record<string, unknown>): Promise<number>;
    };

    const savedCount = await persist.persistVerifiedResearchFacts({
      sessionId,
      turnId,
      targetProductNames: ['SUNREKA G7000iS', 'SUNREKA G7500iS'],
      selectedProducts: [product('g7000is', 'SUNREKA G7000iS generator 6 kW', {})],
      research: {
        usedWebSearch: true,
        searchDisposition: 'completed',
        sourcesExhausted: false,
        sourceAttempts: [],
        facts: [{
          productName: 'SUNREKA G7500iS',
          attribute: 'nominal power',
          value: '7 kW',
          sourceType: 'web',
          confidence: 'medium',
          evidence: 'SUNREKA G7500iS nominal power 7 kW',
          sourceUrl: 'https://equipment.example/sunreka-g7500is',
          sourceTitle: 'SUNREKA G7500iS specification',
          sourceTier: 'reliable_secondary',
          sourceAuthority: 'secondary',
          evidenceVerifiedExact: true
        }],
        conflicts: [],
        answerGuidance: { directAnswer: '', completeness: 'partially_answered', coverage: [] },
        summaryForAnswer: '',
        warnings: []
      }
    });

    expect(savedCount).toBe(1);
    expect(fakeProducts.savedVerifiedFacts).toContainEqual(expect.objectContaining({
      productId: null,
      productName: 'SUNREKA G7500iS'
    }));
    expect(fakeProducts.mirroredWebFacts).toEqual([]);

    const timedOutCount = await persist.persistVerifiedResearchFacts({
      sessionId,
      turnId,
      targetProductNames: ['SUNREKA G7500iS'],
      selectedProducts: [],
      research: {
        usedWebSearch: true,
        searchDisposition: 'timed_out',
        sourcesExhausted: false,
        sourceAttempts: [{ tier: 'reliable_secondary', outcome: 'confirmed' }],
        facts: [{
          productName: 'SUNREKA G7500iS',
          attribute: 'nominal power',
          value: '7 kW',
          sourceType: 'web',
          confidence: 'medium',
          evidence: 'SUNREKA G7500iS nominal power 7 kW',
          sourceUrl: 'https://equipment.example/sunreka-g7500is',
          sourceTitle: 'SUNREKA G7500iS specification',
          sourceTier: 'reliable_secondary',
          sourceAuthority: 'secondary',
          evidenceVerifiedExact: true
        }],
        conflicts: [],
        answerGuidance: { directAnswer: '', completeness: 'partially_answered', coverage: [] },
        summaryForAnswer: '',
        warnings: ['generic_source_tier_retry_timed_out']
      }
    });
    expect(timedOutCount).toBe(0);
    expect(fakeProducts.savedVerifiedFacts).toHaveLength(1);

    const conflictedCount = await persist.persistVerifiedResearchFacts({
      sessionId,
      turnId,
      targetProductNames: ['SUNREKA G7500iS'],
      selectedProducts: [],
      research: {
        usedWebSearch: true,
        searchDisposition: 'completed',
        sourcesExhausted: false,
        sourceAttempts: [],
        facts: [{
          productName: 'SUNREKA G7500iS',
          attribute: 'nominal power',
          value: '7 kW',
          sourceType: 'web',
          confidence: 'medium',
          evidence: 'SUNREKA G7500iS nominal power 7 kW',
          sourceUrl: 'https://equipment.example/sunreka-g7500is',
          sourceTitle: 'SUNREKA G7500iS specification',
          sourceTier: 'reliable_secondary',
          sourceAuthority: 'secondary',
          evidenceVerifiedExact: true
        }],
        conflicts: [{
          productName: 'SUNREKA G7500iS',
          attribute: 'nominal power',
          webValues: ['7 kW', '8 kW'],
          resolution: 'unresolved'
        }],
        answerGuidance: { directAnswer: '', completeness: 'partially_answered', coverage: [] },
        summaryForAnswer: '',
        warnings: []
      }
    });
    expect(conflictedCount).toBe(0);
    expect(fakeProducts.savedVerifiedFacts).toHaveLength(1);

    const ambiguousMultiTargetCount = await persist.persistVerifiedResearchFacts({
      sessionId,
      turnId,
      targetProductNames: ['SUNREKA G7000iS', 'SUNREKA G7500iS'],
      selectedProducts: [],
      research: {
        usedWebSearch: true,
        searchDisposition: 'completed',
        sourcesExhausted: false,
        sourceAttempts: [],
        facts: [{
          productName: 'SUNREKA G7500iS',
          attribute: 'nominal power',
          value: '7 kW',
          sourceType: 'web',
          confidence: 'medium',
          evidence: 'SUNREKA G7500iS nominal power 7 kW',
          sourceUrl: 'https://equipment.example/sunreka-g7500is',
          sourceTitle: 'SUNREKA G7500iS specification',
          sourceTier: 'reliable_secondary',
          sourceAuthority: 'secondary',
          evidenceVerifiedExact: true
        }],
        conflicts: [],
        answerGuidance: {
          directAnswer: '',
          completeness: 'partially_answered',
          coverage: [{
            attribute: 'nominal power',
            status: 'ambiguous',
            value: '',
            evidence: 'two unresolved values'
          }]
        },
        summaryForAnswer: '',
        warnings: []
      }
    });
    expect(ambiguousMultiTargetCount).toBe(0);
    expect(fakeProducts.savedVerifiedFacts).toHaveLength(1);
    expect(conversations.traces).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: 'verified_fact_memory_persistence',
        payload: expect.objectContaining({ persistableCount: 1, savedCount: 1 })
      }),
      expect.objectContaining({
        eventType: 'verified_fact_memory_persistence',
        payload: expect.objectContaining({ persistableCount: 0, savedCount: 0 })
      }),
      expect.objectContaining({
        eventType: 'verified_fact_memory_persistence',
        payload: expect.objectContaining({
          persistableCount: 0,
          savedCount: 0,
          searchDisposition: 'timed_out',
          skippedReason: 'research_execution_not_completed'
        })
      })
    ]));
  });

  it('persists an exact semantically verified value when the source quote uses different wording', async () => {
    const fakeProducts = new FakeProducts();
    const orchestrator = new AgentManagerOrchestrator(
      new FakeConversations() as never,
      fakeProducts as never,
      {} as never,
      withStrictToolFixtures(model())
    );
    const persist = orchestrator as unknown as {
      persistVerifiedResearchFacts(input: Record<string, unknown>): Promise<number>;
    };

    const savedCount = await persist.persistVerifiedResearchFacts({
      sessionId,
      turnId,
      targetProductNames: ['BISON BS6250IE'],
      selectedProducts: [],
      research: {
        usedWebSearch: true,
        searchDisposition: 'completed',
        sourcesExhausted: false,
        sourceAttempts: [{ tier: 'official_page', outcome: 'confirmed' }],
        facts: [{
          productName: 'BISON BS6250IE',
          attribute: 'usb_current_a',
          value: '1 А и 2,1 А',
          sourceType: 'web',
          confidence: 'high',
          evidence: 'DC USB output: 5V/1A/2.1A',
          sourceUrl: 'https://bisonpower.net/generator/inverter-generator/BS6250IE.html',
          sourceTitle: 'BISON BS6250IE specifications',
          sourceTier: 'official_page',
          sourceAuthority: 'manufacturer',
          evidenceVerifiedExact: true
        }],
        conflicts: [],
        answerGuidance: {
          directAnswer: 'USB поддерживает 1 А и 2,1 А.',
          completeness: 'answered',
          coverage: [{
            productName: 'BISON BS6250IE',
            attribute: 'usb_current_a',
            status: 'confirmed',
            value: '1 А и 2,1 А',
            evidence: 'DC USB output: 5V/1A/2.1A'
          }]
        },
        summaryForAnswer: '',
        warnings: []
      }
    });

    expect(savedCount).toBe(1);
    expect(fakeProducts.savedVerifiedFacts).toContainEqual(expect.objectContaining({
      productId: null,
      productName: 'BISON BS6250IE',
      attribute: 'usb_current_a',
      value: '1 А и 2,1 А'
    }));
  });

  it('persists a confirmed product fact while preserving another product unresolved on the same attribute', async () => {
    const fakeProducts = new FakeProducts();
    const orchestrator = new AgentManagerOrchestrator(
      new FakeConversations() as never,
      fakeProducts as never,
      {} as never,
      withStrictToolFixtures(model())
    );
    const persist = orchestrator as unknown as {
      persistVerifiedResearchFacts(input: Record<string, unknown>): Promise<number>;
    };
    const coverage = [{
      productName: 'SUNREKA G7000iS',
      attribute: 'nominal power',
      status: 'confirmed' as const,
      value: '6 kW',
      evidence: 'SUNREKA G7000iS nominal power 6 kW',
      sourceUrl: 'https://equipment.example/sunreka-g7000is',
      sourceTitle: 'SUNREKA G7000iS specification'
    }, {
      productName: 'SUNREKA G7500iS',
      attribute: 'nominal power',
      status: 'not_confirmed' as const,
      value: '',
      evidence: 'SUNREKA G7500iS nominal power remains unconfirmed'
    }];

    const savedCount = await persist.persistVerifiedResearchFacts({
      sessionId,
      turnId,
      targetProductNames: ['SUNREKA G7000iS', 'SUNREKA G7500iS'],
      selectedProducts: [],
      research: {
        usedWebSearch: true,
        searchDisposition: 'completed',
        sourcesExhausted: false,
        sourceAttempts: [{ tier: 'reliable_secondary', outcome: 'confirmed' }],
        facts: [{
          productName: 'SUNREKA G7000iS',
          attribute: 'nominal power',
          value: '6 kW',
          sourceType: 'web',
          confidence: 'medium',
          evidence: 'SUNREKA G7000iS nominal power 6 kW',
          sourceUrl: 'https://equipment.example/sunreka-g7000is',
          sourceTitle: 'SUNREKA G7000iS specification',
          sourceTier: 'reliable_secondary',
          sourceAuthority: 'secondary',
          evidenceVerifiedExact: true
        }],
        conflicts: [],
        answerGuidance: { directAnswer: '', completeness: 'partially_answered', coverage },
        summaryForAnswer: '',
        warnings: []
      }
    });

    expect(savedCount).toBe(1);
    expect(fakeProducts.savedVerifiedFacts).toEqual([
      expect.objectContaining({ productName: 'SUNREKA G7000iS', attribute: 'nominal power' })
    ]);
    expect(coverage).toContainEqual(expect.objectContaining({
      productName: 'SUNREKA G7500iS',
      status: 'not_confirmed'
    }));
  });

  it('reuses bound memory for a catalog model and name-only memory for an absent comparison target', async () => {
    const now = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const fakeProducts = new FakeProducts();
    fakeProducts.verifiedFacts = [{
      id: 'bound-g7000',
      productId: 'g7000is',
      productKey: 'sunreka g7000is',
      productName: 'SUNREKA G7000iS',
      attribute: 'nominal power',
      value: '6 kW',
      sourceType: 'web',
      sourceUrl: 'https://manufacturer.example/g7000is',
      sourceTitle: 'SUNREKA G7000iS specification',
      evidence: 'SUNREKA G7000iS nominal power 6 kW',
      confidence: 'high',
      status: 'active',
      firstSeenAt: now,
      lastVerifiedAt: now,
      hitCount: 0,
      createdAt: now,
      updatedAt: now
    }, {
      id: 'name-only-g7500',
      productId: null,
      productKey: 'sunreka g7500is',
      productName: 'SUNREKA G7500iS',
      attribute: 'nominal power',
      value: '7 kW',
      sourceType: 'web',
      sourceUrl: 'https://manufacturer.example/g7500is',
      sourceTitle: 'SUNREKA G7500iS specification',
      evidence: 'SUNREKA G7500iS nominal power 7 kW',
      confidence: 'high',
      status: 'active',
      firstSeenAt: now,
      lastVerifiedAt: now,
      hitCount: 0,
      createdAt: now,
      updatedAt: now
    }];
    const orchestrator = new AgentManagerOrchestrator(
      new FakeConversations() as never,
      fakeProducts as never,
      {} as never,
      withStrictToolFixtures(model())
    );
    const memoryReader = orchestrator as unknown as {
      researchFromVerifiedFactMemory(input: Record<string, unknown>): Promise<{
        attributesCovered: boolean;
        missingFactSlots: unknown[];
      } | null>;
    };

    const memory = await memoryReader.researchFromVerifiedFactMemory({
      sessionId,
      turnId,
      targetProductNames: ['SUNREKA G7000iS', 'SUNREKA G7500iS'],
      comparisonAttributes: ['nominal power'],
      selectedProducts: [product('g7000is', 'SUNREKA G7000iS generator 6 kW', {})]
    });

    expect(memory?.attributesCovered).toBe(true);
    expect(memory?.missingFactSlots).toEqual([]);
    expect(fakeProducts.usedVerifiedFactIds).toEqual(expect.arrayContaining([
      'bound-g7000',
      'name-only-g7500'
    ]));
  });

  it('uses reusable exact web facts before spending another web research call', async () => {
    researchProductComparisonFacts.mockClear();
    const now = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // fresh: inside 90d fact TTL
    class MemoryProducts extends FakeProducts {
      constructor() {
        super();
        this.verifiedFacts = [
          {
            id: 'fact-button',
            productId: 'g7000is',
            productKey: 'sunreka g7000is',
            productName: 'SUNREKA G7000iS',
            attribute: 'button start',
            value: 'has START button start',
            sourceType: 'web',
            sourceUrl: 'https://sunreka.example/g7000is',
            sourceTitle: 'SUNREKA G7000iS specification',
            evidence: 'official source says the model starts by START button',
            confidence: 'high',
            status: 'active',
            firstSeenAt: now,
            lastVerifiedAt: now,
            hitCount: 0,
            createdAt: now,
            updatedAt: now
          },
          {
            id: 'fact-recoil',
            productId: 'g7000is',
            productKey: 'sunreka g7000is',
            productName: 'SUNREKA G7000iS',
            attribute: 'recoil start',
            value: 'manual recoil starter is also available',
            sourceType: 'web',
            sourceUrl: 'https://sunreka.example/g7000is',
            sourceTitle: 'SUNREKA G7000iS specification',
            evidence: 'official source lists manual starter',
            confidence: 'high',
            status: 'active',
            firstSeenAt: now,
            lastVerifiedAt: now,
            hitCount: 0,
            createdAt: now,
            updatedAt: now
          },
          {
            id: 'legacy-name-only-button',
            productId: null,
            productKey: 'sunreka g7000is',
            productName: 'SUNREKA G7000iS',
            attribute: 'button start',
            value: 'does not have START button start',
            sourceType: 'web',
            sourceUrl: 'https://legacy.example/g7000is',
            sourceTitle: 'Legacy name-only record',
            evidence: 'legacy name-only fact without a current catalog binding',
            confidence: 'high',
            status: 'active',
            firstSeenAt: now,
            lastVerifiedAt: now,
            hitCount: 0,
            createdAt: now,
            updatedAt: now
          }
        ];
      }
      async searchProducts() {
        return [
          product('g7000is', 'SUNREKA G7000iS generator 6 kW', { starter: 'manual starter' })
        ];
      }
    }

    const fakeProducts = new MemoryProducts();
    const memoryModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks if G7000iS starts by button or cord',
          dialogueUnderstanding: 'exact technical fact for a named model',
          nextStepRationale: 'use verified fact memory before external search',
          requiresTools: true,
          toolRequests: [{
            id: 'web:g7000is',
            tool: 'web.researchProductFacts',
            args: {
              query: 'SUNREKA G7000iS button start recoil start',
              semanticQuery: 'SUNREKA G7000iS START button and recoil starter',
              productNames: ['SUNREKA G7000iS'],
              comparisonAttributes: ['button start', 'recoil start']
            },
            rationale: 'exact model fact must be grounded',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        const memoryResult = input.toolResults.find((result) => result.requestId === 'web:g7000is');
        expect((memoryResult?.payload as { answerGuidance?: { directAnswer?: string } }).answerGuidance?.directAnswer)
          .toBe('');
        expect(input.requiredResponseClauses?.map((clause) => clause.code))
          .toContain('answer_verified_fact_memory_naturally');
        expect(input.toolResults).toEqual(expect.arrayContaining([
          expect.objectContaining({
            requestId: 'web:g7000is',
            status: 'ok',
            warnings: expect.arrayContaining(['verified_product_fact_memory_used'])
          })
        ]));
        return {
          answerText: 'Starts by START button; manual recoil start is also available.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['web:g7000is'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };

    const conversations = new FakeConversations();
    conversations.messages = [message('SUNREKA G7000iS starts by cord or button?')];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, fakeProducts as never, {} as never, withStrictToolFixtures(memoryModel, 'conditional_on_catalog_gap'));

    await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'SUNREKA G7000iS starts by cord or button?'
    });

    expect(researchProductComparisonFacts).not.toHaveBeenCalled();
    expect(fakeProducts.usedVerifiedFactIds).toEqual(expect.arrayContaining(['fact-button', 'fact-recoil']));
    expect(fakeProducts.usedVerifiedFactIds).not.toContain('legacy-name-only-button');
  });

  it('semantically binds equivalent canonical attributes before deciding that memory has a gap', async () => {
    const now = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    class SemanticMemoryProducts extends FakeProducts {
      constructor() {
        super();
        this.verifiedFacts = [{
          id: 'fact-bison-usb-current',
          productId: 'bison-bs6250ie',
          productKey: 'bison bs6250ie',
          productName: 'BISON BS6250IE',
          attribute: 'usb_supported_current',
          value: '1 A и 2.1 A при 5 V',
          sourceType: 'web',
          sourceUrl: 'https://bisonpower.net/generator/inverter-generator/BS6250IE.html',
          sourceTitle: 'BISON BS6250IE specifications',
          sourceTier: 'official_page',
          sourceAuthority: 'manufacturer',
          evidence: 'DC USB output5V/1A/2.1A',
          confidence: 'high',
          status: 'active',
          firstSeenAt: now,
          lastVerifiedAt: now,
          observedAt: now,
          hitCount: 0,
          createdAt: now,
          updatedAt: now
        }];
      }
      async searchProducts() {
        return [product('bison-bs6250ie', 'BISON BS6250IE', {}, 'USB current is absent from catalog data.')];
      }
    }

    const semanticModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks for the exact USB output current',
          dialogueUnderstanding: 'exact model technical fact',
          nextStepRationale: 'reuse a semantically equivalent verified fact before external research',
          requiresTools: true,
          toolRequests: [{
            id: 'web:bison-usb',
            tool: 'web.researchProductFacts',
            args: {
              query: 'BISON BS6250IE USB output current',
              semanticQuery: 'exact BISON BS6250IE USB output current',
              productNames: ['BISON BS6250IE'],
              comparisonAttributes: ['usb_output_current']
            },
            rationale: 'the technical fact must be grounded',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async matchVerifiedFactMemory(input) {
        expect(input.requestedFactSlots).toEqual([{
          productName: 'BISON BS6250IE',
          attribute: 'usb_output_current'
        }]);
        expect(input.facts).toContainEqual(expect.objectContaining({
          id: 'fact-bison-usb-current',
          attribute: 'usb_supported_current'
        }));
        return [{
          factId: 'fact-bison-usb-current',
          productName: 'BISON BS6250IE',
          attribute: 'usb_output_current'
        }];
      },
      async composeAnswer(input) {
        const result = input.toolResults.find((item) => item.requestId === 'web:bison-usb');
        expect(result).toEqual(expect.objectContaining({
          status: 'ok',
          warnings: expect.arrayContaining(['verified_product_fact_memory_used'])
        }));
        expect(result?.payload).toEqual(expect.objectContaining({
          usedWebSearch: false,
          searchDisposition: 'memory_hit',
          facts: expect.arrayContaining([expect.objectContaining({
            attribute: 'usb_output_current',
            value: '1 A и 2.1 A при 5 V'
          })])
        }));
        return {
          answerText: 'USB-выход даёт 1 А или 2,1 А при 5 В.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['web:bison-usb'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };
    const fakeProducts = new SemanticMemoryProducts();
    const conversations = new FakeConversations();
    conversations.messages = [message('Какие токи даёт USB-выход BISON BS6250IE?')];
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      fakeProducts as never,
      {} as never,
      withStrictToolFixtures(semanticModel, 'conditional_on_catalog_gap')
    );

    await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Какие токи даёт USB-выход BISON BS6250IE?'
    });

    expect(researchProductComparisonFacts).not.toHaveBeenCalled();
    expect(fakeProducts.usedVerifiedFactIds).toEqual(['fact-bison-usb-current']);
    expect(conversations.traces).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'verified_fact_memory_semantic_match' }),
      expect.objectContaining({ eventType: 'verified_fact_memory_used' })
    ]));
  });

  it('researches only missing canonical attributes and merges them with reusable memory', async () => {
    const now = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    class PartialMemoryProducts extends FakeProducts {
      constructor() {
        super();
        this.verifiedFacts = [{
          id: 'fact-power',
          productId: 'g7000is',
          productKey: 'sunreka g7000is',
          productName: 'SUNREKA G7000iS',
          attribute: 'nominal power',
          value: '6 kW',
          sourceType: 'web',
          sourceUrl: 'https://manufacturer.example/g7000is',
          sourceTitle: 'SUNREKA G7000iS specification',
          sourceTier: 'official_page',
          sourceAuthority: 'manufacturer',
          evidence: 'SUNREKA G7000iS nominal power 6 kW',
          confidence: 'high',
          status: 'active',
          firstSeenAt: now,
          lastVerifiedAt: now,
          observedAt: now,
          hitCount: 0,
          createdAt: now,
          updatedAt: now
        }];
      }
      async searchProducts() {
        return [product('g7000is', 'SUNREKA G7000iS generator 6 kW', { nominalPowerKw: 6 })];
      }
    }
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: true,
      searchDisposition: 'completed',
      sourcesExhausted: false,
      sourceAttempts: [],
      facts: [{
        productName: 'SUNREKA G7000iS',
        attribute: 'fuel tank capacity',
        value: '15 l',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'SUNREKA G7000iS fuel tank capacity 15 l',
        sourceUrl: 'https://manufacturer.example/g7000is-manual.pdf',
        sourceTitle: 'SUNREKA G7000iS manual',
        sourceTier: 'official_manual',
        sourceAuthority: 'manufacturer',
        evidenceVerifiedExact: true
      }],
      conflicts: [],
      answerGuidance: {
        directAnswer: 'У SUNREKA G7000iS бак 15 л.',
        completeness: 'answered',
        coverage: [{
          attribute: 'fuel tank capacity',
          status: 'confirmed',
          value: '15 l',
          evidence: 'SUNREKA G7000iS fuel tank capacity 15 l',
          sourceUrl: 'https://manufacturer.example/g7000is-manual.pdf',
          sourceTitle: 'SUNREKA G7000iS manual',
          sourceTier: 'official_manual',
          sourceAuthority: 'manufacturer'
        }]
      },
      summaryForAnswer: 'Fuel tank capacity is confirmed.',
      warnings: []
    });

    const partialProducts = new PartialMemoryProducts();
    const partialModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks for power and tank capacity',
          dialogueUnderstanding: 'exact model technical facts',
          nextStepRationale: 'reuse memory and research only the gap',
          requiresTools: true,
          toolRequests: [{
            id: 'web:g7000is-details',
            tool: 'web.researchProductFacts',
            args: {
              query: 'SUNREKA G7000iS nominal power fuel tank capacity',
              semanticQuery: 'SUNREKA G7000iS exact specification',
              productNames: ['SUNREKA G7000iS'],
              comparisonAttributes: ['nominal power', 'fuel tank capacity']
            },
            rationale: 'exact facts must be grounded',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        const payload = input.toolResults.find((item) => item.requestId === 'web:g7000is-details')?.payload as {
          facts?: Array<{ attribute?: string }>;
        };
        expect(payload.facts?.map((fact) => fact.attribute)).toEqual(expect.arrayContaining([
          'nominal power',
          'fuel tank capacity'
        ]));
        return {
          answerText: 'Номинальная мощность 6 кВт, бак 15 л.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['web:g7000is-details'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };
    const conversations = new FakeConversations();
    conversations.messages = [message('Какая мощность и объём бака у SUNREKA G7000iS?')];
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      partialProducts as never,
      {} as never,
      withStrictToolFixtures(partialModel, 'conditional_on_catalog_gap')
    );

    await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Какая мощность и объём бака у SUNREKA G7000iS?'
    });

    expect(researchProductComparisonFacts).toHaveBeenCalledWith(expect.objectContaining({
      targetProductNames: ['SUNREKA G7000iS'],
      comparisonAttributes: ['fuel tank capacity'],
      missingFactSlots: [{
        productName: 'SUNREKA G7000iS',
        attribute: 'fuel tank capacity'
      }]
    }));
    expect(partialProducts.usedVerifiedFactIds).toContain('fact-power');
    expect(partialProducts.savedVerifiedFacts).toContainEqual(expect.objectContaining({
      sourceType: 'manual',
      sourceTier: 'official_manual',
      sourceAuthority: 'manufacturer'
    }));
  });

  it('preserves per-product coverage through partial-memory research and writer grounding', async () => {
    const now = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const modelA = product('model-a', 'SUNREKA G7000iS', { nominalPowerKw: 6 });
    const modelB = product('model-b', 'SUNREKA G7500iS', {});
    const modelAAlias = 'SUNREKA G7000iS generator 6 kW';
    class TwoTargetMemoryProducts extends FakeProducts {
      constructor() {
        super();
        this.verifiedFacts = [{
          id: 'fact-model-a-power',
          productId: modelA.id,
          productKey: 'sunreka g7000is',
          productName: modelAAlias,
          attribute: 'nominal power',
          value: '6 kW',
          sourceType: 'web',
          sourceUrl: 'https://manufacturer.example/g7000is',
          sourceTitle: 'SUNREKA G7000iS specification',
          sourceTier: 'official_page',
          sourceAuthority: 'manufacturer',
          evidence: 'SUNREKA G7000iS nominal power 6 kW',
          confidence: 'high',
          status: 'active',
          firstSeenAt: now,
          lastVerifiedAt: now,
          observedAt: now,
          hitCount: 0,
          createdAt: now,
          updatedAt: now
        }];
      }
      async searchProducts() {
        return [modelA, modelB];
      }
    }
    extractCatalogProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: false,
      searchDisposition: 'not_needed',
      sourcesExhausted: false,
      sourceAttempts: [{ tier: 'catalog', outcome: 'confirmed' }],
      facts: [],
      conflicts: [],
      answerGuidance: {
        directAnswer: '',
        completeness: 'not_answered',
        coverage: [modelA, modelB].map((item) => ({
          productName: item.name,
          attribute: 'nominal power',
          status: 'not_confirmed' as const,
          value: '',
          evidence: 'catalog card does not confirm nominal power'
        }))
      },
      summaryForAnswer: '',
      warnings: ['catalog_fact_missing_needs_web_research']
    });
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: true,
      searchDisposition: 'completed',
      sourcesExhausted: false,
      sourceAttempts: [],
      facts: [],
      conflicts: [],
      answerGuidance: {
        directAnswer: '',
        completeness: 'not_answered',
        coverage: [{
          productName: modelB.name,
          attribute: 'nominal power',
          status: 'not_confirmed',
          value: '',
          evidence: 'SUNREKA G7500iS nominal power remains unconfirmed'
        }]
      },
      summaryForAnswer: '',
      warnings: []
    });
    const groundedModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer compares nominal power for two exact models',
          dialogueUnderstanding: 'reuse exact memory and preserve the unresolved second model',
          nextStepRationale: 'research only the missing product slot',
          requiresTools: true,
          toolRequests: [{
            id: 'web:two-model-power',
            tool: 'web.researchProductFacts',
            args: {
              query: 'SUNREKA G7000iS SUNREKA G7500iS nominal power',
              productNames: [modelA.name, modelB.name],
              comparisonAttributes: ['nominal power']
            },
            rationale: 'exact product facts must remain product-scoped',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        const result = input.toolResults.find((item) => item.requestId === 'web:two-model-power');
        const payload = result?.payload as {
          facts?: Array<{ productName?: string }>;
          answerGuidance?: { coverage?: Array<{ productName?: string | null; status?: string }> };
          unconfirmedFacts?: Array<{ productName?: string | null; attribute?: string }>;
        };
        expect(payload.facts).toContainEqual(expect.objectContaining({ productName: modelAAlias }));
        expect(payload.answerGuidance?.coverage).toEqual(expect.arrayContaining([
          expect.objectContaining({ productName: modelA.name, status: 'confirmed' }),
          expect.objectContaining({ productName: modelB.name, status: 'not_confirmed' })
        ]));
        expect(payload.unconfirmedFacts).toContainEqual(expect.objectContaining({
          productName: modelB.name,
          attribute: 'nominal power'
        }));
        expect(payload.unconfirmedFacts).not.toContainEqual(expect.objectContaining({
          productName: modelA.name,
          attribute: 'nominal power'
        }));
        expect(input.requiredResponseClauses?.find((clause) => clause.code === 'web_research_partial_grounding')?.instruction)
          .toContain(modelB.name);
        return {
          answerText: `${modelA.name}: 6 kW. ${modelB.name}: nominal power is not confirmed yet.`,
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['web:two-model-power'],
          selectedProductIds: [],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };
    const conversations = new FakeConversations();
    conversations.messages = [message('Compare nominal power for SUNREKA G7000iS and SUNREKA G7500iS.')];
    const products = new TwoTargetMemoryProducts();
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      products as never,
      {} as never,
      withStrictToolFixtures(groundedModel, 'conditional_on_catalog_gap')
    );

    await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Compare nominal power for SUNREKA G7000iS and SUNREKA G7500iS.'
    });

    expect(researchProductComparisonFacts).toHaveBeenCalledWith(expect.objectContaining({
      missingFactSlots: [{ productName: modelB.name, attribute: 'nominal power' }]
    }));
    expect(products.usedVerifiedFactIds).toContain('fact-model-a-power');
  });

  it('rejects a stale follow-up plan that requires web research but omitted the tool', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: true,
      facts: [{
        productName: 'RD3910E',
        attribute: 'starting method',
        value: 'manual starter / electric starter; key/button control not confirmed',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'exact current-target catalog/research context confirms starter type only',
        sourceUrl: 'https://example.test/firman-rd3910e',
        sourceTitle: 'FIRMAN RD3910E specification'
      }],
      conflicts: [],
      answerGuidance: {
        directAnswer: 'У RD3910E подтвержден ручной стартер / электростартер; кнопка по точным источникам не подтверждена.',
        completeness: 'partially_answered',
        coverage: [
          {
            attribute: 'key start',
            status: 'ambiguous',
            value: 'key/switch control not fully confirmed',
            evidence: 'current exact target sources confirm electric starter but do not fully prove key/switch control',
            sourceUrl: 'https://example.test/firman-rd3910e',
            sourceTitle: 'FIRMAN RD3910E specification'
          },
          {
            attribute: 'button start',
            status: 'not_confirmed',
            value: 'push-button control not confirmed',
            evidence: 'current exact target sources do not name push-button control',
            sourceUrl: 'https://example.test/firman-rd3910e',
            sourceTitle: 'FIRMAN RD3910E specification'
          }
        ]
      },
      summaryForAnswer: 'RD3910E starter type is confirmed; key/button control is not confirmed.',
      warnings: []
    });

    class PresentCatalogProducts extends FakeProducts {
      async searchProducts() {
        return [
          product('rd3910e', 'FIRMAN RD3910E generator 2.5 kW', { starter: 'manual / electric' })
        ];
      }
    }

    const badFollowUpPlanner: AgentManagerModel = {
      ...model(),
      async proposeLedgerDelta() {
        return {
          rationale: 'follow-up model question',
          events: []
        };
      },
      async planTurn() {
        return {
          turnId: 'q2',
          userMessageSummary: 'buyer asks if RD3910E starts the same way as the previous model',
          dialogueUnderstanding: 'incorrectly assumes previous model fact applies',
          nextStepRationale: 'answer from context',
          requiresTools: false,
          toolRequests: [],
          productMentions: [{
            name: 'FIRMAN RD3910E',
            role: 'target_product',
            productClass: 'generator',
            evidence: 'buyer asks about this exact current model'
          }],
          grounding: {
            taskType: 'comparison',
            sourcePolicy: 'web_required',
            webPurpose: 'technical_specs',
            webRequirement: 'independent_required',
            requiredToolKinds: ['web.researchProductFacts'],
            technicalAttributes: ['start_control_mechanism'],
            buyerQuestion: 'А Firman RD3910E у вас есть? Там запуск так же через ключ/выключатель, а не кнопкой?',
            rationale: 'The current model requires its own checked start-control evidence.'
          },
          mustNotAskQuestionIds: [],
          riskFlags: ['answer_policy_catalog_presence_relevant']
        };
      },
      async composeAnswer(input) {
        expect(input.toolResults).toEqual(expect.arrayContaining([
          expect.objectContaining({ tool: 'web.researchProductFacts' })
        ]));
        expect(input.requiredResponseClauses?.map((clause) => clause.code)).toContain('answer_checked_research_guidance');
        return {
          answerText: 'Да, RD3910E тоже запускается с ключа/выключателя, не кнопкой.',
          factsUsed: [{
            factKey: 'rd3910e.start_control',
            sourceEventIds: ['auto:exact-model:rd3910e'],
            value: 'key start'
          }],
          questionsAsked: [],
          toolResultIds: ['auto:exact-model:rd3910e'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };
    const conversations = new FakeConversations();
    conversations.messages = [
      message('RD2910E с ключа или кнопки?'),
      message('RD2910E с ключа, в каталоге нет. Из близких есть RD3910E.', 'assistant'),
      message('А Firman RD3910E у вас есть? Там запуск так же через ключ/выключатель, а не кнопкой?')
    ];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new PresentCatalogProducts() as never, {} as never, withStrictToolFixtures(badFollowUpPlanner));

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'А Firman RD3910E у вас есть? Там запуск так же через ключ/выключатель, а не кнопкой?'
    })).rejects.toThrow('required_tool_request_missing:web.researchProductFacts');

    expect(researchProductComparisonFacts).not.toHaveBeenCalled();
    expect(conversations.assistantSaves).toEqual([]);
  });

  it('routes complete exact catalog details through conditional research without using external web', async () => {
    researchProductComparisonFacts.mockClear();
    const tss = product('tss-5000n', 'TSS SGG 5000N gasoline generator 5 kW', {
      nominal_power_kw: 5,
      voltage_v: 230,
      phase: 'single_phase',
      generator_type: 'conventional'
    });
    const bison = product('bison-6250ie', 'BISON BS6250IE gasoline inverter generator 5 kW', {
      nominal_power_kw: 5,
      voltage_v: 220,
      phase: 'single_phase',
      generator_type: 'inverter'
    });
    tss.price = 49281;
    bison.price = 61100;
    extractCatalogProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: false,
      searchDisposition: 'not_needed',
      sourcesExhausted: false,
      sourceAttempts: [{ tier: 'catalog', outcome: 'confirmed' }],
      facts: [{
        productName: tss.name,
        attribute: 'nominal power',
        value: '5 kW',
        sourceType: 'catalog',
        confidence: 'high',
        evidence: 'nominal_power_kw: 5',
        sourceUrl: tss.sourceUrl,
        sourceTitle: tss.name
      }, {
        productName: bison.name,
        attribute: 'nominal power',
        value: '5 kW',
        sourceType: 'catalog',
        confidence: 'high',
        evidence: 'nominal_power_kw: 5',
        sourceUrl: bison.sourceUrl,
        sourceTitle: bison.name
      }, {
        productName: tss.name,
        attribute: 'generator type',
        value: 'conventional',
        sourceType: 'catalog',
        confidence: 'high',
        evidence: 'generator_type: conventional',
        sourceUrl: tss.sourceUrl,
        sourceTitle: tss.name
      }, {
        productName: bison.name,
        attribute: 'generator type',
        value: 'inverter',
        sourceType: 'catalog',
        confidence: 'high',
        evidence: 'generator_type: inverter',
        sourceUrl: bison.sourceUrl,
        sourceTitle: bison.name
      }],
      conflicts: [],
      answerGuidance: {
        directAnswer: 'Both exact catalog cards confirm nominal power and generator type.',
        completeness: 'answered',
        coverage: [{
          attribute: 'nominal power',
          status: 'confirmed',
          value: '5 kW',
          evidence: 'both exact current catalog cards'
        }, {
          attribute: 'generator type',
          status: 'confirmed',
          value: 'conventional / inverter',
          evidence: 'both exact current catalog cards'
        }]
      },
      summaryForAnswer: 'The exact catalog cards fully answer the requested comparison.',
      warnings: ['catalog_fact_extraction_used', 'web_research_not_needed:catalog_extraction_answered']
    });

    class ExactComparisonProducts extends FakeProducts {
      async getProductsByIds(ids: string[]) {
        return [tss, bison].filter((item) => ids.includes(item.id));
      }
      async searchProducts() {
        return [tss, bison];
      }
    }

    const catalogComparisonModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'compare only TSS SGG 5000N and BISON BS6250IE without overpaying',
          dialogueUnderstanding: 'the buyer narrowed the current shortlist to two exact catalog products',
          nextStepRationale: 'load the two exact catalog cards and compare verified facts',
          requiresTools: true,
          toolRequests: [{
            id: 'catalog:exact-comparison',
            tool: 'catalog.getProductDetails',
            args: {
              query: 'TSS SGG 5000N BISON BS6250IE',
              productIntent: 'generator',
              canonicalProductIntent: 'generator',
              productIds: [tss.id, bison.id],
              productNames: ['TSS SGG 5000N', 'BISON BS6250IE'],
              comparisonAttributes: ['nominal_power_kw', 'voltage_v', 'phase', 'generator_type']
            },
            rationale: 'both exact products are present in the current catalog',
            required: true,
            coversRequirementIds: ['comparison-scope']
          }, {
            id: 'web:exact-comparison',
            tool: 'web.researchProductFacts',
            args: {
              query: 'TSS SGG 5000N BISON BS6250IE nominal power generator type',
              productIntent: 'generator',
              canonicalProductIntent: 'generator',
              productNames: ['TSS SGG 5000N', 'BISON BS6250IE'],
              comparisonAttributes: ['nominal power', 'generator type']
            },
            rationale: 'check only comparison attributes left unresolved by the exact catalog cards',
            required: true
          }],
          productMentions: [{
            name: 'TSS SGG 5000N',
            role: 'comparison_subject',
            productClass: 'generator',
            evidence: 'first exact comparison target'
          }, {
            name: 'BISON BS6250IE',
            role: 'comparison_subject',
            productClass: 'generator',
            evidence: 'second exact comparison target'
          }],
          selectionPolicy: {
            targetProductClass: 'gasoline generator for a country house',
            canonicalProductClass: 'generator',
            needAction: 'continue',
            selectionGoal: 'preliminary_fit',
            alternativePolicy: 'exact_only',
            reusePreviousCards: true,
            maxCards: 2,
            powerSource: 'fuel',
            phase: 'single_phase',
            requirements: [{
              id: 'comparison-scope',
              kind: 'comparison_scope',
              value: 'only_tss_sgg_5000n_and_bison_bs6250ie',
              unit: null,
              role: 'hard_constraint',
              strictness: 'strict',
              relation: 'must_have',
              evidence: 'compare only the two named models',
              verification: { mode: 'product_attribute' }
            }],
            rationale: 'compare only the two products selected by the buyer'
          },
          grounding: {
            sourcePolicy: 'catalog_required',
            taskType: 'comparison',
            technicalAttributes: ['nominal power', 'generator type'],
            webPurpose: 'technical_specs',
            webRequirement: 'conditional_on_catalog_gap',
            requiredToolKinds: ['catalog.getProductDetails', 'web.researchProductFacts'],
            rationale: 'the catalog contains the exact products and the facts needed for this comparison'
          },
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        expect(input.toolResults).toEqual([
          expect.objectContaining({ requestId: 'catalog:exact-comparison', tool: 'catalog.getProductDetails', status: 'ok' }),
          expect.objectContaining({
            tool: 'web.researchProductFacts',
            status: 'ok',
            payload: expect.objectContaining({
              usedWebSearch: false,
              searchDisposition: 'not_needed'
            })
          })
        ]);
        expect(input.products.map((item) => item.id)).toEqual([tss.id, bison.id]);
        return {
          answerText: 'Обе модели дают 5 кВт. TSS дешевле; доплата за BISON дает инверторный тип. Для насоса и болгарки без переплаты предварительно выбрал бы TSS.',
          factsUsed: [{
            factKey: 'catalog.exact_comparison',
            sourceEventIds: ['catalog:exact-comparison'],
            value: 'two verified catalog products'
          }],
          questionsAsked: [],
          toolResultIds: ['catalog:exact-comparison'],
          selectedProductIds: [tss.id, bison.id],
          selectionRationale: 'Обе модели дают нужные 5 кВт; TSS дешевле, BISON предлагает инверторный тип.',
          leadAction: 'none',
          riskFlags: [],
          selectionReadiness: {
            status: 'ready_for_preliminary_cards',
            canShowProductCards: true,
            productClass: 'generator',
            missingFacts: [],
            rationale: 'both exact catalog products have the comparison facts needed for a preliminary recommendation'
          }
        };
      }
    };

    const conversations = new FakeConversations();
    conversations.messages = [message('Compare only TSS SGG 5000N and BISON BS6250IE: what do I get for the extra money?')];
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new ExactComparisonProducts() as never,
      { async createLead() { return null; } } as never,
      withStrictToolFixtures(catalogComparisonModel)
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Compare only TSS SGG 5000N and BISON BS6250IE: what do I get for the extra money?'
    });

    expect(extractCatalogProductComparisonFacts).toHaveBeenCalledTimes(1);
    expect(extractCatalogProductComparisonFacts).toHaveBeenCalledWith(expect.objectContaining({
      targetProductNames: ['TSS SGG 5000N', 'BISON BS6250IE'],
      comparisonAttributes: ['nominal power', 'generator type']
    }));
    expect(researchProductComparisonFacts).not.toHaveBeenCalled();
    expect(payload.usedWebSearch).toBe(false);
    expect(payload.answer).toContain('предварительно выбрал бы TSS');
    expect(payload.productCards.map((card) => card.id)).toEqual([tss.id, bison.id]);
    expect(payload.metadata?.intentContract).toMatchObject({
      grounding: {
        sourcePolicy: 'catalog_required',
        webRequirement: 'conditional_on_catalog_gap'
      },
      riskFlags: expect.not.arrayContaining(['planner_repaired_requested_attribute_conditional_web'])
    });
    expect(payload.metadata?.intentContract).not.toMatchObject({
      riskFlags: expect.arrayContaining(['planner_repaired_exact_model_evidence'])
    });
  });

  it('keeps a missing exact-candidate attribute unknown after repaired conditional research times out', async () => {
    researchProductComparisonFacts.mockClear();
    const confirmed = product('firman-rd3910e', 'FIRMAN RD3910E', {
      automatic_start: true,
      nominal_power_kw: 5.5
    });
    const unresolved = product('firman-rd4910e', 'FIRMAN RD4910E', {
      nominal_power_kw: 6.0
    });
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: false,
      searchDisposition: 'timed_out',
      sourcesExhausted: false,
      sourceAttempts: [{ tier: 'catalog', outcome: 'confirmed' }],
      facts: [{
        productName: confirmed.name,
        attribute: 'automatic start',
        value: 'yes',
        sourceType: 'catalog',
        confidence: 'high',
        evidence: 'automatic_start: true',
        sourceUrl: confirmed.sourceUrl,
        sourceTitle: confirmed.name
      }],
      conflicts: [],
      answerGuidance: {
        directAnswer: 'Automatic start is confirmed only for FIRMAN RD3910E.',
        completeness: 'partially_answered',
        coverage: [{
          attribute: 'automatic start',
          status: 'confirmed',
          value: 'yes',
          evidence: 'FIRMAN RD3910E catalog card',
          sourceUrl: confirmed.sourceUrl,
          sourceTitle: confirmed.name
        }, {
          attribute: 'automatic start',
          status: 'not_confirmed',
          value: '',
          evidence: 'FIRMAN RD4910E external verification timed out',
          sourceTitle: unresolved.name
        }]
      },
      summaryForAnswer: 'One exact target remains unresolved.',
      warnings: ['web_research_timed_out_after_catalog_extraction']
    });

    class ExactProductsWithGap extends FakeProducts {
      async getProductsByIds(ids: string[]) {
        return [confirmed, unresolved].filter((item) => ids.includes(item.id));
      }
      async searchProducts() {
        return [confirmed, unresolved];
      }
    }

    const gapModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'compare automatic start on FIRMAN RD3910E and FIRMAN RD4910E',
          dialogueUnderstanding: 'the buyer needs one exact technical attribute for two exact catalog candidates',
          nextStepRationale: 'read exact catalog cards, then verify only the unresolved automatic-start fact',
          requiresTools: true,
          toolRequests: [{
            id: 'catalog:automatic-start-comparison',
            tool: 'catalog.getProductDetails',
            args: {
              productIds: [confirmed.id, unresolved.id],
              productNames: [confirmed.name, unresolved.name],
              productIntent: 'generator',
              canonicalProductIntent: 'generator',
              comparisonAttributes: ['automatic start']
            },
            rationale: 'read both exact current catalog cards',
            required: true
          }, {
            id: 'web:automatic-start-comparison',
            tool: 'web.researchProductFacts',
            args: {
              query: 'FIRMAN RD3910E FIRMAN RD4910E automatic start',
              productNames: [confirmed.name, unresolved.name],
              productIntent: 'generator',
              canonicalProductIntent: 'generator',
              comparisonAttributes: ['automatic start']
            },
            rationale: 'verify automatic start only where the exact catalog cards remain incomplete',
            required: true
          }],
          productMentions: [confirmed, unresolved].map((item) => ({
            name: item.name,
            role: 'comparison_subject' as const,
            productClass: 'generator',
            evidence: `exact comparison target ${item.name}`
          })),
          selectionPolicy: {
            targetProductClass: 'generator',
            canonicalProductClass: 'generator',
            selectionGoal: 'preliminary_fit',
            needAction: 'continue',
            alternativePolicy: 'exact_only',
            reusePreviousCards: false,
            maxCards: 2,
            powerSource: 'fuel',
            phase: 'single_phase',
            requirements: [],
            rationale: 'keep both exact candidates preliminary while one fact is unresolved'
          },
          grounding: {
            taskType: 'comparison',
            sourcePolicy: 'catalog_required',
            webPurpose: 'technical_specs',
            webRequirement: 'conditional_on_catalog_gap',
            requiredToolKinds: ['catalog.getProductDetails', 'web.researchProductFacts'],
            technicalAttributes: ['automatic start'],
            buyerQuestion: 'Do both exact models support automatic start?',
            rationale: 'catalog first; missing exact technical facts require bounded external verification'
          },
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        const webResult = input.toolResults.find((result) => result.tool === 'web.researchProductFacts');
        expect(webResult).toMatchObject({
          status: 'ok',
          payload: {
            usedWebSearch: false,
            searchDisposition: 'timed_out',
            sourcesExhausted: false,
            researchOutcome: 'partial',
            unconfirmedFacts: [{
              attribute: 'automatic start',
              status: 'not_confirmed',
              reason: expect.stringContaining(unresolved.name)
            }]
          }
        });
        return {
          answerText: 'Automatic start remains unconfirmed for FIRMAN RD4910E; the missing fact is still unknown.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: input.toolResults.map((result) => result.requestId),
          selectedProductIds: [],
          leadAction: 'none',
          riskFlags: [],
          selectionReadiness: {
            status: 'needs_more_info',
            canShowProductCards: false,
            productClass: 'generator',
            missingFacts: ['FIRMAN RD4910E automatic start'],
            rationale: 'the unresolved fact is explicit and does not become a negative compatibility claim'
          }
        };
      }
    };
    const conversations = new FakeConversations();
    conversations.messages = [message('Do both FIRMAN RD3910E and FIRMAN RD4910E support automatic start?')];
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new ExactProductsWithGap() as never,
      {} as never,
      withStrictToolFixtures(gapModel)
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Do both FIRMAN RD3910E and FIRMAN RD4910E support automatic start?'
    });

    expect(researchProductComparisonFacts).toHaveBeenCalledTimes(1);
    expect(researchProductComparisonFacts).toHaveBeenCalledWith(expect.objectContaining({
      allowCatalogOnlyAnswer: true,
      targetProductNames: [confirmed.name, unresolved.name],
      comparisonAttributes: ['automatic start']
    }));
    expect(payload.usedWebSearch).toBe(false);
    expect(payload.answer).toContain('remains unconfirmed');
    expect(payload.answer).not.toContain('does not support automatic start');
    expect(payload.productCards).toEqual([]);
  });

  it('executes only the planner-owned web request without synthesizing a catalog tool', async () => {
    researchProductComparisonFacts.mockClear();
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: false,
      searchDisposition: 'not_needed',
      sourcesExhausted: false,
      sourceAttempts: [{ tier: 'catalog', outcome: 'confirmed' }],
      facts: [{
        productName: 'SUMEC FIRMAN 6 kW',
        attribute: 'nominal power',
        value: '5.5 kW',
        sourceType: 'catalog',
        confidence: 'high',
        evidence: 'nominalPowerKw: 5.5',
        sourceUrl: 'https://example.test/sumec',
        sourceTitle: 'SUMEC FIRMAN 6 kW'
      }, {
        productName: 'BISON 6 kW',
        attribute: 'nominal power',
        value: '5.5 kW',
        sourceType: 'catalog',
        confidence: 'high',
        evidence: 'nominalPowerKw: 5.5',
        sourceUrl: 'https://example.test/bison',
        sourceTitle: 'BISON 6 kW'
      }],
      conflicts: [],
      answerGuidance: {
        directAnswer: 'Both exact catalog models have 5.5 kW nominal power.',
        completeness: 'answered',
        coverage: [{
          attribute: 'nominal power',
          status: 'confirmed',
          value: '5.5 kW',
          evidence: 'both exact current catalog cards'
        }]
      },
      summaryForAnswer: 'Both exact catalog cards answer the comparison.',
      warnings: ['catalog_fact_extraction_used', 'web_research_not_needed:catalog_extraction_answered']
    });
    const comparisonModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'compare SUMEC FIRMAN 6 kW and BISON 6 kW',
          dialogueUnderstanding: 'preliminary comparison of two exact named catalog models',
          nextStepRationale: 'compare exact technical attributes',
          requiresTools: true,
          toolRequests: [{
            id: 'web:variable-plan',
            tool: 'web.researchProductFacts',
            args: {
              query: 'SUMEC FIRMAN 6 kW BISON 6 kW nominal power',
              productIntent: 'generator',
              canonicalProductIntent: 'generator',
              productNames: ['SUMEC FIRMAN 6 kW', 'BISON 6 kW'],
              comparisonAttributes: ['nominal power'],
              limit: 2
            },
            rationale: 'planner variably treated exact specs as independent web facts',
            required: true
          }],
          productMentions: [{
            name: 'SUMEC FIRMAN 6 kW',
            role: 'comparison_subject',
            productClass: 'generator',
            evidence: 'SUMEC FIRMAN 6 kW'
          }, {
            name: 'BISON 6 kW',
            role: 'comparison_subject',
            productClass: 'generator',
            evidence: 'BISON 6 kW'
          }],
          selectionPolicy: {
            targetProductClass: 'generator',
            canonicalProductClass: 'generator',
            selectionGoal: 'preliminary_fit',
            needAction: 'continue',
            alternativePolicy: 'exact_only',
            reusePreviousCards: false,
            maxCards: 2,
            powerSource: 'fuel',
            phase: 'single_phase',
            requirements: [],
            rationale: 'compare only the exact named products'
          },
          grounding: {
            taskType: 'comparison',
            sourcePolicy: 'web_required',
            webPurpose: 'technical_specs',
            webRequirement: 'independent_required',
            requiredToolKinds: ['web.researchProductFacts'],
            technicalAttributes: ['nominal power'],
            rationale: 'planner requested exact-model technical verification'
          },
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        expect(input.toolResults.map((result) => result.tool)).toEqual(['web.researchProductFacts']);
        return {
          answerText: 'Both exact models have 5.5 kW nominal power according to their current catalog cards.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: input.toolResults.map((result) => result.requestId),
          selectedProductIds: [],
          leadAction: 'none',
          riskFlags: [],
          selectionReadiness: {
            status: 'ready_for_preliminary_cards',
            canShowProductCards: true,
            productClass: 'generator',
            missingFacts: [],
            rationale: 'both exact catalog cards support the comparison'
          }
        };
      }
    };
    const conversations = new FakeConversations();
    conversations.messages = [message('Compare SUMEC FIRMAN 6 kW and BISON 6 kW by nominal power.')];
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      {} as never,
      withStrictToolFixtures(comparisonModel)
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Compare SUMEC FIRMAN 6 kW and BISON 6 kW by nominal power.'
    });

    expect(researchProductComparisonFacts).toHaveBeenCalledWith(expect.objectContaining({
      allowCatalogOnlyAnswer: false,
      targetProductNames: ['SUMEC FIRMAN 6 kW', 'BISON 6 kW'],
      products: expect.arrayContaining([
        expect.objectContaining({ id: 'sumec' }),
        expect.objectContaining({ id: 'bison' })
      ])
    }));
    expect(payload.usedWebSearch).toBe(false);
    expect(payload.metadata?.intentContract).toMatchObject({
      grounding: {
        sourcePolicy: 'web_required',
        webRequirement: 'independent_required'
      },
      riskFlags: expect.not.arrayContaining(['preliminary_exact_comparison_catalog_first_reconciled'])
    });
  });

  it('binds visible comparison targets to products, runs web research, and records conflicts', async () => {
    researchProductComparisonFacts.mockResolvedValue({
      usedWebSearch: true,
      facts: [{
        productName: 'SUMEC FIRMAN 6 kW',
        attribute: 'noiseDb',
        value: '74 dB',
        sourceType: 'catalog',
        confidence: 'high',
        evidence: 'catalog'
      }],
      conflicts: [{
        productName: 'SUMEC FIRMAN 6 kW',
        attribute: 'noiseDb',
        catalogValue: '74 dB',
        webValues: ['76 dB'],
        resolution: 'catalog conflicts with one web source; disclose uncertainty'
      }],
      summaryForAnswer: 'Use catalog value and disclose conflict.',
      warnings: []
    });
    const conversations = new FakeConversations();
    const products = new FakeProducts();
    const orchestrator = new AgentManagerOrchestrator(conversations as never, products as never, {} as never, withStrictToolFixtures(model()));

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Compare SUMEC and BISON generators by power and noise.'
    });

    expect(payload.usedWebSearch).toBe(true);
    expect(researchProductComparisonFacts).toHaveBeenCalledWith(expect.objectContaining({
      allowCatalogOnlyAnswer: false,
      products: expect.arrayContaining([
        expect.objectContaining({ name: 'SUMEC FIRMAN 6 kW' }),
        expect.objectContaining({ name: 'BISON 6 kW' })
      ])
    }));
    expect(products.recordedIssues).toEqual([expect.objectContaining({
      issueType: 'web_catalog_conflict',
      fieldName: 'noiseDb'
    })]);
  });

  it('uses typed request provenance when web research follows another unfamiliar product class', async () => {
    const trackProducts: Product[] = [{
      ...product('track-1', 'Гусеница 180 мм', {}, 'Accessory for a mini dumper'),
      category: 'Гусеницы для мини-думперов'
    }, {
      ...product('track-2', 'Гусеница 200 мм', {}, 'Accessory for a mini dumper'),
      category: 'Гусеницы для мини-думперов'
    }];
    const miniDumper: Product = {
      ...product('mini-dumper-1', 'Мини-думпер TEST 500', { payloadKg: 500 }),
      category: 'Мини-думперы'
    };
    class UnfamiliarClassProducts extends FakeProducts {
      queries: string[] = [];
      explicitPrimaryCalls = 0;
      webPrimaryCalls = 0;
      override async searchProducts(query?: string) {
        this.queries.push(query ?? '');
        if (query?.includes('гусениц')) return trackProducts;
        if (query?.trim() === 'мини-думперы') {
          this.explicitPrimaryCalls += 1;
          throw new Error('explicit primary catalog lookup temporarily unavailable');
        }
        this.webPrimaryCalls += 1;
        return [miniDumper];
      }
    }
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: true,
      searchDisposition: 'completed',
      sourcesExhausted: false,
      sourceAttempts: [{ tier: 'catalog', outcome: 'confirmed' }],
      facts: [],
      conflicts: [],
      summaryForAnswer: 'Mini dumper facts were researched without accessory candidates.',
      warnings: []
    });
    const unfamiliarModel: AgentManagerModel = {
      ...model(),
      async proposeLedgerDelta() {
        return { rationale: 'continue the current unfamiliar product request', events: [] };
      },
      async planTurn() {
        return {
          userMessageSummary: 'buyer requests a mini dumper and asks about a track accessory',
          dialogueUnderstanding: 'mini dumper is primary; the track is a separate unfamiliar product class',
          nextStepRationale: 'search each typed class separately and research only the primary class',
          requiresTools: true,
          toolRequests: [{
            id: 'catalog:track-first',
            tool: 'catalog.search',
            args: {
              query: 'гусеница для мини-думпера',
              productIntent: 'гусеница для мини-думпера'
            },
            rationale: 'find the separately requested accessory',
            required: true
          }, {
            id: 'web:mini-dumper',
            tool: 'web.researchProductFacts',
            args: {
              query: 'мини-думпер грузоподъемность',
              productIntent: 'мини-думпер',
              productNames: [],
              comparisonAttributes: ['грузоподъемность']
            },
            rationale: 'research only the primary unfamiliar product class',
            required: true
          }, {
            id: 'catalog:mini-dumper-after-web',
            tool: 'catalog.search',
            args: {
              query: 'мини-думперы',
              productIntent: 'мини-думпер'
            },
            rationale: 'satisfy the primary catalog requirement',
            required: true
          }],
          productMentions: [{
            name: 'гусеница для мини-думпера',
            role: 'target_product',
            productClass: 'гусеница для мини-думпера',
            evidence: 'гусеницу для мини-думпера'
          }],
          selectionPolicy: {
            targetProductClass: 'мини-думпер',
            canonicalProductClass: null,
            selectionGoal: 'browse_catalog',
            needAction: 'continue',
            alternativePolicy: 'same_class_only',
            reusePreviousCards: false,
            maxCards: 4,
            powerSource: 'any',
            phase: 'any',
            requirements: [],
            rationale: 'keep the unfamiliar primary and accessory classes distinct'
          },
          grounding: {
            taskType: 'product_selection',
            sourcePolicy: 'web_required',
            webPurpose: 'technical_specs',
            webRequirement: 'independent_required',
            catalogRequirement: 'required',
            requiredToolKinds: ['catalog.search', 'web.researchProductFacts'],
            technicalAttributes: ['грузоподъемность'],
            rationale: 'catalog and web facts are required for the unfamiliar primary class'
          },
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'Мини-думпер найден отдельно от гусениц.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['catalog:track-first', 'web:mini-dumper', 'catalog:mini-dumper-after-web'],
          selectedProductIds: [],
          leadAction: 'none',
          riskFlags: [],
          selectionReadiness: {
            productClass: 'unknown',
            status: 'needs_more_info',
            canShowProductCards: false,
            missingFacts: [],
            rationale: 'The test verifies execution scoping rather than card classification.'
          }
        };
      }
    };
    const conversations = new FakeConversations();
    const userMessage = 'Покажите мини-думперы и гусеницу для мини-думпера.';
    conversations.messages = [message(userMessage)];
    const products = new UnfamiliarClassProducts();
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      products as never,
      {} as never,
      withStrictToolFixtures(unfamiliarModel)
    );

    await orchestrator.generateAnswer({ sessionId, turnId, userMessage });

    expect(researchProductComparisonFacts).toHaveBeenCalledWith(expect.objectContaining({
      products: [expect.objectContaining({ id: miniDumper.id })],
      targetProductNames: [],
      comparisonAttributes: ['грузоподъемность'],
      catalogSearchAttempted: true,
      catalogProductsFound: true
    }));
    expect(researchProductComparisonFacts.mock.calls[0]?.[0].products).not.toEqual(
      expect.arrayContaining(trackProducts.map((item) => expect.objectContaining({ id: item.id })))
    );
    expect(products.explicitPrimaryCalls).toBeGreaterThan(0);
    expect(products.webPrimaryCalls).toBeGreaterThan(0);
  });
});
