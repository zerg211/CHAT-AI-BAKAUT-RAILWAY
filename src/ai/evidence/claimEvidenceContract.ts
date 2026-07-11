import type { FactClaim, FactClaimAudit } from '../../shared/types.js';

export type CustomerFacingClaimType =
  | 'stock'
  | 'delivery'
  | 'discount'
  | 'price'
  | 'compatibility'
  | 'spec'
  | 'warranty'
  | 'photo'
  | 'link';

export type EvidenceSource =
  | 'catalog'
  | 'visible_card'
  | 'warehouse'
  | 'manager'
  | 'logistics'
  | 'supplier'
  | 'web'
  | 'manual'
  | 'conversation';

export type CustomerWordingPermission = 'confident' | 'qualified' | 'manager_check_required' | 'forbidden';

export interface CustomerFacingClaim {
  id: string;
  type: CustomerFacingClaimType;
  text: string;
  evidenceIds: string[];
  productId?: string;
  attribute?: string;
}

export interface EvidenceTuple {
  id: string;
  claimType: CustomerFacingClaimType;
  source: EvidenceSource;
  confidence: number;
  productId?: string;
  attribute?: string;
  value?: unknown;
  freshness?: string;
  allowedCustomerWording: CustomerWordingPermission;
}

export interface ClaimEvidenceViolation {
  claimId: string;
  reason:
    | 'missing_evidence'
    | 'claim_wording_exceeds_evidence_permission'
    | 'evidence_type_mismatch'
    | 'evidence_stale'
    | 'evidence_confidence_too_low'
    | 'evidence_product_mismatch'
    | 'evidence_attribute_mismatch'
    | 'stock_claim_requires_live_warehouse_or_manager_evidence'
    | 'delivery_claim_requires_logistics_or_manager_evidence'
    | 'discount_claim_requires_manager_evidence'
    | 'compatibility_claim_requires_product_or_domain_evidence';
  repairAction: string;
}

export interface ClaimEvidenceValidationResult {
  ok: boolean;
  violations: ClaimEvidenceViolation[];
}

export interface ClaimEvidenceValidationOptions {
  now?: Date;
  maxAgeMs?: number;
  minConfidence?: number;
}

const defaultMaxEvidenceAgeMs = 24 * 60 * 60 * 1000;
const defaultMinConfidence = 0.55;

const liveStockSources = new Set<EvidenceSource>(['warehouse', 'manager']);
const deliverySources = new Set<EvidenceSource>(['logistics', 'manager']);
const discountSources = new Set<EvidenceSource>(['manager']);
const compatibilitySources = new Set<EvidenceSource>(['catalog', 'manual', 'supplier', 'manager', 'conversation']);

function wordingPermissionAllowsClaim(evidence: EvidenceTuple[]) {
  return evidence.some((item) => item.allowedCustomerWording === 'confident' || item.allowedCustomerWording === 'qualified');
}

function hasSource(evidence: EvidenceTuple[], sources: Set<EvidenceSource>) {
  return evidence.some((item) => sources.has(item.source));
}

function violation(claimId: string, reason: ClaimEvidenceViolation['reason'], repairAction: string): ClaimEvidenceViolation {
  return { claimId, reason, repairAction };
}

export function validateClaimEvidence(input: {
  claims: CustomerFacingClaim[];
  evidence: EvidenceTuple[];
}, options: ClaimEvidenceValidationOptions = {}): ClaimEvidenceValidationResult {
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeMs ?? defaultMaxEvidenceAgeMs;
  const minConfidence = options.minConfidence ?? defaultMinConfidence;
  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));
  const violations: ClaimEvidenceViolation[] = [];

  for (const claim of input.claims) {
    const referencedEvidence = claim.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((item): item is EvidenceTuple => Boolean(item));

    if (!referencedEvidence.length) {
      violations.push(violation(
        claim.id,
        'missing_evidence',
        'remove the exact claim or rewrite it as an explicit manager-check boundary'
      ));
      continue;
    }

    const claimEvidence = referencedEvidence.filter((item) => item.claimType === claim.type);
    if (!claimEvidence.length) {
      violations.push(violation(
        claim.id,
        'evidence_type_mismatch',
        'attach evidence for the same claim type or downgrade the customer-facing wording'
      ));
      continue;
    }

    if (!wordingPermissionAllowsClaim(claimEvidence)) {
      violations.push(violation(
        claim.id,
        'claim_wording_exceeds_evidence_permission',
        'downgrade confident wording to a manager-check or uncertainty boundary'
      ));
      continue;
    }

    for (const item of claimEvidence) {
      if (item.confidence < minConfidence) {
        violations.push(violation(
          claim.id,
          'evidence_confidence_too_low',
          'use a stronger source or downgrade the claim to an explicit check/uncertainty boundary'
        ));
      }
      if (item.freshness) {
        const freshnessTime = Date.parse(item.freshness);
        if (Number.isFinite(freshnessTime) && now.getTime() - freshnessTime > maxAgeMs) {
          violations.push(violation(
            claim.id,
            'evidence_stale',
            'refresh the evidence before making the customer-facing claim'
          ));
        }
      }
      if (claim.productId && item.productId && claim.productId !== item.productId) {
        violations.push(violation(
          claim.id,
          'evidence_product_mismatch',
          'attach evidence for the same SKU/model or remove the product-specific claim'
        ));
      }
      if (claim.attribute && item.attribute && claim.attribute !== item.attribute) {
        violations.push(violation(
          claim.id,
          'evidence_attribute_mismatch',
          'attach evidence for the same attribute or downgrade the wording'
        ));
      }
    }

    if (claim.type === 'stock' && !hasSource(claimEvidence, liveStockSources)) {
      violations.push(violation(
        claim.id,
        'stock_claim_requires_live_warehouse_or_manager_evidence',
        'separate catalog presence from live stock and offer to check warehouse status'
      ));
    }
    if (claim.type === 'delivery' && !hasSource(claimEvidence, deliverySources)) {
      violations.push(violation(
        claim.id,
        'delivery_claim_requires_logistics_or_manager_evidence',
        'remove exact delivery promise and ask for city/contact only if exact logistics check is needed'
      ));
    }
    if (claim.type === 'discount' && !hasSource(claimEvidence, discountSources)) {
      violations.push(violation(
        claim.id,
        'discount_claim_requires_manager_evidence',
        'replace discount promise with an offer to check individual price through a manager-confirmed flow'
      ));
    }
    if (claim.type === 'compatibility' && !hasSource(claimEvidence, compatibilitySources)) {
      violations.push(violation(
        claim.id,
        'compatibility_claim_requires_product_or_domain_evidence',
        'mark fit as preliminary or ask the decisive compatibility question before recommending'
      ));
    }
  }

  return { ok: violations.length === 0, violations };
}

function commercialClaimType(claim: FactClaim): CustomerFacingClaimType | null {
  if (claim.kind === 'availability') return 'stock';
  if (claim.kind === 'delivery') return 'delivery';
  if (claim.kind === 'discount_or_terms') return 'discount';
  return null;
}

function evidenceSourceFromFactClaim(claim: FactClaim): EvidenceSource | null {
  if (claim.groundingStatus === 'requires_specialist_verification') return 'manager';
  if (claim.groundingStatus !== 'grounded') return null;
  if (claim.requiredSource === 'catalog') return 'catalog';
  if (claim.requiredSource === 'visible_cards') return 'visible_card';
  if (claim.requiredSource === 'web') return 'web';
  if (claim.requiredSource === 'conversation_memory') return 'conversation';
  if (claim.requiredSource === 'specialist') return 'manager';
  return null;
}

function specificCommercialReason(type: CustomerFacingClaimType): ClaimEvidenceViolation['reason'] {
  if (type === 'stock') return 'stock_claim_requires_live_warehouse_or_manager_evidence';
  if (type === 'delivery') return 'delivery_claim_requires_logistics_or_manager_evidence';
  if (type === 'discount') return 'discount_claim_requires_manager_evidence';
  return 'missing_evidence';
}

function normalizedWhitespaceText(value: string) {
  let normalized = '';
  let pendingSpace = false;
  for (const character of value.toLocaleLowerCase('ru')) {
    if (character.trim() === '') {
      pendingSpace = normalized.length > 0;
      continue;
    }
    if (pendingSpace) normalized += ' ';
    normalized += character;
    pendingSpace = false;
  }
  return normalized;
}

function includesAny(text: string, phrases: string[]) {
  return phrases.some((phrase) => text.includes(phrase));
}

function isConfidentCommercialPromise(type: CustomerFacingClaimType, text: string) {
  const normalizedText = normalizedWhitespaceText(text);
  if (type === 'stock') {
    return includesAny(normalizedText, [
      'есть в наличии',
      'на складе',
      'in stock',
      'available now',
      'available today'
    ]);
  }
  if (type === 'delivery') {
    return includesAny(normalizedText, [
      'доставим',
      'доставка будет',
      'доставка стоит',
      'доставка бесплатн',
      'отгрузим сегодня',
      'отгрузим завтра',
      'delivery is',
      'delivery will',
      'delivery costs',
      'delivery free',
      'ships today'
    ]);
  }
  if (type === 'discount') {
    return includesAny(normalizedText, [
      'скидка будет',
      'скидка есть',
      'скидка составит',
      'discount is',
      'discount will'
    ]);
  }
  return false;
}

export function validateFactClaimAuditEvidence(audit: FactClaimAudit): ClaimEvidenceValidationResult {
  const claims: CustomerFacingClaim[] = [];
  const evidence: EvidenceTuple[] = [];

  for (let index = 0; index < audit.claims.length; index += 1) {
    const claim = audit.claims[index]!;
    const type = commercialClaimType(claim);
    if (!type) continue;
    const claimId = `fact-claim-${index}`;
    const evidenceId = `fact-evidence-${index}`;
    const rawSource = evidenceSourceFromFactClaim(claim);
    const source = claim.groundingStatus === 'requires_specialist_verification' && isConfidentCommercialPromise(type, claim.text)
      ? null
      : rawSource;
    claims.push({
      id: claimId,
      type,
      text: claim.text,
      evidenceIds: source ? [evidenceId] : []
    });
    if (source) {
      evidence.push({
        id: evidenceId,
        claimType: type,
        source,
        confidence: claim.groundingStatus === 'grounded' ? 0.9 : 0.6,
        allowedCustomerWording: claim.groundingStatus === 'requires_specialist_verification' ? 'qualified' : 'confident'
      });
    }
  }

  const result = validateClaimEvidence({ claims, evidence });
  return {
    ok: result.ok,
    violations: result.violations.map((item) => {
      if (item.reason !== 'missing_evidence') return item;
      const claim = claims.find((candidate) => candidate.id === item.claimId);
      if (!claim) return item;
      return {
        ...item,
        reason: specificCommercialReason(claim.type),
        repairAction: 'remove the commercial promise or rewrite it as a first-person verification boundary'
      };
    })
  };
}
