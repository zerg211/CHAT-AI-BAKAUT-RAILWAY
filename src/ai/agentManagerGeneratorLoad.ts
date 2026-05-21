import type { ProductElectricalLoadItem } from '../shared/types.js';
import type { ToolRequest } from './agentManagerContracts.js';
import { calculateGeneratorLoadProfile, canonicalElectricalLoadKind } from './loadProfile.js';

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
  if (!['unknown', 'unknown_load', 'load', 'consumer'].includes(canonicalKind)) return canonicalKind;
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

function loadsFromArgs(args: Record<string, unknown>, fallbackEvidence: string): {
  loads: ProductElectricalLoadItem[];
  warnings: string[];
} {
  const rawLoads = Array.isArray(args.loads) ? args.loads : [];
  const warnings = new Set<string>();
  const loads: ProductElectricalLoadItem[] = rawLoads
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    .map<ProductElectricalLoadItem>((item) => ({
      kind: canonicalToolLoadKind(item.kind, item.name),
      name: typeof item.name === 'string' && item.name.trim() ? item.name : undefined,
      count: countFromToolArg(item.count),
      runningKw: positiveNumberFromToolArg(item.runningKw),
      startingKw: positiveNumberFromToolArg(item.startingKw),
      source: sourceFromToolArg(item.source),
      evidence: typeof item.evidence === 'string' && item.evidence.trim() ? item.evidence : fallbackEvidence
    }))
    .filter((item) => item.runningKw !== undefined || item.startingKw !== undefined);

  if (rawLoads.length && !loads.length) warnings.add('generator_load_structured_args_without_usable_kw');
  return { loads, warnings: [...warnings] };
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
  return { loads, profile, warnings };
}
