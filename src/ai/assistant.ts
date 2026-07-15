import { ConversationRepository, LeadRepository, ProductRepository } from '../db/repositories.js';
import {
  AgentManagerOrchestrator,
  type AgentManagerGenerateInput,
  type AgentManagerRecoverInput
} from './agentManagerOrchestrator.js';

/**
 * Route-facing adapter for the sole AI-manager runtime.
 * Semantic planning, tools, answer generation, review and recovery all live in
 * AgentManagerOrchestrator; no alternative writer or legacy fallback exists.
 */
export class AssistantService {
  private readonly agentManager: AgentManagerOrchestrator;

  constructor(
    conversations = new ConversationRepository(),
    products = new ProductRepository(),
    leads = new LeadRepository()
  ) {
    this.agentManager = new AgentManagerOrchestrator(conversations, products, leads);
  }

  generateAnswer(input: AgentManagerGenerateInput) {
    return this.agentManager.generateAnswer(input);
  }

  recoverTurn(input: AgentManagerRecoverInput) {
    return this.agentManager.recoverTurn(input);
  }
}
