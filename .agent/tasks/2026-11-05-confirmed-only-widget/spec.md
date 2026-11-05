# Buyer widget shows confirmed goods only

## Goal
A buyer asking for suitable products must not receive unverified catalog cards as if they were matches. Keep unresolved cards available to the admin and internal selection audit.

## Baseline
The paving-plate result has 144 confirmed, 132 uncertain, 8 rejected. The buyer widget currently displays a shared `10 из 276` counter and eventually reveals uncertain cards with the same Show more button.

## Acceptance criteria
- AC1: In the buyer widget, product cards and the total count include only cards without `matchStatus=uncertain`; unverified cards never appear under Show more.
- AC2: Every confirmed card remains preloaded and can be revealed by ten without another catalog request. Confirmed on-request goods remain visible with their price status.
- AC3: The admin transcript continues to show uncertain cards for audit.
- AC4: Existing UI behavior checks and a live check on bakautprof.ru pass after GitHub deployment.
- AC5: Record the live result and limitations in evidence.md/evidence.json; do not claim that all true matches have been found merely because uncertain cards are hidden.
