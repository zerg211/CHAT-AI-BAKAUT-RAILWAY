export function agentContractV2Schema() {
  const agentSources = ['catalog', 'visible_cards', 'web', 'specialist', 'conversation_memory'];
  const stringArray = (maxItems: number) => ({ type: 'array', items: { type: 'string' }, maxItems });
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      version: { type: 'number', enum: [2] },
      intent: {
        type: 'string',
        enum: [
          'product_selection',
          'technical_answer',
          'comparison',
          'exact_model_lookup',
          'availability_check',
          'delivery_or_discount',
          'lead_handoff',
          'offtopic'
        ]
      },
      answerTask: {
        type: 'string',
        enum: ['technical_explanation', 'comparison', 'product_selection', 'mixed', 'lead_handoff']
      },
      taskType: {
        type: 'string',
        enum: [
          'pure_delivery',
          'pure_availability',
          'product_selection',
          'product_selection_with_delivery',
          'product_selection_with_availability',
          'technical_answer',
          'comparison',
          'contact_refusal_continue_selection'
        ]
      },
      catalogAction: {
        type: 'string',
        enum: ['none', 'exact_model_lookup', 'find_matching_products', 'verify_catalog_absence']
      },
      commercialAction: {
        type: 'string',
        enum: ['none', 'explain_manager_required', 'offer_contact_after_answer']
      },
      productCardsPolicy: {
        type: 'string',
        enum: ['none', 'show_exact_matches', 'show_matching_products', 'supporting_only']
      },
      cardsRole: {
        type: 'string',
        enum: ['none', 'supporting', 'primary']
      },
      leadPolicy: {
        type: 'string',
        enum: ['none', 'forbidden', 'optional_after_answer', 'required_now']
      },
      sourcePolicy: {
        type: 'object',
        additionalProperties: false,
        properties: {
          allowed: { type: 'array', items: { type: 'string', enum: agentSources }, maxItems: 5 },
          required: { type: 'array', items: { type: 'string', enum: agentSources }, maxItems: 5 },
          forbidden: { type: 'array', items: { type: 'string', enum: agentSources }, maxItems: 5 },
          webPurpose: { type: 'string', enum: ['technical_specs', 'manual_or_service', 'current_lineup', 'none'] }
        },
        required: ['allowed', 'required', 'forbidden', 'webPurpose']
      },
      needDelta: {
        type: 'object',
        additionalProperties: false,
        properties: {
          newRequirements: stringArray(16),
          confirmedRequirements: stringArray(16),
          changedRequirements: stringArray(16),
          supersededRequirementIds: stringArray(16),
          rejectedProductIds: stringArray(24)
        },
        required: [
          'newRequirements',
          'confirmedRequirements',
          'changedRequirements',
          'supersededRequirementIds',
          'rejectedProductIds'
        ]
      },
      missingFacts: stringArray(12),
      toolPlan: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tool: {
              type: 'string',
              enum: [
                'searchCatalog',
                'getProductDetails',
                'selectProducts',
                'compareProducts',
                'webFactSearch',
                'createLeadDraft',
                'createLead'
              ]
            },
            reason: { type: 'string' },
            required: { type: 'boolean' },
            inputHint: {
              type: 'object',
              additionalProperties: false,
              properties: {},
              required: []
            }
          },
          required: ['tool', 'reason', 'required', 'inputHint']
        }
      },
      selectedProductIds: stringArray(24),
      rejectedProductIds: stringArray(24),
      mustAnswerNow: stringArray(8),
      currentFocus: { type: 'string' },
      errorRecoveryPriority: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      warnings: stringArray(24)
    },
    required: [
      'version',
      'intent',
      'answerTask',
      'taskType',
      'catalogAction',
      'commercialAction',
      'productCardsPolicy',
      'cardsRole',
      'leadPolicy',
      'sourcePolicy',
      'needDelta',
      'missingFacts',
      'toolPlan',
      'selectedProductIds',
      'rejectedProductIds',
      'mustAnswerNow',
      'currentFocus',
      'errorRecoveryPriority',
      'confidence',
      'warnings'
    ]
  };
}

export function turnPlanSchema(selectedProductMaxItems: number) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: [
          'answer_question',
          'recommend_products',
          'ask_clarifying_question',
          'verify_with_web',
          'collect_lead',
          'handoff_specialist'
        ]
      },
      answerMode: {
        type: 'string',
        enum: [
          'short',
          'productRecommendation',
          'detailedFact',
          'serviceCostComparison',
          'currentLineup',
          'leadCollection',
          'unknown'
        ]
      },
      cardPolicy: {
        type: 'string',
        enum: ['auto', 'showProducts', 'showAccessories', 'textOnly']
      },
      followUpPolicy: {
        type: 'string',
        enum: [
          'auto',
          'answerNowNoDeferredOffer',
          'askClarifyingQuestion',
          'offerNextStepAllowed',
          'collectLead'
        ]
      },
      contextScope: {
        type: 'string',
        enum: ['latestMessageOnly', 'activeNeed', 'previousSelection', 'fullSession']
      },
      searchScope: {
        type: 'string',
        enum: ['focusedNeed', 'broadenAlternatives', 'sameBrandOnly', 'previousSelectionOnly']
      },
      catalogSearchQuery: { type: 'string' },
      selectedProductIds: {
        type: 'array',
        items: { type: 'string' },
        maxItems: selectedProductMaxItems
      },
      requiredProductTraits: {
        type: 'object',
        additionalProperties: false,
        properties: {
          productIntent: {
            type: 'string',
            enum: [
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
            ]
          },
          productRole: {
            type: 'string',
            enum: ['coreProduct', 'accessory', 'consumable', 'unknown']
          },
          fuel: {
            type: 'string',
            enum: ['gasoline', 'diesel', 'any', 'unknown']
          },
          startType: {
            type: 'string',
            enum: ['electric', 'manual', 'any', 'unknown']
          },
          enclosure: {
            type: 'string',
            enum: ['enclosed', 'open', 'any', 'unknown']
          },
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
          'powerReasoning'
        ]
      },
      selectionState: {
        type: 'object',
        additionalProperties: false,
        properties: {
          currentProductClass: {
            type: 'string',
            enum: [
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
            ]
          },
          targetProductClass: {
            type: 'string',
            enum: [
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
            ]
          },
          compatibilityTargetProduct: { type: 'string' },
          mustHaveTraits: { type: 'array', items: { type: 'string' }, maxItems: 16 },
          niceToHaveTraits: { type: 'array', items: { type: 'string' }, maxItems: 16 },
          excludedClasses: {
            type: 'array',
            items: {
              type: 'string',
              enum: [
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
              ]
            },
            maxItems: 16
          },
          brandConstraint: { type: 'string' },
          exactModelConstraint: { type: 'string' },
          isAccessoryFollowUp: { type: 'boolean' },
          selectionConfidence: { type: 'number', minimum: 0, maximum: 1 },
          shouldShowCards: { type: 'boolean' },
          cardDisplayMode: {
            type: 'string',
            enum: ['exact_matches', 'compatible_accessories', 'alternatives', 'structured_selection', 'preliminary', 'none']
          }
        },
        required: [
          'currentProductClass',
          'targetProductClass',
          'compatibilityTargetProduct',
          'mustHaveTraits',
          'niceToHaveTraits',
          'excludedClasses',
          'brandConstraint',
          'exactModelConstraint',
          'isAccessoryFollowUp',
          'selectionConfidence',
          'shouldShowCards',
          'cardDisplayMode'
        ]
      },
      agentContractV2: agentContractV2Schema(),
      agentDecision: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answerTask: {
            type: 'string',
            enum: ['technical_explanation', 'comparison', 'product_selection', 'mixed', 'lead_handoff']
          },
          taskType: {
            type: 'string',
            enum: [
              'pure_delivery',
              'pure_availability',
              'product_selection',
              'product_selection_with_delivery',
              'product_selection_with_availability',
              'technical_answer',
              'comparison',
              'contact_refusal_continue_selection'
            ]
          },
          catalogAction: {
            type: 'string',
            enum: ['none', 'exact_model_lookup', 'find_matching_products', 'verify_catalog_absence']
          },
          commercialAction: {
            type: 'string',
            enum: ['none', 'explain_manager_required', 'offer_contact_after_answer']
          },
          productCardsPolicy: {
            type: 'string',
            enum: ['none', 'show_exact_matches', 'show_matching_products', 'supporting_only']
          },
          mustAnswerNow: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 8
          },
          currentFocus: { type: 'string' },
          cardsRole: {
            type: 'string',
            enum: ['none', 'supporting', 'primary']
          },
          leadAllowed: { type: 'boolean' },
          leadAllowedReason: { type: 'string' },
          errorRecoveryPriority: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        },
        required: [
          'answerTask',
          'taskType',
          'catalogAction',
          'commercialAction',
          'productCardsPolicy',
          'mustAnswerNow',
          'currentFocus',
          'cardsRole',
          'leadAllowed',
          'leadAllowedReason',
          'errorRecoveryPriority',
          'confidence'
        ]
      },
      needsWebSearch: { type: 'boolean' },
      missingInformation: {
        type: 'array',
        items: { type: 'string' }
      },
      answerGuidance: { type: 'string' }
    },
    required: [
      'action',
      'answerMode',
      'cardPolicy',
      'followUpPolicy',
      'contextScope',
      'searchScope',
      'catalogSearchQuery',
      'selectedProductIds',
      'requiredProductTraits',
      'selectionState',
      'agentContractV2',
      'agentDecision',
      'needsWebSearch',
      'missingInformation',
      'answerGuidance'
    ]
  };
}
