import type { Product, ProductSelectionClass } from '../shared/types.js';
import { extractStructuredProductAttributes } from './productAttributeExtraction.js';

export type RequirementStrictness = 'hard' | 'strict' | 'soft' | 'buyerApprovedAlternative';

export interface BuyerRequirementItem {
  kind: string;
  value: unknown;
  evidence: string;
  strictness?: RequirementStrictness;
}

export interface BuyerRequirementContract {
  buyerGoal: string;
  targetProductClass: ProductSelectionClass;
  hardRequirements: BuyerRequirementItem[];
  softRequirements: BuyerRequirementItem[];
  allowedCompromises: BuyerRequirementItem[];
  forbiddenRecommendations: BuyerRequirementItem[];
  criticalAttributes: string[];
  budgetPolicy?: {
    maxRub?: number;
    strictness?: RequirementStrictness;
    allowSlightlyAboveWhenFewMatches?: boolean;
  };
  topicAction: 'continue_current_need' | 'new_need' | 'return_to_previous_need' | 'ambiguous';
  rationale: string;
}

export type SuitabilityStatus = 'match' | 'soft_match' | 'compromise' | 'reject' | 'unresolved';

export interface ProductSuitabilityDecision {
  product: Product;
  status: SuitabilityStatus;
  hardRequirementViolations: string[];
  softTradeoffs: string[];
  customerFacingReason: string;
  internalReason: string;
  evidenceRefs: string[];
  cardLabelHint: 'match' | 'compromise' | 'do_not_show' | 'needs_evidence';
  score: number;
}

export interface ProductCandidateSet {
  primaryCandidates: Product[];
  nearBudgetCandidates: Product[];
  needsEvidenceCandidates: Product[];
  rejectedEarly: Array<{ product: Product; reason: string }>;
  audit: {
    totalProducts: number;
    sameClassCandidates: number;
    primaryCandidateCount: number;
    nearBudgetCandidateCount: number;
    rejectedEarlyCount: number;
  };
}

function categoryMatches(product: Product, productClass: ProductSelectionClass): boolean {
  const text = `${product.category ?? ''} ${product.name}`.toLocaleLowerCase('ru');
  if (productClass === 'plate') return text.includes('виброплит') || text.includes('plate');
  if (productClass === 'generator') {
    return (
      text.includes('генератор') ||
      text.includes('электростанц') ||
      text.includes('generator')
    ) && !text.includes('свароч');
  }
  if (productClass === 'weldingGenerator') {
    const weldingIndex = text.indexOf('свароч');
    const generatorIndex = text.indexOf('генератор', weldingIndex + 'свароч'.length);
    return (weldingIndex >= 0 && generatorIndex >= 0) || text.includes('welding');
  }
  if (productClass === 'unknown') return true;
  return true;
}

function price(product: Product): number | null {
  return typeof product.price === 'number' && Number.isFinite(product.price) ? product.price : null;
}

function weightKg(product: Product): number | null {
  const value = extractStructuredProductAttributes(product).weightKg?.value;
  return typeof value === 'number' ? value : null;
}

function forceKn(product: Product): number | null {
  const value = extractStructuredProductAttributes(product).centrifugalForceKn?.value;
  return typeof value === 'number' ? value : null;
}

function budgetMax(requirements: BuyerRequirementContract): number | undefined {
  if (requirements.budgetPolicy?.maxRub) return requirements.budgetPolicy.maxRub;
  const hardBudget = requirements.hardRequirements.find((item) => item.kind === 'budgetMaxRub');
  return typeof hardBudget?.value === 'number' ? hardBudget.value : undefined;
}

function hasSoftRequirement(requirements: BuyerRequirementContract, kind: string): boolean {
  return requirements.softRequirements.some((item) => item.kind === kind && item.value !== false);
}

function allowsCompromise(requirements: BuyerRequirementContract, kind: string): boolean {
  return requirements.allowedCompromises.some((item) => item.kind === kind && item.value !== false);
}

export function buildProductCandidateSet(input: {
  products: Product[];
  requirements: BuyerRequirementContract;
  uiSafeCap?: number;
}): ProductCandidateSet {
  const maxRub = budgetMax(input.requirements);
  const sameClass: Product[] = [];
  const rejectedEarly: ProductCandidateSet['rejectedEarly'] = [];

  for (const product of input.products) {
    if (categoryMatches(product, input.requirements.targetProductClass)) {
      sameClass.push(product);
    } else {
      rejectedEarly.push({ product, reason: 'wrong_product_class' });
    }
  }

  const primaryCandidates: Product[] = [];
  const nearBudgetCandidates: Product[] = [];
  const needsEvidenceCandidates: Product[] = [];
  const nearBudgetLimit = maxRub ? maxRub * 1.35 : undefined;

  for (const product of sameClass) {
    const productPrice = price(product);
    const missingCritical = input.requirements.criticalAttributes.some((attribute) => {
      const attrs = extractStructuredProductAttributes(product);
      return attribute in attrs === false;
    });
    if (missingCritical) needsEvidenceCandidates.push(product);

    if (maxRub && productPrice && productPrice > maxRub) {
      if (nearBudgetLimit && productPrice <= nearBudgetLimit) nearBudgetCandidates.push(product);
      else rejectedEarly.push({ product, reason: 'far_above_budget' });
      continue;
    }
    primaryCandidates.push(product);
  }

  return {
    primaryCandidates,
    nearBudgetCandidates,
    needsEvidenceCandidates,
    rejectedEarly,
    audit: {
      totalProducts: input.products.length,
      sameClassCandidates: sameClass.length,
      primaryCandidateCount: primaryCandidates.length,
      nearBudgetCandidateCount: nearBudgetCandidates.length,
      rejectedEarlyCount: rejectedEarly.length
    }
  };
}

export function classifyProductSuitability(input: {
  product: Product;
  requirements: BuyerRequirementContract;
  matchContext?: { inBudgetMatchCount?: number };
}): ProductSuitabilityDecision {
  const productPrice = price(input.product);
  const maxRub = budgetMax(input.requirements);
  const productWeight = weightKg(input.product);
  const productForce = forceKn(input.product);
  const hardRequirementViolations: string[] = [];
  const softTradeoffs: string[] = [];
  let status: SuitabilityStatus = 'match';
  let score = 100;

  if (maxRub && productPrice && productPrice > maxRub) {
    if (productPrice > maxRub * 1.35) {
      hardRequirementViolations.push(`цена ${productPrice} ₽ сильно выше бюджета ${maxRub} ₽`);
      status = 'reject';
      score -= 100;
    } else if (input.requirements.budgetPolicy?.allowSlightlyAboveWhenFewMatches && (input.matchContext?.inBudgetMatchCount ?? 0) < 3) {
      softTradeoffs.push(`выше бюджета ${maxRub} ₽: цена ${productPrice} ₽`);
      status = 'compromise';
      score -= 25;
    } else {
      hardRequirementViolations.push(`цена ${productPrice} ₽ выше бюджета ${maxRub} ₽`);
      status = 'reject';
      score -= 100;
    }
  }

  if (hasSoftRequirement(input.requirements, 'notTooHeavy') && productWeight !== null && productWeight >= 70 && productWeight <= 75) {
    const tradeoff = `${productWeight} кг тяжелее лёгких 54–60 кг, зато может трамбовать увереннее`;
    softTradeoffs.push(tradeoff);
    if (status !== 'reject') status = 'compromise';
    score -= 15;
  }

  if (hasSoftRequirement(input.requirements, 'notTooHeavy') && productWeight !== null && productWeight > 90) {
    hardRequirementViolations.push(`${productWeight} кг слишком тяжело для запроса “не тяжёлая”`);
    status = 'reject';
    score -= 100;
  }

  if (productForce !== null && productForce >= 10) score += 8;
  if (productWeight !== null && productWeight >= 54 && productWeight <= 65) score += 10;

  const customerFacingReason = status === 'compromise'
    ? softTradeoffs.join('; ')
    : status === 'reject'
      ? hardRequirementViolations.join('; ')
      : 'подходит под задачу и основные ограничения';

  return {
    product: input.product,
    status,
    hardRequirementViolations,
    softTradeoffs,
    customerFacingReason,
    internalReason: [customerFacingReason, allowsCompromise(input.requirements, 'slightlyHeavierForBetterCompaction') ? 'buyer_allows_compaction_tradeoff' : ''].filter(Boolean).join('; '),
    evidenceRefs: [],
    cardLabelHint: status === 'reject' ? 'do_not_show' : status === 'compromise' ? 'compromise' : 'match',
    score
  };
}

function originalOrder(decisions: ProductSuitabilityDecision[], productId: string): number {
  return decisions.findIndex((decision) => decision.product.id === productId);
}

export function selectProductsBySuitability(input: {
  decisions: ProductSuitabilityDecision[];
  uiSafeCap: number;
  minimumGoodMatchesBeforeCompromises?: number;
}): ProductSuitabilityDecision[] {
  const minimumMatches = input.minimumGoodMatchesBeforeCompromises ?? 3;
  const goodMatches = input.decisions
    .filter((decision) => decision.status === 'match' || decision.status === 'soft_match')
    .sort((left, right) => right.score - left.score || originalOrder(input.decisions, left.product.id) - originalOrder(input.decisions, right.product.id));

  const compromises = input.decisions
    .filter((decision) => decision.status === 'compromise')
    .sort((left, right) => right.score - left.score || originalOrder(input.decisions, left.product.id) - originalOrder(input.decisions, right.product.id));

  if (goodMatches.length >= minimumMatches) return goodMatches.slice(0, input.uiSafeCap);
  return [...goodMatches, ...compromises].slice(0, input.uiSafeCap);
}
