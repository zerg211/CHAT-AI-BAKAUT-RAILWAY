import type { Message, Product } from '../shared/types.js';

interface StatedFact {
  productId: string;
  productName: string;
  attribute: string;
  value: string;
  turn: number;
}

export class ConsistencyGuard {
  private facts: StatedFact[] = [];
  private turnCounter = 0;

  recordFacts(products: Product[], answerText: string) {
    this.turnCounter++;
    const lower = answerText.toLowerCase();
    for (const product of products) {
      const name = product.name?.toLowerCase() ?? '';
      if (!lower.includes(name.slice(0, Math.min(name.length, 15)))) continue;

      if (product.price != null) {
        const priceStr = String(product.price);
        if (lower.includes(priceStr)) {
          this.addFact(product.id, product.name, 'price', priceStr);
        }
      }

      if (product.specs && typeof product.specs === 'object') {
        for (const [key, val] of Object.entries(product.specs as Record<string, unknown>)) {
          if (val == null) continue;
          const valStr = String(val).toLowerCase();
          if (valStr.length >= 2 && valStr.length <= 30 && lower.includes(valStr)) {
            this.addFact(product.id, product.name, key, valStr);
          }
        }
      }
    }
  }

  private addFact(productId: string, productName: string, attribute: string, value: string) {
    const existing = this.facts.find(
      (f) => f.productId === productId && f.attribute === attribute
    );
    if (existing) {
      existing.value = value;
      existing.turn = this.turnCounter;
    } else {
      this.facts.push({ productId, productName, attribute, value, turn: this.turnCounter });
    }
  }

  buildConsistencyContext(): string {
    if (!this.facts.length) return '';
    const grouped = new Map<string, StatedFact[]>();
    for (const fact of this.facts) {
      const key = fact.productName;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(fact);
    }
    const lines: string[] = ['Previously stated facts (do not contradict):'];
    for (const [name, facts] of grouped) {
      const attrs = facts.map((f) => `${f.attribute}: ${f.value}`).join(', ');
      lines.push(`- ${name}: ${attrs}`);
    }
    return lines.join('\n');
  }

  checkAnswer(answerText: string): string[] {
    const warnings: string[] = [];
    const lower = answerText.toLowerCase();
    for (const fact of this.facts) {
      const nameFragment = fact.productName.toLowerCase().slice(0, Math.min(fact.productName.length, 15));
      if (!lower.includes(nameFragment)) continue;

      if (fact.attribute === 'price' && fact.value) {
        const pricePattern = new RegExp(`\\b${fact.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        const hasSamePrice = pricePattern.test(answerText);
        const priceNum = Number(fact.value);
        if (!isNaN(priceNum)) {
          const otherPricePattern = /(\d[\d\s]*\d)\s*(?:₽|руб|р\.)/gi;
          let match: RegExpExecArray | null;
          while ((match = otherPricePattern.exec(answerText)) !== null) {
            const foundPrice = Number(match[1].replace(/\s/g, ''));
            if (!isNaN(foundPrice) && foundPrice !== priceNum && Math.abs(foundPrice - priceNum) / priceNum > 0.01) {
              if (lower.includes(nameFragment)) {
                warnings.push(`Price inconsistency for "${fact.productName}": previously ${fact.value}, now ${foundPrice}`);
              }
            }
          }
        }
        if (!hasSamePrice) continue;
      }
    }
    return warnings;
  }

  restoreFromHistory(history: Message[], products: Product[]) {
    const productMap = new Map(products.map((p) => [p.id, p]));
    for (const msg of history) {
      if (msg.role === 'assistant' && msg.content) {
        this.turnCounter++;
        for (const product of productMap.values()) {
          const name = product.name?.toLowerCase() ?? '';
          if (msg.content.toLowerCase().includes(name.slice(0, Math.min(name.length, 15)))) {
            if (product.price != null && msg.content.includes(String(product.price))) {
              this.addFact(product.id, product.name, 'price', String(product.price));
            }
          }
        }
      }
    }
  }
}

const sessionGuards = new Map<string, ConsistencyGuard>();

const MAX_GUARDS = 500;

export function getSessionGuard(sessionId: string): ConsistencyGuard {
  let guard = sessionGuards.get(sessionId);
  if (!guard) {
    if (sessionGuards.size >= MAX_GUARDS) {
      const oldest = sessionGuards.keys().next().value;
      if (oldest) sessionGuards.delete(oldest);
    }
    guard = new ConsistencyGuard();
    sessionGuards.set(sessionId, guard);
  }
  return guard;
}

export function cleanupSessionGuard(sessionId: string) {
  sessionGuards.delete(sessionId);
}
