# Live pagination issue

The first four pages showed 40 unique cards on the site. Page five contained ten products in the Agent answer but only nine cards: the model inserted a space into the A-iPower A5500 URL. The original catalog result contains the correct URL and article 20105. The card filter required a literal URL match and therefore omitted that card.

Fix: accept a unique exact article together with an exact model token on the same answer line, and replace a malformed site catalog link on that line with the original URL from the same catalog result. Do not match by article alone.

Live verification of the fix, all pages, and site acceptance remain pending.
2026-11-03 live preload test through bakautprof.ru: the agent completed seven MCP calls in 1m58s (80,835 tokens), but the widget showed an error. Railway log reported Catalog pages are incomplete. Agent trace shows calls executed in parallel and the model generated equivalent cursor encodings, so matching opaque cursor strings in execution order was incorrect. Updated collection to validate semantic snapshot/revision/offset and reconstruct page order. Live retest pending.
