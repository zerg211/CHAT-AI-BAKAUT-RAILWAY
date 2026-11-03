# Connect the saved OpenAI Platform agent to the BAKAUT site widget

## Goal

Make the existing buyer chat on `bakautprof.ru` use the saved OpenAI Platform agent and its indexed 4,324-card catalog. Keep the existing Railway chat domain and website DNS unchanged.

## Current verified configuration

- Saved agent ID: `agent_c1cd3f2b906548f4b020b5486fccb7373c2f717e1d7b482291`.
- Agent model/reasoning: `gpt-6-luna`, `max`.
- Agent tools: `web_search` and the `bakaut_catalog` MCP connection (`search_products`, `get_product`).
- Catalog search returns ten cards and a continuation cursor; the knowledge-index Railway service is live.
- Railway production chat domain is already bound to `chat-ai`; the `chat-ai` and Postgres services are currently offline.

## Acceptance criteria

AC1. The chat backend creates an OpenAI Agents API session for a new site conversation and reuses that session for later messages in the same conversation. The API key remains server-side.

AC2. The backend extracts only the completed assistant answer and catalog tool result from the current Agent turn, maps the first ten matching catalog records into the existing product-card format, and preserves the total count and `has_more` state.

AC3. The live widget displays a `Показать ещё 10` action when the catalog reports another page. Clicking it continues the same Agent session and displays the next ten models. The action repeats while more pages remain and does not repeat product IDs.

AC4. Product links and numeric values come from the indexed catalog tool result. The browser never calls OpenAI directly and never receives an API key.

AC5. Existing chat-session authorization, turn idempotency, error handling, and chat history remain compatible with the current widget API.

AC6. Focused tests cover Agent API session creation/continuation, MCP result extraction, product-card mapping, and the widget pagination action. A fresh verification pass records the exact commands and results.

AC7. No DNS or `bakautprof.ru` embed change is made. Production is considered complete only after a successful Railway deployment and verification through the existing site widget.

## Implementation boundary

Implement in the repository currently configured as Railway `chat-ai` source (`zerg211/CHAT-AI-BAKAUT-RAILWAY`). Preserve unrelated local changes. Do not apply the unrelated staged Railway Postgres auto-update patch.
