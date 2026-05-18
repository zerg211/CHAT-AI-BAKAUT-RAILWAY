import type {
  AgentToolName,
  AgentToolPlanStepV2,
  AgentToolTraceItem,
  CustomerNeedState,
  Message
} from '../shared/types.js';

export interface AgentToolContext {
  sessionId: string;
  userMessage: string;
  history: Message[];
  needState: CustomerNeedState;
  signal?: AbortSignal;
  policy?: {
    leadAllowed?: boolean;
    webAllowed?: boolean;
    webPurpose?: string;
  };
}

export interface AgentToolResult<T = unknown> {
  tool: AgentToolName;
  ok: boolean;
  risk: 'safe' | 'sensitive';
  result?: T;
  error?: string;
  warnings: string[];
  durationMs: number;
}

export type AgentToolHandler = (
  step: AgentToolPlanStepV2,
  context: AgentToolContext
) => Promise<AgentToolResult> | AgentToolResult;

const sensitiveTools = new Set<AgentToolName>(['createLead']);

function riskForTool(tool: AgentToolName): AgentToolResult['risk'] {
  return sensitiveTools.has(tool) ? 'sensitive' : 'safe';
}

function denied(step: AgentToolPlanStepV2, error: string, startedAt: number): AgentToolResult {
  return {
    tool: step.tool,
    ok: false,
    risk: riskForTool(step.tool),
    error,
    warnings: [`tool_denied:${error}`],
    durationMs: Date.now() - startedAt
  };
}

export class AgentToolRegistry {
  constructor(private readonly handlers: Partial<Record<AgentToolName, AgentToolHandler>> = {}) {}

  async execute(step: AgentToolPlanStepV2, context: AgentToolContext): Promise<AgentToolResult> {
    const startedAt = Date.now();
    if (step.tool === 'createLead' && context.policy?.leadAllowed === false) {
      return denied(step, 'lead_not_allowed_by_policy', startedAt);
    }
    if (step.tool === 'webFactSearch' && context.policy?.webAllowed === false) {
      return denied(step, 'web_not_allowed_by_policy', startedAt);
    }
    const handler = this.handlers[step.tool];
    if (!handler) return denied(step, 'tool_handler_missing', startedAt);
    try {
      const result = await handler(step, context);
      return {
        ...result,
        durationMs: result.durationMs ?? Date.now() - startedAt
      };
    } catch (error) {
      return {
        tool: step.tool,
        ok: false,
        risk: riskForTool(step.tool),
        error: error instanceof Error ? error.message : String(error),
        warnings: ['tool_handler_error'],
        durationMs: Date.now() - startedAt
      };
    }
  }

  async executePlan(steps: AgentToolPlanStepV2[], context: AgentToolContext): Promise<AgentToolResult[]> {
    const results: AgentToolResult[] = [];
    for (const step of steps) {
      results.push(await this.execute(step, context));
    }
    return results;
  }
}

export function toolResultToTrace(step: AgentToolPlanStepV2, result: AgentToolResult): AgentToolTraceItem {
  return {
    tool: result.tool,
    ok: result.ok,
    risk: result.risk,
    reason: step.reason,
    required: step.required,
    durationMs: result.durationMs,
    summary: result.result === undefined ? undefined : String(JSON.stringify(result.result)).slice(0, 500),
    warnings: result.warnings,
    error: result.error
  };
}

export function plannedToolTrace(steps: AgentToolPlanStepV2[]): AgentToolTraceItem[] {
  return steps.map((step) => ({
    tool: step.tool,
    ok: true,
    risk: riskForTool(step.tool),
    reason: step.reason,
    required: step.required,
    summary: 'represented_by_existing_runtime_path',
    warnings: []
  }));
}
