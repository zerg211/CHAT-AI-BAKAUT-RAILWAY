# Confirmed-only buyer cards: verification

## Goal and result

The buyer widget no longer displays cards marked `uncertain` as suitable goods. The earlier paving-plate conversation changed from `10 из 276` to `10 из 144` after the chat service deployed commit `b8656f2db4ed6683ff3dbca558c776297b761ccc`.

## Acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| AC1 | PASS | On `https://bakautprof.ru/`, the restored buyer conversation showed `ПОДХОДЯЩИЕ ТОВАРЫ 10 из 144`. After all cards were expanded, the uncertain group was absent. |
| AC2 | PASS | The existing list expanded by ten on each click, ending at `144 из 144` with no further button. The UI did not submit a new buyer question. The existing widget test also covers confirmed goods with prices on request. |
| AC3 | PASS (code inspection) | `AdminApp` passes `showUncertain` to `ProductCards`, while buyer calls use the default filtered view. The stored card list remains available in admin metadata. Admin login was not used in this check. |
| AC4 | PASS for this widget change | Targeted tests: 32 passed. `npm run typecheck`: passed. GitHub PR #91 checks passed. Railway chat deployment for the merge SHA reached `SUCCESS`. The prior paving-plate dialogue was reopened in the live widget on `bakautprof.ru` and its list was expanded there. |
| AC5 | PASS | This record states the observed behavior and limitation below. |

## Live widget record

The buyer's existing message was: “Подберите, пожалуйста, недорогую виброплиту для укладки тротуарной плитки.” The bot's existing answer was: “Нашёл подходящие виброплиты. Список будет отсортирован по возрастанию цены.” Before this change, the same conversation counted 276 goods, including 132 uncertain cards. After the deploy, the live widget counted 144 goods. I clicked “Показать ещё” through the whole list: 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 144. At the end, 144 product headings were present, no uncertain group was present, and the button was gone. The page itself was `https://bakautprof.ru/`; the chat ran in its embedded iframe.

This was a display check of the saved live conversation, not a fresh model classification. The change does not prove that all 144 selected plates suit paving tiles, nor that the 132 uncertain cards contain no true matches. That product-quality audit remains separate from hiding unverified cards from buyers.

The Railway connector required reauthentication, so deployment identity was checked through the Railway CLI. No manual Railway deployment was run.
