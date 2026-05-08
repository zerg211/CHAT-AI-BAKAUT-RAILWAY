import type { ActiveCustomerNeed, CustomerNeedState, NeedItem, ProductSelectionClass, ProductSelectionCriteria, ProductSelectionState } from '../shared/types.js';

function emptySelectionCriteria(): ProductSelectionCriteria {
  return {
    productIntent: 'unknown',
    productRole: 'unknown',
    exactModelTokens: [],
    exactModelTokenRoles: [],
    mustHaveTraits: [],
    excludedClasses: [],
    provenance: {}
  };
}

export function emptyProductSelectionState(): ProductSelectionState {
  return {
    currentProductClass: 'unknown',
    targetProductClass: 'unknown',
    hardConstraints: emptySelectionCriteria(),
    softPreferences: emptySelectionCriteria(),
    unknowns: [],
    conflicts: [],
    selectedProductIds: [],
    matchedProductIds: [],
    comparisonProductIds: [],
    rejectedProducts: [],
    previousCandidateProductIds: [],
    confidence: 0
  };
}

export function emptyNeedState(): CustomerNeedState {
  return {
    activeNeeds: [],
    explicitNeeds: [],
    implicitNeeds: [],
    constraints: [],
    importantCriteria: [],
    confirmedFacts: [],
    uncertainInferences: [],
    contradictions: [],
    featureSignals: {
      portable: 0,
      homeUse: 0,
      compact: 0,
      lowNoise: 0,
      coldStart: 0,
      professionalDuty: 0,
      budgetSensitive: 0
    },
    selectionState: emptyProductSelectionState(),
    lastSummary: ''
  };
}

const ru = (codes: TemplateStringsArray) => JSON.parse(`"${codes[0]}"`) as string;
const re = (pattern: string, flags = 'i') => new RegExp(pattern, flags);
const nowIso = () => new Date().toISOString();
const signalKeys = ['portable', 'homeUse', 'compact', 'lowNoise', 'coldStart', 'professionalDuty', 'budgetSensitive'] as const;

const labels = {
  generator: ru`\u041f\u043e\u0434\u0431\u043e\u0440 \u0433\u0435\u043d\u0435\u0440\u0430\u0442\u043e\u0440\u0430`,
  plate: ru`\u041f\u043e\u0434\u0431\u043e\u0440 \u0432\u0438\u0431\u0440\u043e\u043f\u043b\u0438\u0442\u044b`,
  rammer: ru`\u041f\u043e\u0434\u0431\u043e\u0440 \u0432\u0438\u0431\u0440\u043e\u0442\u0440\u0430\u043c\u0431\u043e\u0432\u043a\u0438`,
  cutter: ru`\u041f\u043e\u0434\u0431\u043e\u0440 \u0440\u0435\u0437\u0447\u0438\u043a\u0430 \u0448\u0432\u043e\u0432`,
  power: ru`\u0412\u0430\u0436\u043d\u0430 \u043c\u043e\u0449\u043d\u043e\u0441\u0442\u044c \u043e\u0431\u043e\u0440\u0443\u0434\u043e\u0432\u0430\u043d\u0438\u044f`,
  material: ru`\u0415\u0441\u0442\u044c \u0437\u0430\u0434\u0430\u0447\u0430 \u043f\u043e \u043a\u043e\u043d\u043a\u0440\u0435\u0442\u043d\u043e\u043c\u0443 \u043c\u0430\u0442\u0435\u0440\u0438\u0430\u043b\u0443 \u0438\u043b\u0438 \u043e\u0441\u043d\u043e\u0432\u0430\u043d\u0438\u044e`,
  homeUse: ru`\u0412\u0435\u0440\u043e\u044f\u0442\u043d\u043e \u0432\u0430\u0436\u043d\u044b \u043f\u0440\u043e\u0441\u0442\u043e\u0442\u0430 \u0437\u0430\u043f\u0443\u0441\u043a\u0430, \u043a\u043e\u043c\u043f\u0430\u043a\u0442\u043d\u043e\u0441\u0442\u044c \u0438 \u043d\u0430\u0434\u0435\u0436\u043d\u043e\u0441\u0442\u044c \u0434\u043b\u044f \u0431\u044b\u0442\u043e\u0432\u043e\u0433\u043e \u0438\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u043d\u0438\u044f`,
  weight: ru`\u0412\u0435\u0440\u043e\u044f\u0442\u043d\u043e \u0432\u0430\u0436\u043d\u044b \u0432\u0435\u0441, \u0433\u0430\u0431\u0430\u0440\u0438\u0442\u044b \u0438 \u0443\u0434\u043e\u0431\u0441\u0442\u0432\u043e \u043f\u0435\u0440\u0435\u043d\u043e\u0441\u043a\u0438`,
  winter: ru`\u0412\u0435\u0440\u043e\u044f\u0442\u043d\u043e \u0432\u0430\u0436\u0435\u043d \u0443\u0432\u0435\u0440\u0435\u043d\u043d\u044b\u0439 \u0437\u0430\u043f\u0443\u0441\u043a \u0438 \u0440\u0430\u0431\u043e\u0442\u0430 \u0432 \u0445\u043e\u043b\u043e\u0434\u043d\u044b\u0445 \u0443\u0441\u043b\u043e\u0432\u0438\u044f\u0445`,
  noise: ru`\u0412\u0435\u0440\u043e\u044f\u0442\u043d\u043e \u0432\u0430\u0436\u0435\u043d \u0443\u0440\u043e\u0432\u0435\u043d\u044c \u0448\u0443\u043c\u0430`,
  budget: ru`\u0412\u0435\u0440\u043e\u044f\u0442\u043d\u043e \u0432\u0430\u0436\u0435\u043d \u0431\u044e\u0434\u0436\u0435\u0442 \u0438 \u0441\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c \u0432\u043b\u0430\u0434\u0435\u043d\u0438\u044f`,
  proLoad: ru`\u0412\u0435\u0440\u043e\u044f\u0442\u043d\u043e \u043d\u0443\u0436\u043d\u0430 \u043f\u0440\u043e\u0444\u0435\u0441\u0441\u0438\u043e\u043d\u0430\u043b\u044c\u043d\u0430\u044f \u043c\u043e\u0434\u0435\u043b\u044c \u0441 \u0440\u0435\u0441\u0443\u0440\u0441\u043e\u043c \u043f\u043e\u0434 \u0440\u0435\u0433\u0443\u043b\u044f\u0440\u043d\u0443\u044e \u043d\u0430\u0433\u0440\u0443\u0437\u043a\u0443`,
  budgetLimit: ru`\u0415\u0441\u0442\u044c \u043e\u0433\u0440\u0430\u043d\u0438\u0447\u0435\u043d\u0438\u0435 \u043f\u043e \u0431\u044e\u0434\u0436\u0435\u0442\u0443`,
  voltage: ru`\u0415\u0441\u0442\u044c \u0442\u0440\u0435\u0431\u043e\u0432\u0430\u043d\u0438\u0435 \u043f\u043e \u043d\u0430\u043f\u0440\u044f\u0436\u0435\u043d\u0438\u044e`,
  fuel: ru`\u0415\u0441\u0442\u044c \u043f\u0440\u0435\u0434\u043f\u043e\u0447\u0442\u0435\u043d\u0438\u0435 \u043f\u043e \u0442\u0438\u043f\u0443 \u0442\u043e\u043f\u043b\u0438\u0432\u0430`,
  availability: ru`\u041f\u043e\u043a\u0443\u043f\u0430\u0442\u0435\u043b\u044e \u0432\u0430\u0436\u043d\u044b \u0441\u0440\u043e\u043a\u0438 \u043f\u043e\u043b\u0443\u0447\u0435\u043d\u0438\u044f \u0438 \u043d\u0430\u043b\u0438\u0447\u0438\u0435, \u0442\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044f \u0443\u0442\u043e\u0447\u043d\u0435\u043d\u0438\u0435 \u0443 \u0441\u043f\u0435\u0446\u0438\u0430\u043b\u0438\u0441\u0442\u0430`,
  changed: ru`\u041f\u043e\u043a\u0443\u043f\u0430\u0442\u0435\u043b\u044c \u043c\u043e\u0433 \u0438\u0437\u043c\u0435\u043d\u0438\u0442\u044c \u0438\u043b\u0438 \u043e\u0442\u043c\u0435\u043d\u0438\u0442\u044c \u0447\u0430\u0441\u0442\u044c \u043f\u0440\u0435\u0436\u043d\u0438\u0445 \u0442\u0440\u0435\u0431\u043e\u0432\u0430\u043d\u0438\u0439`,
  explicit: ru`\u044f\u0432\u043d\u043e`,
  implicit: ru`\u0441\u043a\u0440\u044b\u0442\u043e`,
  constraints: ru`\u043e\u0433\u0440\u0430\u043d\u0438\u0447\u0435\u043d\u0438\u044f`,
  criteria: ru`\u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0438`
};

const needSignal = String.raw`(?:\u043d\u0443\u0436[\u0430-\u044f]*|\u043f\u043e\u0434\u0431\u0435\u0440[\u0430-\u044f]*|\u0438\u0449\u0443|\u0445\u043e\u0447\u0443|\u043f\u043e\u0441\u043e\u0432\u0435\u0442\u0443\u0439|\u043f\u043e\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434\u0443\u0439)`;

function normalizeText(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function mergeItems(existing: NeedItem[], next: NeedItem[], threshold = 0.08) {
  const result = [...existing];
  for (const item of next) {
    const normalized = normalizeText(item.value);
    const found = result.find((candidate) => {
      const candidateText = normalizeText(candidate.value);
      return candidateText === normalized || candidateText.includes(normalized) || normalized.includes(candidateText);
    });
    if (found) {
      found.confidence = Math.max(found.confidence, item.confidence);
      found.evidence = item.evidence || found.evidence;
      found.updatedAt = item.updatedAt;
      continue;
    }
    if (item.confidence >= threshold) result.push(item);
  }
  return result.slice(-20);
}

function decayItems(items: NeedItem[], factor: number, minConfidence: number) {
  return items
    .map((item) => ({ ...item, confidence: item.confidence * factor }))
    .filter((item) => item.confidence >= minConfidence);
}

function updateHasScopeChange(update: Partial<CustomerNeedState>) {
  return (update.contradictions ?? []).some((item) => {
    const evidence = normalizeText(`${item.value} ${item.evidence}`);
    return re(String.raw`(?:\u043f\u0435\u0440\u0435\u0434\u0443\u043c\u0430|\u0442\u0435\u043f\u0435\u0440\u044c|\u0432\u043c\u0435\u0441\u0442\u043e|\u0437\u0430\u0431\u0443\u0434|\u0434\u0440\u0443\u0433|\u0443\u0436\u0435 \u043d\u0435|\u043d\u0435 \u0432\u0430\u0436\u043d|\u043d\u0435 \u043d\u0443\u0436\u043d)`).test(evidence);
  });
}

function mergeSignals(
  current: CustomerNeedState['featureSignals'],
  update: Partial<CustomerNeedState['featureSignals']>,
  staleFactor: number
) {
  return Object.fromEntries(
    signalKeys.map((key) => {
      const next = update[key];
      return [key, Math.max(current[key] * staleFactor, next ?? 0)];
    })
  ) as CustomerNeedState['featureSignals'];
}

function uniqueStrings(values: Array<string | undefined | null>, limit: number) {
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))].slice(0, limit);
}

function activeNeedId(productClass: ProductSelectionClass | 'commercial') {
  return productClass;
}

function mergeActiveNeeds(
  current: ActiveCustomerNeed[] | undefined,
  update: ActiveCustomerNeed[] | undefined,
  scopeChanged = false
) {
  const byId = new Map<string, ActiveCustomerNeed>();
  for (const need of current ?? []) {
    byId.set(need.id, { ...need });
  }
  for (const need of update ?? []) {
    const existing = byId.get(need.id);
    byId.set(need.id, {
      ...(existing ?? need),
      ...need,
      constraints: uniqueStrings([...(existing?.constraints ?? []), ...(need.constraints ?? [])], 16),
      openQuestions: uniqueStrings([...(existing?.openQuestions ?? []), ...(need.openQuestions ?? [])], 12),
      selectedProductIds: uniqueStrings([...(existing?.selectedProductIds ?? []), ...(need.selectedProductIds ?? [])], 16),
      status: need.status ?? existing?.status ?? 'open',
      updatedAt: need.updatedAt ?? existing?.updatedAt ?? nowIso()
    });
  }
  const needs = [...byId.values()];
  return scopeChanged
    ? needs.map((need) => need.status === 'open' ? { ...need, status: 'paused' as const, updatedAt: nowIso() } : need)
    : needs;
}

function activeNeed(productClass: ProductSelectionClass | 'commercial', summary: string, evidence: string): ActiveCustomerNeed {
  return {
    id: activeNeedId(productClass),
    productClass,
    summary,
    constraints: evidence ? [evidence] : [],
    openQuestions: [],
    selectedProductIds: [],
    status: 'open',
    updatedAt: nowIso()
  };
}

export function activeNeedsFromMessage(message: string, selectionState?: ProductSelectionState): ActiveCustomerNeed[] {
  const needs: ActiveCustomerNeed[] = [];
  const push = (productClass: ProductSelectionClass | 'commercial', summary: string) => {
    if (!needs.some((need) => need.id === activeNeedId(productClass))) {
      needs.push(activeNeed(productClass, summary, message));
    }
  };
  if (re(String.raw`(?:\u0433\u0435\u043d\u0435\u0440\u0430\u0442\u043e\u0440|\u044d\u043b\u0435\u043a\u0442\u0440\u043e\u0441\u0442\u0430\u043d\u0446)`).test(message)) push('generator', labels.generator);
  if (re(String.raw`(?:\u0432\u0438\u0431\u0440\u043e\u043f\u043b\u0438\u0442|\u043f\u043b\u0438\u0442\u0443)`).test(message)) push('plate', labels.plate);
  if (re(String.raw`(?:\u0442\u0440\u0430\u043c\u0431\u043e\u0432\u043a|\u0432\u0438\u0431\u0440\u043e\u043d\u043e\u0433)`).test(message)) push('rammer', labels.rammer);
  if (re(String.raw`(?:\u0440\u0435\u0437\u0447\u0438\u043a|\u0448\u0432\u043e\u043d\u0430\u0440\u0435\u0437)`).test(message)) push('cutter', labels.cutter);
  if (re(String.raw`(?:\u0434\u043e\u0441\u0442\u0430\u0432\u043a|\u043d\u0430\u043b\u0438\u0447|\u0441\u043a\u0438\u0434\u043a|\u0441\u043f\u0435\u0446\u0443\u0441\u043b\u043e\u0432|\u043e\u043f\u043b\u0430\u0442|\u0437\u0430\u043a\u0430\u0437|\u043a\u0443\u043f\u0438\u0442)`).test(message)) {
    push('commercial', labels.availability);
  }
  const targetClass = selectionState?.targetProductClass && selectionState.targetProductClass !== 'unknown'
    ? selectionState.targetProductClass
    : selectionState?.currentProductClass && selectionState.currentProductClass !== 'unknown'
      ? selectionState.currentProductClass
      : undefined;
  if (targetClass && !needs.some((need) => need.id === targetClass)) {
    push(targetClass, labels[targetClass as keyof typeof labels] ?? targetClass);
  }
  return needs;
}

function mergeLoadProfile(
  current: ProductSelectionState['loadProfile'],
  update: ProductSelectionState['loadProfile'],
  reset = false
): ProductSelectionState['loadProfile'] {
  if (!update) return reset ? undefined : current;
  const removedKinds = new Set(update.removedKinds ?? []);
  const baseItems = reset ? [] : (current?.items ?? []).filter((item) => !removedKinds.has(item.kind));
  const byKey = new Map<string, NonNullable<ProductSelectionState['loadProfile']>['items'][number]>();
  for (const item of baseItems) {
    byKey.set(`${item.kind}:${item.name ?? ''}`, item);
  }
  for (const item of update.items ?? []) {
    byKey.set(`${item.kind}:${item.name ?? ''}`, item);
  }
  return {
    ...(!reset ? current ?? {} : {}),
    ...update,
    items: [...byKey.values()].slice(-16)
  };
}

function sanitizePositiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function mergeCriteria(
  current: ProductSelectionCriteria | undefined,
  update: Partial<ProductSelectionCriteria> | undefined,
  reset = false
): ProductSelectionCriteria {
  const empty = emptySelectionCriteria();
  const base = reset ? empty : { ...empty, ...(current ?? {}) };
  if (!update) return base;
  const nextProvenance = { ...(reset ? {} : base.provenance ?? {}), ...(update.provenance ?? {}) };
  const isExplicitPowerUpdate = Boolean(
    update.nominalPowerKwMin !== undefined ||
    update.nominalPowerKwMax !== undefined ||
    update.maxPowerKwMin !== undefined ||
    update.maxPowerKwMax !== undefined
  );
  const isExplicitWeightUpdate = Boolean(update.weightKgMin !== undefined || update.weightKgMax !== undefined);
  const isExplicitDiameterUpdate = Boolean(update.diameterMmMin !== undefined || update.diameterMmMax !== undefined);
  return {
    ...base,
    ...update,
    budgetMax: sanitizePositiveNumber(update.budgetMax) ?? base.budgetMax,
    nominalPowerKwMin: isExplicitPowerUpdate ? sanitizePositiveNumber(update.nominalPowerKwMin) : base.nominalPowerKwMin,
    nominalPowerKwMax: isExplicitPowerUpdate ? sanitizePositiveNumber(update.nominalPowerKwMax) : base.nominalPowerKwMax,
    maxPowerKwMin: isExplicitPowerUpdate ? sanitizePositiveNumber(update.maxPowerKwMin) : base.maxPowerKwMin,
    maxPowerKwMax: isExplicitPowerUpdate ? sanitizePositiveNumber(update.maxPowerKwMax) : base.maxPowerKwMax,
    weightKgMin: isExplicitWeightUpdate ? sanitizePositiveNumber(update.weightKgMin) : base.weightKgMin,
    weightKgMax: isExplicitWeightUpdate ? sanitizePositiveNumber(update.weightKgMax) : base.weightKgMax,
    diameterMmMin: isExplicitDiameterUpdate ? sanitizePositiveNumber(update.diameterMmMin) : base.diameterMmMin,
    diameterMmMax: isExplicitDiameterUpdate ? sanitizePositiveNumber(update.diameterMmMax) : base.diameterMmMax,
    productIntent: update.productIntent && update.productIntent !== 'unknown' ? update.productIntent : base.productIntent,
    productRole: update.productRole && update.productRole !== 'unknown' ? update.productRole : base.productRole,
    exactModelTokens: uniqueStrings([...(reset ? [] : base.exactModelTokens), ...(update.exactModelTokens ?? [])], 16),
    exactModelTokenRoles: [
      ...(reset ? [] : base.exactModelTokenRoles ?? []),
      ...(update.exactModelTokenRoles ?? [])
    ].filter((item, index, all) => item.value && all.findIndex((candidate) => candidate.value === item.value && candidate.role === item.role) === index).slice(0, 24),
    mustHaveTraits: uniqueStrings([...(reset ? [] : base.mustHaveTraits), ...(update.mustHaveTraits ?? [])], 24),
    excludedClasses: uniqueStrings([...(reset ? [] : base.excludedClasses), ...(update.excludedClasses ?? [])], 24) as ProductSelectionCriteria['excludedClasses'],
    provenance: nextProvenance
  };
}

export function mergeProductSelectionState(
  current: ProductSelectionState | undefined,
  update: Partial<ProductSelectionState> | undefined,
  scopeChanged = false
): ProductSelectionState {
  const empty = emptyProductSelectionState();
  const base = current
    ? {
        ...empty,
        ...current,
        hardConstraints: { ...empty.hardConstraints, ...current.hardConstraints },
        softPreferences: { ...empty.softPreferences, ...current.softPreferences }
      }
    : empty;
  if (!update) return base;

  const incomingTarget = update.targetProductClass && update.targetProductClass !== 'unknown'
    ? update.targetProductClass
    : undefined;
  const classChanged = Boolean(incomingTarget && base.targetProductClass !== 'unknown' && incomingTarget !== base.targetProductClass);
  const reset = scopeChanged || classChanged;
  const nextTarget = incomingTarget ?? (reset ? 'unknown' : base.targetProductClass);

  return {
    semanticSource: update.semanticSource ?? base.semanticSource,
    currentProductClass: update.currentProductClass && update.currentProductClass !== 'unknown'
      ? update.currentProductClass
      : nextTarget !== 'unknown'
        ? nextTarget
        : reset
          ? 'unknown'
          : base.currentProductClass,
    targetProductClass: nextTarget,
    activeRequirement: update.activeRequirement
      ? mergeCriteria(reset ? undefined : base.activeRequirement, update.activeRequirement, reset)
      : reset
        ? undefined
        : base.activeRequirement,
    hardConstraints: mergeCriteria(base.hardConstraints, update.hardConstraints, reset),
    softPreferences: mergeCriteria(base.softPreferences, update.softPreferences, reset),
    unknowns: uniqueStrings([...(reset ? [] : base.unknowns), ...(update.unknowns ?? [])], 16),
    conflicts: uniqueStrings([...(reset ? [] : base.conflicts), ...(update.conflicts ?? [])], 16),
    selectedProductIds: uniqueStrings([...(reset ? [] : base.selectedProductIds), ...(update.selectedProductIds ?? [])], 16),
    matchedProductIds: uniqueStrings([...(reset ? [] : base.matchedProductIds ?? []), ...(update.matchedProductIds ?? [])], 64),
    comparisonProductIds: uniqueStrings([...(reset ? [] : base.comparisonProductIds ?? []), ...(update.comparisonProductIds ?? [])], 32),
    rejectedProducts: [
      ...(reset ? [] : base.rejectedProducts ?? []),
      ...(update.rejectedProducts ?? [])
    ].filter((item, index, all) => item.productId && all.findIndex((candidate) => candidate.productId === item.productId && candidate.reason === item.reason) === index).slice(-32),
    compatibilityTargetProduct: update.compatibilityTargetProduct ?? (reset ? undefined : base.compatibilityTargetProduct),
    loadProfile: mergeLoadProfile(base.loadProfile, update.loadProfile, reset),
    previousCandidateProductIds: uniqueStrings([...(reset ? [] : base.previousCandidateProductIds ?? []), ...(update.previousCandidateProductIds ?? [])], 64),
    rankingPreference: update.rankingPreference ?? (reset ? undefined : base.rankingPreference),
    confidence: Math.max(reset ? base.confidence * 0.35 : base.confidence, update.confidence ?? 0),
    updatedAt: update.updatedAt ?? base.updatedAt
  };
}

export function mergeNeedState(current: CustomerNeedState, update: Partial<CustomerNeedState>): CustomerNeedState {
  const updateSignals: Partial<CustomerNeedState['featureSignals']> = update.featureSignals ?? {};
  const scopeChanged = updateHasScopeChange(update);
  const replacementHasExplicitNeed = (update.explicitNeeds ?? []).length > 0;
  const itemFactor = scopeChanged ? 0.35 : 1;
  const signalFactor = scopeChanged ? 0.25 : 1;
  const activeCurrent = scopeChanged
    ? {
        activeNeeds: current.activeNeeds,
        explicitNeeds: replacementHasExplicitNeed ? decayItems(current.explicitNeeds, itemFactor, 0.3) : current.explicitNeeds,
        implicitNeeds: decayItems(current.implicitNeeds, itemFactor, 0.3),
        constraints: decayItems(current.constraints, itemFactor, 0.3),
        importantCriteria: decayItems(current.importantCriteria, itemFactor, 0.3),
        confirmedFacts: current.confirmedFacts,
        uncertainInferences: decayItems(current.uncertainInferences, itemFactor, 0.25),
        contradictions: current.contradictions
      }
    : current;
  return {
    activeNeeds: mergeActiveNeeds(activeCurrent.activeNeeds, update.activeNeeds, scopeChanged),
    explicitNeeds: mergeItems(activeCurrent.explicitNeeds, update.explicitNeeds ?? []),
    implicitNeeds: mergeItems(activeCurrent.implicitNeeds, update.implicitNeeds ?? []),
    constraints: mergeItems(activeCurrent.constraints, update.constraints ?? []),
    importantCriteria: mergeItems(activeCurrent.importantCriteria, update.importantCriteria ?? []),
    confirmedFacts: mergeItems(activeCurrent.confirmedFacts, update.confirmedFacts ?? []),
    uncertainInferences: mergeItems(activeCurrent.uncertainInferences, update.uncertainInferences ?? [], 0.2),
    contradictions: mergeItems(activeCurrent.contradictions, update.contradictions ?? [], 0.2),
    featureSignals: mergeSignals(current.featureSignals, updateSignals, signalFactor),
    selectionState: mergeProductSelectionState(current.selectionState, update.selectionState, scopeChanged),
    lastSummary: update.lastSummary?.trim() || current.lastSummary
  };
}

function item(value: string, evidence: string, confidence: number): NeedItem {
  return { value, evidence, confidence, updatedAt: nowIso() };
}

export function heuristicNeedUpdate(message: string): Partial<CustomerNeedState> {
  const update: Partial<CustomerNeedState> = {
    activeNeeds: activeNeedsFromMessage(message),
    explicitNeeds: [],
    implicitNeeds: [],
    constraints: [],
    importantCriteria: [],
    confirmedFacts: [],
    uncertainInferences: [],
    contradictions: [],
    featureSignals: {
      portable: 0,
      homeUse: 0,
      compact: 0,
      lowNoise: 0,
      coldStart: 0,
      professionalDuty: 0,
      budgetSensitive: 0
    }
  };

  const explicitSignals = [
    { re: re(`${needSignal}.{0,40}(?:\\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440|\\u044d\\u043b\\u0435\\u043a\\u0442\\u0440\\u043e\\u0441\\u0442\\u0430\\u043d\\u0446)`), value: labels.generator },
    { re: re(`${needSignal}.{0,40}(?:\\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442|\\u043f\\u043b\\u0438\\u0442\\u0443)`), value: labels.plate },
    { re: re(`${needSignal}.{0,40}(?:\\u0442\\u0440\\u0430\\u043c\\u0431\\u043e\\u0432\\u043a|\\u0432\\u0438\\u0431\\u0440\\u043e\\u043d\\u043e\\u0433)`), value: labels.rammer },
    { re: re(`${needSignal}.{0,40}(?:\\u0440\\u0435\\u0437\\u0447\\u0438\\u043a|\\u0448\\u0432\\u043e\\u043d\\u0430\\u0440\\u0435\\u0437)`), value: labels.cutter },
    { re: re(String.raw`(?:\u043c\u043e\u0449\u043d\u043e\u0441\u0442[\u044c\u0438]|\u043a\u0432\u0442|\u043a\u0438\u043b\u043e\u0432\u0430\u0442\u0442)`), value: labels.power },
    { re: re(String.raw`(?:\u0433\u0440\u0443\u043d\u0442|\u043f\u0435\u0441\u043e\u043a|\u0449\u0435\u0431[\u0435\u0451]\u043d|\u0430\u0441\u0444\u0430\u043b\u044c\u0442|\u043f\u043b\u0438\u0442\u043a|\u0431\u0435\u0442\u043e\u043d)`), value: labels.material }
  ];

  for (const signal of explicitSignals) {
    // Lexical extraction is only a low-authority memory hint. The LLM planner owns
    // product intent and turn action; these hints must not drive catalogue routing.
    if (signal.re.test(message)) update.explicitNeeds?.push(item(signal.value, message, 0.31));
  }

  const implicitSignals = [
    { re: re(String.raw`(?:\u0434\u0430\u0447[\u0430\u0438\u0443]|\u0437\u0430\u0433\u043e\u0440\u043e\u0434|\u0434\u043e\u043c)`), value: labels.homeUse },
    { re: re(String.raw`(?:\u0436\u0435\u043d[\u0430\u0443\u044b]|\u0441\u0430\u043c \u0431\u0443\u0434\u0443 \u043f\u0435\u0440\u0435\u043d\u043e\u0441\u0438\u0442\u044c|\u0442\u0430\u0441\u043a\u0430\u0442\u044c|\u043f\u0435\u0440\u0435\u043d\u043e\u0441\u0438\u0442\u044c|\u043b\u0435\u0433\u043a[\u0430-\u044f]*|\u0442\u044f\u0436\u0435\u043b[\u0430-\u044f]*)`), value: labels.weight },
    { re: re(String.raw`(?:\u0437\u0438\u043c[\u0430\u0443\u044b]|\u043c\u043e\u0440\u043e\u0437|\u0445\u043e\u043b\u043e\u0434|\u043d\u0430 \u0443\u043b\u0438\u0446\u0435)`), value: labels.winter },
    { re: re(String.raw`(?:\u0442\u0438\u0445\u043e|\u0448\u0443\u043c|\u0441\u043e\u0441\u0435\u0434|\u043d\u043e\u0447[\u044c\u044c\u044e]|\u043d\u0435 \u043c\u0435\u0448\u0430\u043b)`), value: labels.noise },
    { re: re(String.raw`(?:\u0434\u0435\u0448\u0435\u0432|\u043d\u0435\u0434\u043e\u0440\u043e\u0433|\u0431\u044e\u0434\u0436\u0435\u0442|\u043f\u043e \u0446\u0435\u043d\u0435|\u0446\u0435\u043d\u0430)`), value: labels.budget },
    { re: re(String.raw`(?:\u043a\u0430\u0436\u0434\u044b\u0439 \u0434\u0435\u043d\u044c|\u043f\u043e\u0441\u0442\u043e\u044f\u043d\u043d\u043e|\u043f\u0440\u043e\u0444\u0435\u0441\u0441\u0438\u043e\u043d\u0430\u043b\u044c|\u0431\u0440\u0438\u0433\u0430\u0434\u0430|\u043e\u0431\u044a\u0435\u043a\u0442)`), value: labels.proLoad }
  ];

  for (const signal of implicitSignals) {
    if (signal.re.test(message)) update.implicitNeeds?.push(item(signal.value, message, 0.58));
  }

  if (implicitSignals[0].re.test(message)) {
    update.featureSignals!.homeUse = 0.72;
    update.featureSignals!.compact = Math.max(update.featureSignals!.compact, 0.42);
  }
  if (implicitSignals[1].re.test(message)) {
    update.featureSignals!.portable = 0.82;
    update.featureSignals!.compact = Math.max(update.featureSignals!.compact, 0.55);
  }
  if (implicitSignals[2].re.test(message)) update.featureSignals!.coldStart = 0.75;
  if (implicitSignals[3].re.test(message)) update.featureSignals!.lowNoise = 0.75;
  if (implicitSignals[4].re.test(message)) update.featureSignals!.budgetSensitive = 0.75;
  if (implicitSignals[5].re.test(message)) update.featureSignals!.professionalDuty = 0.82;

  const travelToDacha = re(String.raw`(?:\u0431\u0440\u0430\u0442\u044c|\u0432\u043e\u0437\u0438\u0442\u044c|\u0432\u043e\u0437\u044c\u043c\u0443|\u043f\u0435\u0440\u0435\u0432\u043e\u0437\u0438\u0442\u044c).{0,35}(?:\u0434\u0430\u0447[\u0430\u0438\u0443]|\u0443\u0447\u0430\u0441\u0442\u043e\u043a)`).test(message);
  if (travelToDacha) {
    update.implicitNeeds?.push(item(labels.weight, message, 0.62));
    update.featureSignals!.portable = Math.max(update.featureSignals!.portable, 0.76);
    update.featureSignals!.compact = Math.max(update.featureSignals!.compact, 0.68);
    update.featureSignals!.homeUse = Math.max(update.featureSignals!.homeUse, 0.72);
  }

  const constraintSignals = [
    { re: re(String.raw`(?:\u0434\u043e|\u043d\u0435 \u0434\u043e\u0440\u043e\u0436\u0435)\s*\d+`), value: labels.budgetLimit },
    { re: re(String.raw`(?:220|380)\s*\u0432`), value: labels.voltage },
    { re: re(String.raw`(?:\u0431\u0435\u043d\u0437\u0438\u043d|\u0434\u0438\u0437\u0435\u043b|\u0433\u0430\u0437)`), value: labels.fuel },
    { re: re(String.raw`(?:\u0432 \u043d\u0430\u043b\u0438\u0447\u0438\u0438|\u043d\u0430\u043b\u0438\u0447\u0438\u0435|\u0441\u0435\u0433\u043e\u0434\u043d\u044f|\u0441\u0440\u043e\u0447\u043d\u043e)`), value: labels.availability }
  ];

  for (const signal of constraintSignals) {
    if (signal.re.test(message)) update.constraints?.push(item(signal.value, message, 0.7));
  }

  const changedNeed = re(String.raw`(?:\u043d\u0435|\u043d\u0435\u0442|\u0443\u0436\u0435 \u043d\u0435|\u043f\u0435\u0440\u0435\u0434\u0443\u043c\u0430\u043b).{0,20}(?:\u043d\u0443\u0436\u043d|\u0432\u0430\u0436\u043d|\u0445\u043e\u0447\u0443)`).test(message);
  const changedScope = re(String.raw`(?:\u0442\u0435\u043f\u0435\u0440\u044c|\u0432\u043c\u0435\u0441\u0442\u043e|\u0437\u0430\u0431\u0443\u0434|\u043f\u0435\u0440\u0435\u0434\u0443\u043c\u0430\u043b|\u0434\u0430\u0432\u0430\u0439.{0,25}\u0434\u0440\u0443\u0433|\u043b\u0443\u0447\u0448\u0435.{0,25}\u0434\u0440\u0443\u0433)`).test(message);
  if (changedNeed || changedScope) {
    update.contradictions?.push(item(labels.changed, message, 0.65));
  }

  update.lastSummary = summarizeNeedState(mergeNeedState(emptyNeedState(), update));
  return update;
}

export function summarizeNeedState(state: CustomerNeedState) {
  const parts = [
    state.explicitNeeds.length ? `${labels.explicit}: ${state.explicitNeeds.map((x) => x.value).join('; ')}` : '',
    state.implicitNeeds.length ? `${labels.implicit}: ${state.implicitNeeds.map((x) => x.value).join('; ')}` : '',
    state.constraints.length ? `${labels.constraints}: ${state.constraints.map((x) => x.value).join('; ')}` : '',
    state.importantCriteria.length ? `${labels.criteria}: ${state.importantCriteria.map((x) => x.value).join('; ')}` : ''
  ].filter(Boolean);
  return parts.join(' | ');
}
