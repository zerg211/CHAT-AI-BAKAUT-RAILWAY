# Accurate catalog cards in the site widget

AC1. Each search page is classified by the agent using an explicit structured result: selected, rejected or uncertain product IDs. The backend validates each ID against the exact catalog page and does not infer suitability from free text.
AC2. A selected card uses the canonical catalog URL, price and details regardless of the link spelled in agent prose. Rejected and uncertain products are not shown as suitable cards. All returned page IDs must be accounted for; malformed decisions fail closed without advancing the cursor.
AC3. Existing conversations use the same output contract; unrelated agent settings and user content remain intact. No duplicate IDs are shown across pages.
AC4. Unit tests cover selection, rejected mention, malformed links and invalid or incomplete classifications; typecheck and release checks pass.
AC5. After GitHub-based deployment, verify SHA and conduct a live dialogue through the widget on bakautprof.ru, test all pages of a suitable generator query against the catalog results, and test the remote-controlled plate exclusion. Record actual results and any limits.
