export type ConversationStatus = 'active' | 'closed' | 'expired';
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type LeadStatus = 'pending_email' | 'sent_email' | 'email_failed';

export interface ConversationSession {
  id: string;
  status: ConversationStatus;
  conversationNumber: number;
  topic?: string | null;
  title: string;
  visitorId?: string | null;
  pageUrl?: string | null;
  userAgent?: string | null;
  needState: CustomerNeedState;
  historySummary?: string | null;
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt: string;
  closedAt?: string | null;
}

export interface ConversationSummary extends ConversationSession {
  messageCount: number;
  leadCount: number;
  latestMessageAt?: string | null;
  latestUserMessage?: string | null;
  latestAssistantMessage?: string | null;
}

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Product {
  id: string;
  externalId?: string | null;
  slug?: string | null;
  sourceUrl?: string | null;
  name: string;
  brand?: string | null;
  category?: string | null;
  price?: number | null;
  currency?: string | null;
  imageUrl?: string | null;
  description?: string | null;
  specs: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export interface ProductCard {
  id: string;
  name: string;
  brand?: string | null;
  category?: string | null;
  price?: number | null;
  currency?: string | null;
  imageUrl?: string | null;
  sourceUrl?: string | null;
  specs: Record<string, unknown>;
  reasons: string[];
  caveats: string[];
}

export interface ProductFact {
  productId: string;
  attribute: string;
  value: string;
  unit?: string | null;
  sourceType: 'site' | 'csv' | 'web' | 'manual';
  sourceUrl?: string | null;
  confidence: number;
}

export interface CatalogPage {
  id: string;
  sourceUrl: string;
  pageType: string;
  title: string;
  content: string;
  summary?: string | null;
  raw: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogPageInput {
  sourceUrl: string;
  pageType: string;
  title: string;
  content: string;
  summary?: string;
  raw?: Record<string, unknown>;
}

export interface DataConflict {
  id: string;
  productId: string;
  attribute: string;
  values: unknown[];
  status: 'open' | 'resolved' | 'ignored';
  resolution?: Record<string, unknown> | null;
}

export interface Lead {
  id: string;
  sessionId?: string | null;
  name: string;
  phone?: string | null;
  email?: string | null;
  question?: string | null;
  status: LeadStatus;
  createdAt: string;
}

export interface NeedItem {
  value: string;
  evidence: string;
  confidence: number;
  updatedAt: string;
}

export interface CustomerNeedState {
  explicitNeeds: NeedItem[];
  implicitNeeds: NeedItem[];
  constraints: NeedItem[];
  importantCriteria: NeedItem[];
  confirmedFacts: NeedItem[];
  uncertainInferences: NeedItem[];
  contradictions: NeedItem[];
  featureSignals: {
    portable: number;
    homeUse: number;
    compact: number;
    lowNoise: number;
    coldStart: number;
    professionalDuty: number;
    budgetSensitive: number;
  };
  lastSummary: string;
}

export interface ChatResponsePayload {
  answer: string;
  needState: CustomerNeedState;
  productCards: ProductCard[];
  usedWebSearch: boolean;
  leadRequested?: boolean;
  assistantMessageId?: string;
}

export interface CatalogProductInput {
  externalId?: string;
  sourceUrl?: string;
  slug?: string;
  name: string;
  brand?: string;
  category?: string;
  price?: number;
  currency?: string;
  imageUrl?: string;
  description?: string;
  specs?: Record<string, unknown>;
  raw?: Record<string, unknown>;
  sourcePriority?: number;
}
