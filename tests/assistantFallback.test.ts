import { describe, expect, it, vi } from 'vitest';
import { emptyNeedState } from '../src/ai/needState.js';
import type { ConversationSession, Message, MessageRole, Product } from '../src/shared/types.js';

const openAiCreate = vi.hoisted(() => vi.fn(async () => {
  throw new Error('unsupported_country_region_territory');
}));

vi.mock('../src/ai/openaiClient.js', () => ({
  createOpenAIClient: () => ({ responses: { create: openAiCreate } }),
  createEmbedding: async () => null,
  withRetry: async <T>(fn: () => Promise<T>) => fn()
}));

const { AssistantService } = await import('../src/ai/assistant.js');

const ru = (value: string) => JSON.parse(`"${value}"`) as string;

function testProduct(id: string, name: string, price: number, specs: Record<string, unknown> = {}): Product {
  return {
    id,
    name,
    category: ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u044b'),
    price,
    currency: 'RUB',
    sourceUrl: `https://example.test/${id}`,
    specs
  };
}

class FakeConversations {
  readonly messages: Message[] = [];
  session: ConversationSession = {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'active',
    conversationNumber: 1,
    title: '',
    needState: emptyNeedState(),
    historySummary: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString()
  };

  async getSession() {
    return this.session;
  }

  async addMessage(input: { sessionId: string; role: MessageRole; content: string; metadata?: Record<string, unknown> }) {
    const message: Message = {
      id: `msg-${this.messages.length + 1}`,
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      metadata: input.metadata ?? {},
      createdAt: new Date(Date.now() + this.messages.length).toISOString()
    };
    this.messages.push(message);
    return message;
  }

  async listMessages() {
    return this.messages;
  }

  async updateNeedState(_sessionId: string, needState: ConversationSession['needState']) {
    this.session = { ...this.session, needState };
    return this.session;
  }

  async updateSessionTopic() {
    return this.session;
  }
}

class FakeProducts {
  constructor(private readonly products: Product[]) {}

  async searchProducts() {
    return this.products;
  }

  async searchProductsByModelTokens() {
    return [];
  }

  async vectorSearch() {
    return [];
  }

  async listProducts() {
    return this.products;
  }

  async searchCatalogPages() {
    return [];
  }

  async getOpenConflictsForProducts() {
    return [];
  }
}

describe('assistant OpenAI failure fallback', () => {
  it('answers operational delivery and stock questions without waiting for OpenAI planning', async () => {
    openAiCreate.mockClear();
    const products = [
      testProduct('plate-1', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u043f\\u0440\\u044f\\u043c\\u043e\\u0445\\u043e\\u0434\\u043d\\u0430\\u044f 60 \\u043a\\u0433'), 72_000)
    ];
    const conversations = new FakeConversations();
    conversations.messages.push({
      id: 'previous-assistant',
      sessionId: conversations.session.id,
      role: 'assistant',
      content: ru('\\u041f\\u043e\\u043a\\u0430\\u0437\\u0430\\u043b \\u043f\\u043e\\u0434\\u0445\\u043e\\u0434\\u044f\\u0449\\u0443\\u044e \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0443.'),
      metadata: {
        productCards: [{
          id: 'plate-1',
          name: products[0].name,
          category: products[0].category,
          price: products[0].price,
          currency: 'RUB',
          sourceUrl: products[0].sourceUrl,
          specs: {},
          reasons: [ru('\\u041f\\u043e\\u0434\\u0445\\u043e\\u0434\\u0438\\u0442 \\u043f\\u043e \\u0442\\u0435\\u043a\\u0443\\u0449\\u0435\\u0439 \\u0437\\u0430\\u0434\\u0430\\u0447\\u0435')],
          caveats: []
        }]
      },
      createdAt: new Date().toISOString()
    });
    const assistant = new AssistantService(conversations as never, new FakeProducts(products) as never);

    const payload = await assistant.generateAnswer({
      sessionId: conversations.session.id,
      userMessage: ru('\\u0410 \\u0441\\u043a\\u043e\\u043b\\u044c\\u043a\\u043e \\u0434\\u043e\\u0441\\u0442\\u0430\\u0432\\u043a\\u0430 \\u0438 \\u0435\\u0441\\u0442\\u044c \\u043b\\u0438 \\u0442\\u043e\\u0447\\u043d\\u043e \\u0432 \\u043d\\u0430\\u043b\\u0438\\u0447\\u0438\\u0438? \\u041c\\u043e\\u0433\\u0443 \\u043e\\u0441\\u0442\\u0430\\u0432\\u0438\\u0442\\u044c \\u0442\\u0435\\u043b\\u0435\\u0444\\u043e\\u043d.'),
      onDelta: vi.fn()
    });

    expect(openAiCreate).not.toHaveBeenCalled();
    expect(payload.leadRequested).toBe(true);
    expect(payload.productCards.map((card) => card.id)).toEqual(['plate-1']);
    expect(payload.metadata?.operationalHandoff).toBe(true);
    expect(payload.metadata?.aiDiagnostics?.answerGenerationFallback).toMatchObject({ used: false });
    expect(payload.answer).toContain(ru('\\u041e\\u0441\\u0442\\u0430\\u0432\\u044c\\u0442\\u0435'));
    expect(payload.answer).toContain(ru('\\u043d\\u0430\\u043b\\u0438\\u0447\\u0438\\u0435'));
    expect(payload.answer).toContain(ru('\\u0434\\u043e\\u0441\\u0442\\u0430\\u0432\\u043a\\u0443'));
    expect(payload.answer).not.toContain(ru('\\u041e\\u0440\\u0438\\u0435\\u043d\\u0442\\u0438\\u0440'));
  });

  it('does not mask OpenAI failures as a normal catalog recommendation', async () => {
    openAiCreate.mockClear();
    const products = [
      testProduct('fit-1', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 3.0 kW \\u044d\\u043b\\u0435\\u043a\\u0442\\u0440\\u043e\\u0441\\u0442\\u0430\\u0440\\u0442'), 54_000, {
        [ru('\\u041d\\u043e\\u043c\\u0438\\u043d\\u0430\\u043b\\u044c\\u043d\\u0430\\u044f \\u043c\\u043e\\u0449\\u043d\\u043e\\u0441\\u0442\\u044c')]: '3.0 kW',
        [ru('\\u041c\\u0430\\u043a\\u0441\\u0438\\u043c\\u0430\\u043b\\u044c\\u043d\\u0430\\u044f \\u043c\\u043e\\u0449\\u043d\\u043e\\u0441\\u0442\\u044c')]: '3.3 kW',
        start: 'electric starter'
      }),
      testProduct('fit-2', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 3.2 kW \\u044d\\u043b\\u0435\\u043a\\u0442\\u0440\\u043e\\u0441\\u0442\\u0430\\u0440\\u0442'), 61_000, {
        [ru('\\u041d\\u043e\\u043c\\u0438\\u043d\\u0430\\u043b\\u044c\\u043d\\u0430\\u044f \\u043c\\u043e\\u0449\\u043d\\u043e\\u0441\\u0442\\u044c')]: '3.2 kW',
        [ru('\\u041c\\u0430\\u043a\\u0441\\u0438\\u043c\\u0430\\u043b\\u044c\\u043d\\u0430\\u044f \\u043c\\u043e\\u0449\\u043d\\u043e\\u0441\\u0442\\u044c')]: '3.6 kW',
        start: 'electric starter'
      })
    ];
    const conversations = new FakeConversations();
    const assistant = new AssistantService(conversations as never, new FakeProducts(products) as never);

    await expect(assistant.generateAnswer({
      sessionId: conversations.session.id,
      userMessage: ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0434\\u043b\\u044f \\u0434\\u043e\\u043c\\u0430 220 \\u0412. \\u041a\\u043e\\u0442\\u0435\\u043b 150 \\u0412\\u0442, \\u0445\\u043e\\u043b\\u043e\\u0434\\u0438\\u043b\\u044c\\u043d\\u0438\\u043a \\u0438 \\u0441\\u0432\\u0435\\u0442 300 \\u0412\\u0442. \\u041d\\u0443\\u0436\\u0435\\u043d \\u0437\\u0430\\u043f\\u0443\\u0441\\u043a \\u043a\\u043d\\u043e\\u043f\\u043a\\u043e\\u0439, \\u0447\\u0442\\u043e\\u0431\\u044b \\u0436\\u0435\\u043d\\u0430 \\u0441\\u0430\\u043c\\u0430 \\u0437\\u0430\\u043f\\u0443\\u0441\\u043a\\u0430\\u043b\\u0430, \\u0438 \\u043d\\u0435 \\u0448\\u0443\\u043c\\u043d\\u044b\\u0439.'),
      onDelta: vi.fn()
    })).rejects.toThrow(/AI need extraction failed/);

    expect(conversations.messages.filter((message) => message.role === 'assistant')).toHaveLength(0);
  });
});
