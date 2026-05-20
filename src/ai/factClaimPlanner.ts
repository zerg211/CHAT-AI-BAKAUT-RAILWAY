import type {
  CardManifest,
  ExecutionContract,
  FactClaim,
  FactClaimAudit,
  FactClaimPlanner,
  FactClaimRisk,
  FactClaimSourcePolicy,
  RequirementLedger
} from '../shared/types.js';

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

function normalized(value: unknown) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function splitClaimSentences(answer: string) {
  return answer
    .split(/(?<=[.!?\n])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function hasVerificationWording(text: string) {
  return /(?:verify|confirm|check|calculate|logistics|before\s+(?:ordering|checkout))/iu.test(text) ||
    /(?:\u0441\u0432\u0435\u0440|\u0443\u0442\u043e\u0447\u043d|\u043f\u0440\u043e\u0432\u0435\u0440|\u043f\u043e\u0441\u0447\u0438\u0442|\u0441\u043e\u0433\u043b\u0430\u0441|\u043b\u043e\u0433\u0438\u0441\u0442|\u043f\u0435\u0440\u0435\u0434\s+\u043e\u0444\u043e\u0440\u043c\u043b)/iu.test(text);
}

function isCommercialVerificationSentence(text: string) {
  return hasVerificationWording(text) &&
    /(?:\u043d\u0430\u043b\u0438\u0447|\u0441\u043a\u043b\u0430\u0434|\u043e\u0442\u0433\u0440\u0443\u0437|\u0434\u043e\u0441\u0442\u0430\u0432|\u043b\u043e\u0433\u0438\u0441\u0442|\u0441\u043a\u0438\u0434|\u0443\u0441\u043b\u043e\u0432|\u043a\u043e\u043c\u043c\u0435\u0440\u0447|in\s+stock|delivery|shipping|discount|terms)/iu.test(text);
}

function hasCommercialTermsClaim(text: string) {
  if (/(?:\u0441\u043a\u0438\u0434|\u043a\u043e\u043c\u043c\u0435\u0440\u0447|discount)/iu.test(text)) return true;
  return /(?:\u0444\u0438\u043d\u0430\u043b\w*\s+)?\u0443\u0441\u043b\u043e\u0432|terms/iu.test(text) &&
    /(?:\u0437\u0430\u043a\u0430\u0437|\u043e\u0444\u043e\u0440\u043c|\u043e\u043f\u043b\u0430\u0442|\u0434\u043e\u0441\u0442\u0430\u0432|\u0441\u043a\u043b\u0430\u0434|\u0446\u0435\u043d|\u0441\u043a\u0438\u0434|\u0441\u043f\u0435\u0446|\u043a\u043e\u043c\u043c\u0435\u0440\u0447|order|payment|delivery|shipping|price|discount|commercial|special)/iu.test(text);
}

function hasAvailabilityClaim(text: string) {
  return /(?:\u043d\u0430\u043b\u0438\u0447|\u043e\u0442\u0433\u0440\u0443\u0437|in\s+stock|available\s+(?:now|today|for\s+(?:pickup|shipping|order)|in\s+stock)|stock\s+availability|(?:^|[^\p{L}])\u0441\u043a\u043b\u0430\u0434(?:\u0435|\u0430|\u0443|\u043e\u043c|\u044b|\u0430\u0445)?(?:$|[^\p{L}]))/iu.test(text);
}

function isLoadCalculationSentence(text: string) {
  return /(?:\u0440\u0430\u0441\u0447[её]?\u0442|\u0441\u0447\u0438\u0442\u0430|\u043e\u0440\u0438\u0435\u043d\u0442\u0438\u0440|\u043a\u043b\u0430\u0441\u0441|\u043d\u0430\u0433\u0440\u0443\u0437|\u043f\u0443\u0441\u043a|\u0441\u0446\u0435\u043d\u0430\u0440|\u043d\u043e\u043c\u0438\u043d\u0430\u043b|\u043c\u043e\u0449\u043d\u043e\u0441\u0442|calculation|load|starting|scenario|nominal)/iu.test(text);
}

function sentenceProductIds(sentence: string, cardManifest?: CardManifest) {
  const text = normalized(sentence);
  return (cardManifest?.items ?? [])
    .filter((item) => {
      const name = normalized(item.name);
      if (name && text.includes(name)) return true;
      const tokens = name.split(/[^a-z0-9\u0430-\u044f\u0451]+/iu).filter((token) => token.length >= 4);
      return tokens.length >= 2 && tokens.every((token) => text.includes(token));
    })
    .map((item) => item.productId);
}

function addClaim(claims: FactClaim[], claim: FactClaim) {
  const key = `${claim.kind}:${claim.text}:${claim.requiredSource}`;
  if (!claims.some((item) => `${item.kind}:${item.text}:${item.requiredSource}` === key)) claims.push(claim);
}

function riskFor(input: {
  executionContract: ExecutionContract;
  cardManifest?: CardManifest;
  requiredDisclaimers: string[];
}): FactClaimRisk {
  if (input.cardManifest?.warnings.length) return 'high';
  if (input.executionContract.factPolicy === 'specialist_required') return 'high';
  if (input.executionContract.factPolicy === 'web_required') return 'medium';
  if (input.requiredDisclaimers.length) return 'medium';
  return 'low';
}

export function buildFactClaimPlanner(input: {
  executionContract: ExecutionContract;
  requirementLedger: RequirementLedger;
  cardManifest?: CardManifest;
  usedWebSearch?: boolean;
}): FactClaimPlanner {
  const allowedSources: FactClaimSourcePolicy[] = ['conversation_memory'];
  const requiredDisclaimers: string[] = [];
  const forbiddenClaims: string[] = [
    'do_not_invent_product_names_prices_specs',
    'do_not_expose_internal_urls_or_source_domains'
  ];
  const warnings: string[] = [];

  if (input.executionContract.cardsPolicy !== 'none') {
    allowedSources.push('visible_cards', 'catalog');
  } else if (input.executionContract.catalogPolicy !== 'none') {
    allowedSources.push('catalog');
  }

  if (input.executionContract.factPolicy === 'web_required') {
    allowedSources.push('web');
    if (!input.usedWebSearch) warnings.push('web_required_but_not_used_yet');
    requiredDisclaimers.push('separate_confirmed_facts_from_inference');
  }

  if (input.executionContract.factPolicy === 'specialist_required') {
    allowedSources.push('specialist');
    requiredDisclaimers.push('live_stock_delivery_discount_terms_require_specialist_verification');
    forbiddenClaims.push('do_not_promise_live_stock_delivery_discount_or_exact_terms');
  }

  if (input.cardManifest?.warnings.length) {
    forbiddenClaims.push('do_not_name_visible_cards_with_constraint_violations_as_recommendations');
    warnings.push(...input.cardManifest.warnings);
  }

  if (!input.requirementLedger.items.length && input.executionContract.answerTask === 'product_selection') {
    warnings.push('product_selection_without_requirement_ledger_items');
  }

  return {
    version: 1,
    factPolicy: input.executionContract.factPolicy,
    allowedSources: unique(allowedSources),
    requiredDisclaimers: unique(requiredDisclaimers),
    forbiddenClaims: unique(forbiddenClaims),
    risk: riskFor({
      executionContract: input.executionContract,
      cardManifest: input.cardManifest,
      requiredDisclaimers
    }),
    warnings: unique(warnings)
  };
}

export function auditAnswerFactClaims(input: {
  answer: string;
  factClaimPlanner: FactClaimPlanner;
  cardManifest?: CardManifest;
}): FactClaimAudit {
  const claims: FactClaim[] = [];
  const warnings: string[] = [];
  const sentences = splitClaimSentences(input.answer);
  const allowed = new Set(input.factClaimPlanner.allowedSources);

  for (const sentence of sentences) {
    const matchedProductIds = sentenceProductIds(sentence, input.cardManifest);
    if (matchedProductIds.length) {
      addClaim(claims, {
        kind: 'product_reference',
        text: sentence,
        requiredSource: 'visible_cards',
        groundingStatus: allowed.has('visible_cards') ? 'grounded' : 'ungrounded',
        matchedProductIds,
        warning: allowed.has('visible_cards') ? undefined : 'product_reference_without_visible_cards_source'
      });
    }

    if (/(?:\d[\d\s.,]*(?:\u20bd|\u0440\u0443\u0431|rub|rur)|(?:\u0446\u0435\u043d\u0430|price)\s*[^\n.!?]{0,40}\d)/iu.test(sentence)) {
      const grounded = allowed.has('visible_cards') || allowed.has('catalog');
      addClaim(claims, {
        kind: 'price',
        text: sentence,
        requiredSource: allowed.has('visible_cards') ? 'visible_cards' : 'catalog',
        groundingStatus: grounded ? 'grounded' : 'ungrounded',
        matchedProductIds,
        warning: grounded ? undefined : 'price_claim_without_catalog_or_card_source'
      });
    }

    if (hasAvailabilityClaim(sentence)) {
      const verified = hasVerificationWording(sentence);
      addClaim(claims, {
        kind: 'availability',
        text: sentence,
        requiredSource: 'specialist',
        groundingStatus: verified ? 'requires_specialist_verification' : 'ungrounded',
        matchedProductIds,
        warning: verified ? undefined : 'availability_claim_without_specialist_verification_wording'
      });
    }

    if (/(?:\u0434\u043e\u0441\u0442\u0430\u0432|\u043b\u043e\u0433\u0438\u0441\u0442|delivery|shipping)/iu.test(sentence)) {
      const verified = hasVerificationWording(sentence);
      addClaim(claims, {
        kind: 'delivery',
        text: sentence,
        requiredSource: 'specialist',
        groundingStatus: verified ? 'requires_specialist_verification' : 'ungrounded',
        matchedProductIds,
        warning: verified ? undefined : 'delivery_claim_without_specialist_verification_wording'
      });
    }

    if (hasCommercialTermsClaim(sentence)) {
      const verified = hasVerificationWording(sentence);
      addClaim(claims, {
        kind: 'discount_or_terms',
        text: sentence,
        requiredSource: 'specialist',
        groundingStatus: verified ? 'requires_specialist_verification' : 'ungrounded',
        matchedProductIds,
        warning: verified ? undefined : 'terms_claim_without_specialist_verification_wording'
      });
    }

    if (/(?:\d+(?:[.,]\d+)?\s*(?:\u043a\u0432\u0442|kw|\u043a\u0433|kg|\u0432\b|v\b|mm|\u043c\u043c)|220|380)/iu.test(sentence)) {
      const groundedByCalculation = !matchedProductIds.length &&
        allowed.has('conversation_memory') &&
        isLoadCalculationSentence(sentence);
      const grounded = matchedProductIds.length > 0 ||
        allowed.has('catalog') ||
        allowed.has('visible_cards') ||
        groundedByCalculation;
      addClaim(claims, {
        kind: 'technical_spec',
        text: sentence,
        requiredSource: matchedProductIds.length ? 'visible_cards' : groundedByCalculation ? 'conversation_memory' : 'catalog',
        groundingStatus: grounded ? 'grounded' : 'unchecked',
        matchedProductIds,
        warning: grounded ? undefined : 'technical_claim_without_catalog_context'
      });
    }

    if (
      /(?:\u0432\u044b\u043f\u0443\u0441\u043a|\u043f\u0440\u043e\u0438\u0437\u0432\u043e\u0434|\u043b\u0438\u043d\u0435\u0439\u043a|(?:\u043c\u043e\u0434\u0435\u043b\w{0,8}.{0,40}\u0430\u043a\u0442\u0443\u0430\u043b\w{0,8})|(?:\u0430\u043a\u0442\u0443\u0430\u043b\w{0,8}.{0,40}\u043c\u043e\u0434\u0435\u043b\w{0,8})|current\s+(?:lineup|production)|discontinued)/iu.test(sentence) &&
      !isCommercialVerificationSentence(sentence)
    ) {
      const grounded = allowed.has('web');
      addClaim(claims, {
        kind: 'current_lineup',
        text: sentence,
        requiredSource: 'web',
        groundingStatus: grounded ? 'requires_web_verification' : 'ungrounded',
        matchedProductIds,
        warning: grounded ? undefined : 'current_lineup_claim_without_web_policy'
      });
    }
  }

  for (const claim of claims) {
    if (claim.warning) warnings.push(claim.warning);
  }

  return {
    version: 1,
    claims,
    warnings: unique(warnings)
  };
}
