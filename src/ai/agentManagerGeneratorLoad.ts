import type { ProductElectricalLoadItem, ProductSelectionClass } from '../shared/types.js';
import type { ToolRequest, ToolResult } from './agentManagerContracts.js';
import { calculateGeneratorLoadProfile, canonicalElectricalLoadKind } from './loadProfile.js';

const loadProductClassAliases = new Set(['generator', 'weldinggenerator', 'welding_generator', 'platecompactor', 'plate_compactor']);

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

function canonicalToolLoadKind(kind: unknown, name: unknown) {
  const canonicalKind = canonicalElectricalLoadKind(typeof kind === 'string' ? kind : undefined);
  if (
    canonicalKind &&
    !loadProductClassAliases.has(compactLoadToken(kind)) &&
    !loadProductClassAliases.has(canonicalKind) &&
    !['unknown', 'unknown_load', 'load', 'consumer'].includes(canonicalKind)
  ) {
    return canonicalKind;
  }
  return canonicalElectricalLoadKind(typeof name === 'string' ? name : undefined);
}

function sourceFromToolArg(value: unknown): ProductElectricalLoadItem['source'] {
  return value === 'web_average' || value === 'catalog_fact' || value === 'estimated_average'
    ? value
    : 'explicit_user';
}

function generatorLoadEvidenceForToolRequest(request: ToolRequest, userMessage: string) {
  return [
    userMessage,
    typeof request.args.semanticQuery === 'string' ? request.args.semanticQuery : '',
    typeof request.args.query === 'string' ? request.args.query : '',
    typeof request.args.reason === 'string' ? request.args.reason : '',
    request.rationale,
    Array.isArray(request.args.simultaneousStartingKinds)
      ? request.args.simultaneousStartingKinds.filter((item): item is string => typeof item === 'string').join(' ')
      : ''
  ].filter(Boolean).join('\n');
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isProductClassLoadKind(value: unknown) {
  return loadProductClassAliases.has(compactLoadToken(value));
}

function loadsFromArgs(args: Record<string, unknown>, fallbackEvidence: string): {
  loads: ProductElectricalLoadItem[];
  warnings: string[];
} {
  const rawLoads = Array.isArray(args.loads) ? args.loads : [];
  const warnings = new Set<string>();
  const loads: ProductElectricalLoadItem[] = [];

  for (const item of rawLoads) {
    if (!isObjectRecord(item)) continue;
    if (isProductClassLoadKind(item.kind)) {
      warnings.add('generator_load_invalid_load_kind');
      continue;
    }
    const load: ProductElectricalLoadItem = {
      kind: canonicalToolLoadKind(item.kind, item.name),
      name: typeof item.name === 'string' && item.name.trim() ? item.name : undefined,
      count: countFromToolArg(item.count),
      runningKw: positiveNumberFromToolArg(item.runningKw),
      startingKw: positiveNumberFromToolArg(item.startingKw),
      source: sourceFromToolArg(item.source),
      evidence: typeof item.evidence === 'string' && item.evidence.trim() ? item.evidence : fallbackEvidence
    };
    if (load.runningKw !== undefined || load.startingKw !== undefined) {
      loads.push(load);
    }
  }

  if (rawLoads.length && !loads.length) warnings.add('generator_load_structured_args_without_usable_kw');
  return { loads, warnings: [...warnings] };
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
    isEstimateOnlyGeneratorLoadPayload(result.payload);
}

export function hasEstimateOnlyGeneratorLoadResult(results: ToolResult[]) {
  return results.some(isEstimateOnlyGeneratorLoadResult);
}

function hasUnconfirmedGeneratorLoadBasisWarning(result: ToolResult) {
  return result.warnings.includes('generator_load_estimate_only') ||
    result.warnings.includes('generator_load_invalid_load_kind');
}

export function hasUnconfirmedGeneratorLoadBasisResult(results: ToolResult[]) {
  return results.some((result) =>
    result.tool === 'calculator.generatorLoad' &&
    (isEstimateOnlyGeneratorLoadResult(result) || hasUnconfirmedGeneratorLoadBasisWarning(result))
  );
}

export function buildGeneratorLoadToolPayload(input: {
  request: ToolRequest;
  userMessage: string;
}) {
  const loadEvidence = generatorLoadEvidenceForToolRequest(input.request, input.userMessage);
  const { loads, warnings } = loadsFromArgs(input.request.args, loadEvidence);
  const profile = calculateGeneratorLoadProfile(loads, {
    simultaneousStarting: input.request.args.simultaneousStarting === true,
    simultaneousStartingKinds: Array.isArray(input.request.args.simultaneousStartingKinds)
      ? input.request.args.simultaneousStartingKinds.filter((item): item is string => typeof item === 'string')
      : undefined
  });
  if (profile && isEstimateOnlyGeneratorLoadPayload({ loads })) {
    warnings.push('generator_load_estimate_only');
  }
  return { loads, profile, warnings };
}
