import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('production model configuration', () => {
  it('locks every manager role to GPT-5.6 Luna with bounded production planner effort despite legacy overrides', () => {
    const outputMarker = '__PRODUCTION_MODEL_CONFIG__';
    const script = [
      "import { config } from './src/config.ts';",
      `process.stdout.write('${outputMarker}' + JSON.stringify({`,
      'model: config.OPENAI_MODEL,',
      'answer: config.OPENAI_ANSWER_MODEL,',
      'answerReasoning: config.OPENAI_ANSWER_REASONING_EFFORT,',
      'planner: config.OPENAI_PLANNER_MODEL,',
      'plannerReasoning: config.OPENAI_PLANNER_REASONING_EFFORT,',
      'plannerMaxOutputTokens: config.OPENAI_PLANNER_MAX_OUTPUT_TOKENS,',
      'fact: config.OPENAI_FACT_MODEL,',
      'factReasoning: config.OPENAI_FACT_REASONING_EFFORT,',
      'deepReasoning: config.OPENAI_DEEP_REASONING_MODEL',
      '}));'
    ].join('');
    const stdout = execFileSync(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      script
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        OPENAI_MODEL: 'gpt-5.4-mini',
        OPENAI_ANSWER_MODEL: 'gpt-5.4',
        OPENAI_ANSWER_REASONING_EFFORT: 'xhigh',
        OPENAI_PLANNER_MODEL: 'gpt-5.5',
        OPENAI_PLANNER_REASONING_EFFORT: 'xhigh',
        OPENAI_PLANNER_MAX_OUTPUT_TOKENS: '9000',        OPENAI_FACT_MODEL: 'gpt-5.6-luna',
        OPENAI_FACT_REASONING_EFFORT: 'xhigh',
        OPENAI_DEEP_REASONING_MODEL: 'gpt-5.6-sol'
      }
    });

    const markerIndex = stdout.lastIndexOf(outputMarker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(stdout.slice(markerIndex + outputMarker.length))).toEqual({
      model: 'gpt-5.6-luna',
      answer: 'gpt-5.6-luna',
      answerReasoning: 'high',
      planner: 'gpt-5.6-luna',
      plannerReasoning: 'low',
      plannerMaxOutputTokens: 9000,
      fact: 'gpt-5.6-luna',
      factReasoning: 'xhigh',
      deepReasoning: 'gpt-5.6-luna'
    });
  });
});
