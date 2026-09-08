# Scoped administration rollout

The backend accepts independent bearer credentials, stored only in the deployment secret store:

| Variable | Permissions |
| --- | --- |
| `ADMIN_DEBUG_TOKEN` | Diagnostic, catalog and conversation reads |
| `ADMIN_CATALOG_TOKEN` | Catalog reads, imports and synchronization |
| `ADMIN_LEADS_TOKEN` | Lead and conversation reads |
| `ADMIN_DESTRUCTIVE_TOKEN` | Conversation deletion, feedback review/export, outcome annotation and paid provider probe |
| `EVAL_SERVICE_TOKEN` | Health, usage and aggregate quality diagnostics only |

Use different randomly generated values. Duplicate credentials are denied, not combined. As soon as any scoped credential is configured, legacy `ADMIN_PASSWORD` / `ADMIN_API_KEY` access is disabled. With none configured, legacy access is retained for migration compatibility; that state does **not** establish production least privilege.

Prepare the required scoped credentials together before activating them. Store them in the existing secret manager and distribute only to their intended users/services. Do not put values in Git, artifacts, screenshots or chat. Diagnostic scripts that inspect individual conversations require the debug credential, not the aggregate-only eval credential.

After the normal GitHub-triggered release, validate an allowed read and denied mutation with a read-only credential. Never use a destructive credential to test denial against real customer resources. Unit tests exercise the full authorization matrix without real mutations.

Each authorized mutation must persist intent to `admin_mutation_audit` before executing. Records contain actor role, scope, registered operation, validated UUID resource (or collection), request identifier, timestamps and final HTTP status. Request bodies, query strings and credentials are not recorded. Failure to write intent prevents execution. Failure to record completion retains the intent for reconciliation.

The administrator dashboard treats inaccessible sections as unavailable; a scoped token is not a universal administrator login. Outcome annotations explicitly record a human judgment and are never inferred from technical completion.
