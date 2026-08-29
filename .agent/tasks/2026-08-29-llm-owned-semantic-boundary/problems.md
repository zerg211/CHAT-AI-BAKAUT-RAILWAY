# Verification Problems

## AC10 Failed Production Audit

Commit `af020f228e2058612ffc02c39f6e60070cdd2dd9` deployed successfully, but the fresh widget session `78cf118b-fd3b-45bf-b654-1cd143f4e1fb` failed AC10. Turns 4-8 ended with `agent_manager_generation_failed`; no assistant message or cards were visible on those turns.

Admin traces show that the strict validator correctly rejected incoherent decisions. The bounded correction call received only issue codes, not the rejected typed decision, so it generated a new independent interpretation rather than repairing the invalid fields. Across the failed attempts this changed errors between missing catalog/web requests, missing generator-load provenance, requirement coverage mismatches, and ledger/intent mismatches.

AC10 remains blocked until the rejected decision is supplied to the LLM correction call, the minimal fix is locally verified and deployed, and a new widget dialogue plus admin audit passes with zero buyer/code issues.

The follow-up commit `71c30a070f4d3b985bd88c84d99898569fbab946` deployed, but session `359b8cf9-0a20-45ae-9ca7-4fd48bde957e` also failed: turns 2-9 had no assistant message. Supplying the rejected decision reduced some issue sets but exposed a schema mismatch (`source=null` was allowed by structured JSON while validation/execution require provenance) and insufficiently actionable validator issue codes. The next fix aligns the typed schema and supplies field-specific repair guidance without weakening validation.

## Worktree Isolation

The repository contains many unrelated modified and untracked files from parallel workstreams. The task commit must stage only reviewed LLM-boundary files and this task's artifacts; unrelated retrieval, V2, SQL, client, agent-configuration, and temporary files must remain untouched.
