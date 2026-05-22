export function needItemSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      value: { type: 'string' },
      evidence: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 }
    },
    required: ['value', 'evidence', 'confidence']
  };
}

function productClassEnum(includeCommercial = false) {
  return includeCommercial
    ? [
        'generator',
        'weldingGenerator',
        'generatorOil',
        'engineOil',
        'generatorAccessory',
        'plateAccessory',
        'plate',
        'rammer',
        'roller',
        'cutter',
        'diamondBlade',
        'diamondCore',
        'trowel',
        'commercial',
        'unknown'
      ]
    : [
        'generator',
        'weldingGenerator',
        'generatorOil',
        'engineOil',
        'generatorAccessory',
        'plateAccessory',
        'plate',
        'rammer',
        'roller',
        'cutter',
        'diamondBlade',
        'diamondCore',
        'trowel',
        'unknown'
      ];
}

export function activeNeedSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      productClass: { type: 'string', enum: productClassEnum(true) },
      summary: { type: 'string' },
      constraints: { type: 'array', items: { type: 'string' }, maxItems: 16 },
      openQuestions: { type: 'array', items: { type: 'string' }, maxItems: 12 },
      selectedProductIds: { type: 'array', items: { type: 'string' }, maxItems: 16 },
      status: { type: 'string', enum: ['open', 'selected', 'paused', 'closed'] }
    },
    required: ['id', 'productClass', 'summary', 'constraints', 'openQuestions', 'selectedProductIds', 'status']
  };
}

export function needExtractionCriteriaSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      productIntent: { type: 'string', enum: productClassEnum() },
      productRole: { type: 'string', enum: ['coreProduct', 'accessory', 'consumable', 'unknown'] },
      fuel: { type: 'string', enum: ['gasoline', 'diesel', 'any', 'unknown'] },
      startType: { type: 'string', enum: ['electric', 'manual', 'any', 'unknown'] },
      enclosure: { type: 'string', enum: ['enclosed', 'open', 'any', 'unknown'] },
      conventionalGenerator: { type: ['boolean', 'null'] },
      singlePhase220: { type: ['boolean', 'null'] },
      budgetMax: { type: ['number', 'null'] },
      weightKgMin: { type: ['number', 'null'] },
      weightKgMax: { type: ['number', 'null'] },
      diameterMmMin: { type: ['number', 'null'] },
      diameterMmMax: { type: ['number', 'null'] },
      nominalPowerKwMin: { type: ['number', 'null'] },
      nominalPowerKwMax: { type: ['number', 'null'] },
      maxPowerKwMin: { type: ['number', 'null'] },
      maxPowerKwMax: { type: ['number', 'null'] },
      brandConstraint: { type: 'string' },
      exactModelConstraint: { type: 'string' },
      mustHaveTraits: { type: 'array', items: { type: 'string' }, maxItems: 16 },
      excludedClasses: { type: 'array', items: { type: 'string', enum: productClassEnum() }, maxItems: 16 },
      powerReasoning: { type: 'string' }
    },
    required: [
      'productIntent',
      'productRole',
      'fuel',
      'startType',
      'enclosure',
      'conventionalGenerator',
      'singlePhase220',
      'budgetMax',
      'weightKgMin',
      'weightKgMax',
      'diameterMmMin',
      'diameterMmMax',
      'nominalPowerKwMin',
      'nominalPowerKwMax',
      'maxPowerKwMin',
      'maxPowerKwMax',
      'brandConstraint',
      'exactModelConstraint',
      'mustHaveTraits',
      'excludedClasses',
      'powerReasoning'
    ]
  };
}

export function loadProfileSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      items: {
        type: 'array',
        maxItems: 16,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string' },
            name: { type: 'string' },
            count: { type: 'number' },
            runningKw: { type: ['number', 'null'] },
            startingKw: { type: ['number', 'null'] },
            source: { type: 'string', enum: ['explicit_user', 'estimated_average', 'web_average', 'catalog_fact'] },
            evidence: { type: 'string' }
          },
          required: ['kind', 'name', 'count', 'runningKw', 'startingKw', 'source', 'evidence']
        }
      },
      simultaneousStarting: { type: 'boolean' },
      simultaneousStartingKinds: { type: 'array', items: { type: 'string' }, maxItems: 8 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      removedKinds: { type: 'array', items: { type: 'string' }, maxItems: 12 }
    },
    required: ['items', 'simultaneousStarting', 'simultaneousStartingKinds', 'confidence', 'removedKinds']
  };
}

export function needExtractionSelectionStateSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      currentProductClass: { type: 'string', enum: productClassEnum() },
      targetProductClass: { type: 'string', enum: productClassEnum() },
      hardConstraints: needExtractionCriteriaSchema(),
      softPreferences: needExtractionCriteriaSchema(),
      unknowns: { type: 'array', items: { type: 'string' }, maxItems: 16 },
      conflicts: { type: 'array', items: { type: 'string' }, maxItems: 16 },
      selectedProductIds: { type: 'array', items: { type: 'string' }, maxItems: 16 },
      loadProfile: loadProfileSchema(),
      confidence: { type: 'number', minimum: 0, maximum: 1 }
    },
    required: [
      'currentProductClass',
      'targetProductClass',
      'hardConstraints',
      'softPreferences',
      'unknowns',
      'conflicts',
      'selectedProductIds',
      'loadProfile',
      'confidence'
    ]
  };
}

export function semanticMemorySchema() {
  const semanticValueSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string' },
      min: { type: ['number', 'null'] },
      max: { type: ['number', 'null'] },
      unit: { type: 'string' },
      productClass: { type: 'string' },
      brand: { type: 'string' },
      amount: { type: ['number', 'null'] }
    },
    required: ['text', 'min', 'max', 'unit', 'productClass', 'brand', 'amount']
  };
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      version: { type: 'number', enum: [1] },
      activeRequirementIds: { type: 'array', items: { type: 'string' }, maxItems: 64 },
      requirements: {
        type: 'array',
        maxItems: 40,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            kind: { type: 'string', enum: ['productClass', 'task', 'weightKg', 'budgetRub', 'powerKw', 'diameterMm', 'brand', 'fuel', 'startType', 'phase'] },
            value: semanticValueSchema,
            status: { type: 'string', enum: ['active', 'superseded', 'rejected', 'paused'] },
            strictness: { type: 'string', enum: ['strictOnly', 'targetRange', 'fallbackAllowed'] },
            evidence: { type: 'string' },
            source: { type: 'string', enum: ['explicit_user', 'llm_inference', 'catalog_fact'] },
            replacesRequirementIds: { type: 'array', items: { type: 'string' }, maxItems: 24 }
          },
          required: ['id', 'kind', 'value', 'status', 'strictness', 'evidence', 'source', 'replacesRequirementIds']
        }
      },
      mentionedProducts: {
        type: 'array',
        maxItems: 40,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            token: { type: 'string' },
            normalizedToken: { type: 'string' },
            role: { type: 'string', enum: ['targetProduct', 'availabilityCheck', 'comparison', 'example', 'compatibilityTarget'] },
            status: { type: 'string', enum: ['unresolved', 'foundInCatalog', 'notFound', 'notMatchingRequirement'] },
            productIds: { type: 'array', items: { type: 'string' }, maxItems: 24 },
            evidence: { type: 'string' }
          },
          required: ['token', 'normalizedToken', 'role', 'status', 'productIds', 'evidence']
        }
      },
      selectionPolicy: {
        type: 'object',
        additionalProperties: false,
        properties: {
          primaryRequirementIds: { type: 'array', items: { type: 'string' }, maxItems: 64 },
          alternativeMode: { type: 'string', enum: ['none', 'afterPrimary', 'fallbackOnly'] },
          explanationRequired: { type: 'boolean' }
        },
        required: ['primaryRequirementIds', 'alternativeMode', 'explanationRequired']
      },
      botCommitments: {
        type: 'array',
        maxItems: 30,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['availability', 'recommendation', 'constraint', 'fact'] },
            text: { type: 'string' },
            productIds: { type: 'array', items: { type: 'string' }, maxItems: 16 },
            evidence: { type: 'string' }
          },
          required: ['kind', 'text', 'productIds', 'evidence']
        }
      }
    },
    required: ['version', 'activeRequirementIds', 'requirements', 'mentionedProducts', 'selectionPolicy', 'botCommitments']
  };
}
