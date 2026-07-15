import { describe, expect, it } from 'vitest';

import {
  buildEvalLlmRubricJudgeRequest,
  EvalLlmRubricJudgeInputSchema,
  EvalLlmRubricJudgeResultSchema
} from '../src/ai/evalJudge.js';

describe('production LLM eval judge helpers', () => {
  it('builds a structured JSON judge request', () => {
    const request = buildEvalLlmRubricJudgeRequest('Grade this conversation.');

    expect(request.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'system' }),
      expect.objectContaining({ role: 'user', content: 'Grade this conversation.' })
    ]));
    expect(request.text.format.name).toBe('eval_llm_rubric_judge');
    expect(request.reasoning).toEqual({ effort: 'none' });
  });

  it('validates judge input and normalized result shape', () => {
    expect(EvalLlmRubricJudgeInputSchema.parse({ prompt: '  rubric  ' })).toEqual({ prompt: 'rubric' });
    expect(EvalLlmRubricJudgeResultSchema.parse({
      pass: true,
      score: 0.94,
      reason: 'Grounded and useful.'
    })).toEqual({
      pass: true,
      score: 0.94,
      reason: 'Grounded and useful.'
    });
  });
});
