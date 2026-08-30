import type { ProductElectricalLoadItem, ProductSelectionClass } from '../shared/types.js';
import type { ToolRequest, ToolResult } from './agentManagerContracts.js';
import { calculateGeneratorLoadProfile, canonicalElectricalLoadKind } from './loadProfile.js';

const loadProductClassAliases = new Set(['generator', 'weldinggenerator', 'welding_generator', 'platecompactor', 'plate_compactor']);
const ambiguousWeldingLoadAliases = new Set(['weldinggenerator', 'welding_generator']);
const generatorLoadEstimateBases = new Set(['exact_or_user_provided', 'catalog_or_web_fact', 'bounded_assumption', 'unbounded_guess']);
const generatorLoadBasisSignals = new Set([
  'consumer_type_known',
  'consumer_function_known',
  'voltage_or_phase_known',
  'usage_scope_known',
  'simultaneous_operation_known',
  'buyer_requested_approximation',
  'catalog_or_web_fact',
  'explicit_power'
]);
const generatorLoadBasisKinds = new Set([
  'exact_power',
  'checked_fact',
  'specific_type_or_function',
  'generic_load_name',
  'unknown'
]);
const motorLikeLoadKinds = new Set(['pump', 'compressor', 'pressure_washer', 'vacuum', 'concrete_mixer']);
type GeneratorLoadToolItem = ProductElectricalLoadItem & {
  basisSignals?: string[];
  basisKind?: string;
};

function compactLoadToken(value: unknown) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replaceAll(' ', '_').replaceAll('-', '_')
    : '';
}

function positiveNumberFromToolArg(value: unknown) {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function countFromToolArg(value: unknown) {
  const parsed = Number(value ?? 1);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(1, Math.min(12, Math.round(parsed)))
    : 1;
}

function canonicalToolLoadKind(kind: unknown) {
  const canonicalKind = canonicalElectricalLoadKind(typeof kind === 'string' ? kind : undefined);
  if (
    canonicalKind &&
    !loadProductClassAliases.has(compactLoadToken(kind)) &&
    !loadProductClassAliases.has(canonicalKind) &&
    !['unknown', 'unknown_load', 'load', 'consumer'].includes(canonicalKind)
  ) {
    return canonicalKind;
  }
  return undefined;
}

function sourceFromToolArg(value: unknown): ProductElectricalLoadItem['source'] | undefined {
  return value === 'web_average' || value === 'catalog_fact' || value === 'estimated_average'
    ? value
    : value === 'explicit_user' ? value : undefined;
}

function powerSourceFromToolArg(value: unknown) {
  return value === 'web_average' || value === 'catalog_fact' || value === 'estimated_average' ||
    value === 'explicit_user' || value === 'not_provided'
    ? value
    : undefined;
}

function operationModeFromToolArg(value: unknown) {
  return value === 'continuous' || value === 'occasional' || value === 'separate'
    ? value
    : undefined;
}

function estimateBasisFromToolArg(value: unknown) {
  return typeof value === 'string' && generatorLoadEstimateBases.has(value)
    ? value
    : undefined;
}

function basisSignalsFromToolArg(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string =>
    typeof item === 'string' && generatorLoadBasisSignals.has(item)
  ))];
}

function basisKindFromToolArg(value: unknown) {
  return typeof value === 'string' && generatorLoadBasisKinds.has(value)
    ? value
    : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isProductClassLoadKind(value: unknown) {
  return loadProductClassAliases.has(compactLoadToken(value));
}

function isConcreteWeldingInverterLoad(kind: unknown, name: unknown) {
  return ambiguousWeldingLoadAliases.has(compactLoadToken(kind)) &&
    canonicalElectricalLoadKind(typeof name === 'string' ? name : undefined) === 'welding_inverter';
}

function loadsFromArgs(args: { loads?: unknown[] }): {
  loads: GeneratorLoadToolItem[];
  warnings: string[];
} {
  const rawLoads = Array.isArray(args.loads) ? args.loads : [];
  const warnings = new Set<string>();
  const loads: GeneratorLoadToolItem[] = [];

  for (const item of rawLoads) {
    if (!isObjectRecord(item)) continue;
    if (isProductClassLoadKind(item.kind) && !isConcreteWeldingInverterLoad(item.kind, item.name)) {
      warnings.add('generator_load_invalid_load_kind');
      continue;
    }
    const kind = isConcreteWeldingInverterLoad(item.kind, item.name)
      ? 'welding_inverter'
      : canonicalToolLoadKind(item.kind);
    const source = sourceFromToolArg(item.source);
    const operationMode = operationModeFromToolArg(item.operationMode);
    const evidence = typeof item.evidence === 'string' && item.evidence.trim() ? item.evidence : undefined;
    if (!kind || !source || !operationMode || !evidence) {
      warnings.add('generator_load_missing_llm_semantic_fields');
      continue;
    }
    const load: GeneratorLoadToolItem = {
      kind,
      name: typeof item.name === 'string' && item.name.trim() ? item.name : undefined,
      count: countFromToolArg(item.count),
      runningKw: positiveNumberFromToolArg(item.runningKw),
      startingKw: positiveNumberFromToolArg(item.startingKw),
      source,
      runningSource: powerSourceFromToolArg(item.runningSource),
      startingSource: powerSourceFromToolArg(item.startingSource),
      operationMode,
      coRunningGroup: typeof item.coRunningGroup === 'string' && item.coRunningGroup.trim()
        ? item.coRunningGroup.trim()
        : undefined,
      evidence,
      basisSignals: basisSignalsFromToolArg(item.basisSignals),
      basisKind: basisKindFromToolArg(item.basisKind)
    };
    if (load.runningKw !== undefined || load.startingKw !== undefined) {
      loads.push(load);
      continue;
    }
    const loadKind = canonicalElectricalLoadKind(load.kind);
    if (
      load.basisKind === 'generic_load_name' ||
      load.basisKind === 'unknown' ||
      (loadKind !== undefined && motorLikeLoadKinds.has(loadKind))
    ) {
      warnings.add('generator_load_bounded_basis_incomplete');
    }
  }

  if (rawLoads.length && !loads.length) warnings.add('generator_load_structured_args_without_usable_kw');
  return { loads, warnings: [...warnings] };
}

function hasAnyBasisSignal(load: GeneratorLoadToolItem, signals: string[]) {
  return signals.some((signal) => load.basisSignals?.includes(signal));
}

function hasBoundedEstimatedLoadBasis(load: GeneratorLoadToolItem) {
  if (load.source !== 'estimated_average') return true;
  if (load.basisKind === 'exact_power' || load.basisKind === 'checked_fact') return true;
  if (hasAnyBasisSignal(load, ['explicit_power', 'catalog_or_web_fact'])) return true;
  const kind = canonicalElectricalLoadKind(load.kind);
  if (!kind || kind === 'unknown' || kind === 'unknown_load') return false;
  if (
    load.basisKind !== 'specific_type_or_function' &&
    load.basisKind !== 'generic_load_name'
  ) return false;
  if (motorLikeLoadKinds.has(kind)) {
    if (load.basisKind !== 'specific_type_or_function') return false;
    return hasAnyBasisSignal(load, ['consumer_type_known', 'consumer_function_known']) &&
      hasAnyBasisSignal(load, ['voltage_or_phase_known']);
  }
  if (kind === 'handheld_tool') {
    if (load.basisKind !== 'specific_type_or_function') return false;
    return hasAnyBasisSignal(load, ['consumer_type_known']) &&
      hasAnyBasisSignal(load, ['usage_scope_known', 'simultaneous_operation_known']);
  }
  return hasAnyBasisSignal(load, ['consumer_type_known', 'consumer_function_known', 'usage_scope_known']);
}

function hasBoundedAssumptionBasis(loads: GeneratorLoadToolItem[]) {
  return loads.length > 0 && loads.every(hasBoundedEstimatedLoadBasis);
}

export function isGeneratorProductClass(value: ProductSelectionClass) {
  return value === 'generator' || value === 'weldingGenerator';
}

export function isEstimateOnlyGeneratorLoadPayload(payload: unknown) {
  if (!isObjectRecord(payload) || !Array.isArray(payload.loads) || !payload.loads.length) return false;
  return payload.loads.every((load) =>
    isObjectRecord(load) && load.source === 'estimated_average'
  );
}

export function isEstimateOnlyGeneratorLoadResult(result: ToolResult) {
  return result.tool === 'calculator.generatorLoad' &&
    result.status === 'ok' &&
    isEstimateOnlyGeneratorLoadPayload(result.payload) &&
    !result.warnings.includes('generator_load_bounded_assumption');
}

export function hasEstimateOnlyGeneratorLoadResult(results: ToolResult[]) {
  return results.some(isEstimateOnlyGeneratorLoadResult);
}

function hasUnconfirmedGeneratorLoadBasisWarning(result: ToolResult) {
  return result.warnings.includes('generator_load_estimate_only') ||
    result.warnings.includes('generator_load_bounded_assumption') ||
    result.warnings.includes('generator_load_unbounded_guess') ||
    result.warnings.includes('generator_load_bounded_basis_incomplete') ||
    result.warnings.includes('generator_load_invalid_load_kind');
}

function hasGeneratorLoadBasisWarningThatBlocksPreliminaryFit(result: ToolResult) {
  return result.warnings.includes('generator_load_estimate_only') ||
    result.warnings.includes('generator_load_unbounded_guess') ||
    result.warnings.includes('generator_load_invalid_load_kind');
}

export function hasUnconfirmedGeneratorLoadBasisResult(results: ToolResult[]) {
  return results.some((result) =>
    result.tool === 'calculator.generatorLoad' &&
    (isEstimateOnlyGeneratorLoadResult(result) || hasUnconfirmedGeneratorLoadBasisWarning(result))
  );
}

/**
 * A vague/unbounded calculation cannot support a preliminary fit claim. This is
 * intentionally narrower than hasUnconfirmedGeneratorLoadBasisResult: an
 * incomplete bounded calculation may still accompany catalog browsing or a
 * clearly labelled preliminary shortlist, while remaining insufficient for a
 * final purchase-safe recommendation.
 */
export function hasGeneratorLoadBasisThatBlocksPreliminaryFit(results: ToolResult[]) {
  return results.some((result) =>
    result.tool === 'calculator.generatorLoad' &&
    result.status === 'ok' &&
    (isEstimateOnlyGeneratorLoadResult(result) || hasGeneratorLoadBasisWarningThatBlocksPreliminaryFit(result))
  );
}

export function buildGeneratorLoadToolPayload(input: {
  request: ToolRequest;
  userMessage: string;
}) {
  const { loads, warnings } = loadsFromArgs(input.request.args);
  const requestedEstimateBasis = estimateBasisFromToolArg(input.request.args.estimateBasis);
  const hasEstimatedLoads = loads.some((load) => load.source === 'estimated_average');
  const boundedEstimateBasis = hasEstimatedLoads && hasBoundedAssumptionBasis(loads);
  const estimateBasis = hasEstimatedLoads
    ? boundedEstimateBasis ? 'bounded_assumption' : 'unbounded_guess'
    : requestedEstimateBasis;
  const profile = calculateGeneratorLoadProfile(loads, {
    simultaneousRunning: input.request.args.simultaneousRunning === true,
    simultaneousStarting: input.request.args.simultaneousStarting === true,
    simultaneousStartingKinds: Array.isArray(input.request.args.simultaneousStartingKinds)
      ? input.request.args.simultaneousStartingKinds.filter((item): item is string => typeof item === 'string')
      : undefined
  });
  if (profile && hasEstimatedLoads) {
    if (boundedEstimateBasis) {
      warnings.push('generator_load_bounded_assumption');
    } else {
      warnings.push('generator_load_bounded_basis_incomplete', 'generator_load_unbounded_guess');
    }
  }
  return { loads, profile, estimateBasis: estimateBasis ?? null, warnings };
}
