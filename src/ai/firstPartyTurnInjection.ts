/**
 * Deterministic first-party URL turn injection (F04/F06).
 *
 * A buyer-supplied first-party URL is first-class evidence: the turn must read it
 * directly before any absence claim. This helper is pure deterministic code (no LLM,
 * no regex) and runs at plan time plus inside continuation validation.
 */
import { createHash } from 'node:crypto';
import type { ToolResult } from './agentManagerContracts.js';
import type { AgentIntentContract, ToolRequest } from './agentManagerContracts.js';
import { extractEvidenceInput } from './evidenceInput.js';

/** Stable across restarts so checkpoint replay rebinds the same persisted artifacts. */
function requestIdFor(canonicalUrl: string): string {
  return 'first-party-page-' + createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 16);
}

export function firstPartyUrlsFromMessage(userMessage: string): string[] {
  return extractEvidenceInput(userMessage).urls
    .filter((url) => url.firstParty)
    .map((url) => url.canonical);
}

function readCanonicalUrls(toolResults: ToolResult[]): Set<string> {
  const read = new Set<string>();
  for (const result of toolResults) {
    if (result.tool !== 'site.readFirstPartyPage' || result.status !== 'ok') continue;
    const canonical = (result.payload as { canonicalUrl?: unknown }).canonicalUrl;
    if (typeof canonical === 'string' && canonical) read.add(canonical);
  }
  return read;
}

/** First-party URLs from the message with no successful page read yet. */
export function unreadFirstPartyUrls(userMessage: string, toolResults: ToolResult[]): string[] {
  const read = readCanonicalUrls(toolResults);
  const unread: string[] = [];
  for (const canonical of firstPartyUrlsFromMessage(userMessage)) {
    if (!read.has(canonical) && !unread.includes(canonical)) unread.push(canonical);
  }
  return unread;
}

function plannedPageUrls(intent: AgentIntentContract): Set<string> {
  const planned = new Set<string>();
  for (const request of intent.toolRequests) {
    if (request.tool !== 'site.readFirstPartyPage') continue;
    const url = typeof request.args.url === 'string' ? request.args.url.trim() : '';
    if (url) planned.add(url);
  }
  return planned;
}

/**
 * Appends deterministic `site.readFirstPartyPage` requests for buyer-supplied
 * first-party URLs that no planned request covers yet. Never duplicates, never
 * removes planner requests.
 */
export function injectFirstPartyPageReads(
  intent: AgentIntentContract,
  userMessage: string
): AgentIntentContract {
  const planned = plannedPageUrls(intent);
  const additions: ToolRequest[] = [];
  for (const canonical of firstPartyUrlsFromMessage(userMessage)) {
    if (planned.has(canonical)) continue;
    planned.add(canonical);
    additions.push({
      id: requestIdFor(canonical),
      tool: 'site.readFirstPartyPage',
      args: {
        url: canonical,
        reason: 'Buyer-supplied first-party URL is first-class evidence and must be read directly before any absence claim.'
      },
      rationale: 'Read the buyer-supplied first-party page directly; a catalog text search cannot substitute for it.',
      required: true,
      coversRequirementIds: []
    });
  }
  if (!additions.length) return intent;
  return { ...intent, requiresTools: true, toolRequests: [...intent.toolRequests, ...additions] };
}
