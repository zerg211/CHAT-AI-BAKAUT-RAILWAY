# Production baseline failure — audit v16

Surface: embedded widget on `https://bakautprof.ru/`.

Production commit at audit start: `f41f99ca015cc63c27696becbf1db41dfdefed66`.

Runtime marker: `2026-07-15.gpt-5-6-terra-latency-headroom-v15`.

Session: `7e531202-dee1-4576-ae88-2aac09b453c0`.

Conversation: `1782`.

Failed turn: `00f5d97a-14f4-42d9-980d-71bd81f461de`.

## Adaptive transcript summary

1. The buyer described a household generator task. The assistant asked a useful load clarification. Buyer-visible duration was about 36 seconds.
2. The assistant produced a preliminary recommendation around 4 kW and visible cards. Buyer-visible duration was about 71.5 seconds.
3. The buyer changed a hard requirement: automatic start on mains failure, maximum budget 60,000 RUB, and asked which previously shown option remained. After more than 120 seconds, the widget showed a generic failure rather than a product answer.

The previous visible evidence included `ТСС SGG 5000EHNA`, 5 kW, 230 V, automatic start, catalog price 57,247 RUB.

## Internal trace summary

- Planner semantic result was correct: `needAction=refine_current`, `selectionGoal=preliminary_fit`, `reusePreviousCards=true`, strict single-phase/220 V/automatic-start/budget requirements.
- Generator calculator discarded unchanged unnamed household loads after the planner labelled them `unbounded_guess`.
- Deterministic catalog gate denied a read-only catalog search as `generator_load_unconfirmed_basis`.
- Web research failed after about 19 seconds.
- Compose/review recovery reused the same denied/error evidence repeatedly and ended in `status=failed`, `stage=recovery_failed`, `errorCode=agent_manager_recovery_failed`.

This baseline is failure evidence only. It is not post-fix proof. The affected behavior must be repeated after GitHub push and Railway deployment through the same embedded production widget.
