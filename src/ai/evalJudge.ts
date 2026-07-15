import { z } from 'zod';
import { config } from '../config.js';
import { createStructuredJsonResponse } from './openaiStructured.js';

export const EvalLlmRubricJudgeInputSchema = z.object({
  prompt: z.string().trim().min(1).max(120_000)
}).strict();

export const EvalLlmRubricJudgeResultSchema = z.object({
  pass: z.boolean(),
  score: z.number().min(0).max(1),
  reason: z.string().trim().min(1)
}).strict();

export type EvalLlmRubricJudgeResult = z.infer<typeof EvalLlmRubricJudgeResultSchema>;

const evalLlmRubricJudgeFormat = {
  format: {
    type: 'json_schema',
    name: 'eval_llm_rubric_judge',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pass: { type: 'boolean' },
        score: { type: 'number', minimum: 0, maximum: 1 },
        reason: { type: 'string' }
      },
      required: ['pass', 'score', 'reason']
    }
  }
} as const;

export function buildEvalLlmRubricJudgeRequest(prompt: string) {
  return {
    model: config.OPENAI_FACT_MODEL,
    reasoning: { effort: config.OPENAI_FACT_REASONING_EFFORT },
    max_output_tokens: Math.max(config.OPENAI_FACT_MAX_OUTPUT_TOKENS, 700),
    input: [
      {
        role: 'system',
        content: [
          'You are a strict but practical evaluator for the BAKAUT AI sales/support chat.',
          'Evaluate only the rendered grading prompt supplied by Promptfoo.',
          'Return JSON only with pass, score, and reason.',
          'The score must be a number from 0 to 1. Use 0.9 or higher only when the answer is useful, grounded, context-aware, and respects commercial safety boundaries.',
          'Do not reward scripted wording, hallucinated facts, unsafe delivery/discount/stock promises, or product cards that conflict with the answer.'
        ].join('\n')
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    text: evalLlmRubricJudgeFormat
  };
}

export async function runEvalLlmRubricJudge(input: {
  prompt: string;
  signal?: AbortSignal;
}): Promise<EvalLlmRubricJudgeResult> {
  const request = buildEvalLlmRubricJudgeRequest(input.prompt);
  const { parsed } = await createStructuredJsonResponse({
    request,
    stage: 'eval_llm_rubric_judge',
    signal: input.signal
  });
  return EvalLlmRubricJudgeResultSchema.parse(parsed);
}
