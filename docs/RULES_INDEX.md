# Карта правил и источников истины

Этот файл — навигация, а не дополнительный набор правил.

## Авторитетность

1. `AGENTS.md` — цель продукта, граница LLM/кода, обязательный proof loop и production-widget gate.
2. Исполняемый код и схемы в `src/ai/agentManager*` — фактический runtime.
3. Текущие документы ниже — объяснение действующей архитектуры и эксплуатации.
4. `.agent/tasks/*` — evidence конкретных задач, не постоянная product policy.
5. `local-live-tests/*` — протоколы конкретных версий, не инструкции для runtime.
6. Удалённые plans/reports доступны через Git history и не являются текущими указаниями.

## Текущие документы

- `ARCHITECTURE.md` — runtime и граница LLM/кода;
- `DOMAIN_AGENT_BLUEPRINT.md` — целевая предметная область, источники знаний и граница обучения/RAG;
- `ASSISTANT_BEHAVIOR.md` — ожидаемое поведение покупательского диалога;
- `SALES_MANAGER_BEHAVIOR_POLICY.md` — бизнес-политика менеджера;
- `CATALOG_PIPELINE.md` — каталог, freshness и embeddings;
- `EVALS.md` — локальные проверки и evals;
- `PROMPTFOO_EVALS.md` — дополнительный production-backed eval, не замена widget gate;
- `LOCAL_LIVE_TESTING.md` — обязательная живая проверка;
- `RAILWAY_DEPLOY.md` — GitHub/Railway deployment workflow.

## Правило изменения поведения

Не добавлять новый продуктовый regex, phrase patch или global prompt-правило после одного плохого диалога. Семантическое решение принадлежит LLM contract; код проверяет факты, hard constraints, permissions, side effects и согласованность evidence/cards/answer. Повторяющийся доменный факт должен стать структурированным knowledge/tool evidence или eval, а не ещё одной глобальной фразой.
