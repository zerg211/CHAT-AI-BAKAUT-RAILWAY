function normalize(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function lower(value) {
  return normalize(value).toLocaleLowerCase('ru');
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

export function detectActionableAssistantQuestion(assistantText) {
  const text = lower(assistantText);
  if (!text) return null;
  const asksQuestion = /\?/u.test(text) ||
    hasAny(text, [/уточните/iu, /подскажите/iu, /нужно понять/iu, /важно понять/iu]);
  if (!asksQuestion) return null;

  const questionScope = text.includes('?')
    ? text.split('?').slice(0, -1).map((segment) => segment.split(/[.!]/u).at(-1) ?? segment).join('?')
    : text;
  const topics = [];
  if (hasAny(questionScope, [/380\s*в/iu, /220\s*в/iu, /фаз/iu, /напряж/iu])) topics.push('voltage');
  if (hasAny(questionScope, [/одновременно/iu, /вместе/iu, /старт/iu, /запуск/iu, /ворот/iu, /морозиль/iu])) topics.push('simultaneous_start');
  const asksPumpDetails = /насос[^?!.]{0,90}(?:мощност|квт|вт|шильдик|модель|какой|тип)|(?:мощност|квт|вт|шильдик|модель|какой|тип)[^?!.]{0,90}насос/iu.test(questionScope);
  if (asksPumpDetails) {
    topics.push('pump_details');
  }
  if (hasAny(questionScope, [/площад/iu, /основан/iu, /материал/iu, /песок/iu, /щеб/iu, /плитк/iu, /грунт/iu])) topics.push('job_surface');
  if (hasAny(questionScope, [/бюджет/iu, /цен/iu, /дешев/iu, /дорог/iu])) topics.push('budget');

  if (!topics.length) return null;
  return {
    kind: 'assistant_clarification',
    topics: [...new Set(topics)],
    evidence: normalize(assistantText)
  };
}

function userAnswersTopic(userText, topic) {
  const text = lower(userText);
  if (topic === 'voltage') {
    return hasAny(text, [/220\s*в/iu, /380\s*в/iu, /однофаз/iu, /тр[её]хфаз/iu, /обычн/iu, /нет\s+380/iu]);
  }
  if (topic === 'simultaneous_start') {
    return hasAny(text, [/одновременно/iu, /вместе/iu, /по очеред/iu, /редко/iu, /могут/iu, /не могут/iu, /старт/iu, /запуск/iu, /ворот/iu, /морозиль/iu]);
  }
  if (topic === 'pump_details') {
    return hasAny(text, [/насос/iu, /квт/iu, /вт/iu, /750/iu, /модель/iu, /шильдик/iu, /не знаю/iu, /не помню/iu, /точно/iu]);
  }
  if (topic === 'job_surface') {
    return hasAny(text, [/площад/iu, /основан/iu, /материал/iu, /песок/iu, /щеб/iu, /плитк/iu, /грунт/iu, /асфальт/iu, /бетон/iu]);
  }
  if (topic === 'budget') {
    return hasAny(text, [/бюджет/iu, /цен/iu, /дешев/iu, /дорог/iu, /\d+\s*(?:тыс|руб|₽)/iu]);
  }
  return false;
}

export function answersActionableAssistantQuestion(question, userText) {
  if (!question) return true;
  return question.topics.every((topic) => userAnswersTopic(userText, topic));
}

export function dialogueContinuityIssues(steps) {
  const issues = [];
  for (let index = 0; index < steps.length - 1; index += 1) {
    const question = detectActionableAssistantQuestion(steps[index]?.assistant);
    if (!question) continue;
    const nextUser = steps[index + 1]?.user ?? '';
    if (answersActionableAssistantQuestion(question, nextUser)) continue;
    issues.push({
      previousStepIndex: index,
      nextStepIndex: index + 1,
      kind: question.kind,
      topics: question.topics,
      message: `assistant clarification was ignored before next buyer turn; missing answer topics: ${question.topics.join(', ')}`,
      evidence: question.evidence,
      nextUser: normalize(nextUser)
    });
  }
  return issues;
}
