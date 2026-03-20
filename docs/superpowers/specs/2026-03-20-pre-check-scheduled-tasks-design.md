# Pre-check for Scheduled Tasks

## Problem

Scheduled tasks (especially high-frequency ones like `research-qa` every 5 min) always spawn a full container + Claude API call, even when there's nothing to process. This wastes significant API tokens.

## Solution

Add an optional `pre_check` field to scheduled task definitions. Before launching the agent container, NanoClaw runs the pre-check script on the host. If the script reports `run: false`, the agent is skipped entirely — zero tokens consumed.

## Obsidian Frontmatter

New optional field `pre_check` — a path relative to the Obsidian vault root:

```yaml
---
schedule: "every 5m"
group: telegram_main
status: active
pre_check: "Scripts/pre-check-unreviewed-notes.sh"
---
```

Tasks without `pre_check` behave exactly as before.

## Pre-check Script Contract

Scripts live in `Memory_Obsidian/Scripts/` (existing convention in the vault).

**Input:** The script receives the Obsidian vault root path as `$1`.

**Output:** JSON to stdout:

```json
{"run": true, "reason": "3 unreviewed notes found"}
```

```json
{"run": false, "reason": "no changes since last check"}
```

**Failure handling:** If the script exits non-zero, times out, or produces invalid JSON, the task is **skipped** for this cycle (not permanently blocked). The error is logged and stored in `last_result`.

**Timeout:** 5 seconds (`PRE_CHECK_TIMEOUT_MS` constant in `config.ts`). Pre-checks must be fast — file checks, not heavy computation.

**Script execution:** Scripts are run via `execFile('bash', [scriptPath, vaultRoot])` rather than direct execution, since vault files may not have the execute bit set.

**Missing/invalid script:** If the resolved script path does not exist, treat it the same as a script failure — skip and log.

## Security

Pre-check scripts run **on the host**, outside the container sandbox. The Obsidian vault is mounted read-write into agent containers, meaning an agent could theoretically write a malicious pre-check script that executes on the host next scheduler tick.

**Mitigation:** Pre-check scripts are only loaded from paths explicitly declared in Obsidian task frontmatter files. The frontmatter files themselves live in `Memory/mao/scheduled-tasks/` which is synced by `obsidian-task-sync.ts` on the host. An agent would need to both create/modify a task frontmatter file AND wait for the next sync cycle. This is the same trust level as the existing task prompt mechanism (agents can already modify their own prompts via the vault).

For future hardening: consider restricting pre-check scripts to a read-only-mounted subdirectory or maintaining a hash allowlist.

## Changes

### 1. DB Schema — `scheduled_tasks` table

Add column:

```sql
ALTER TABLE scheduled_tasks ADD COLUMN pre_check TEXT;
```

### 2. `types.ts` — `ScheduledTask` interface

Add optional field:

```ts
pre_check?: string;
```

### 3. `config.ts`

Add constant:

```ts
export const PRE_CHECK_TIMEOUT_MS = 5000;
```

### 4. `db.ts`

- Migration: `ALTER TABLE scheduled_tasks ADD COLUMN pre_check TEXT` (same pattern as existing migrations in `createSchema()`).
- `createTask()`: Add `pre_check` to the SQL INSERT column list and `.run()` arguments. The function parameter type `Omit<ScheduledTask, 'last_run' | 'last_result'>` will automatically include the new field from the updated interface.
- `updateTask()`: Add `'pre_check'` to the `Pick<>` union in the type signature. Add a corresponding `if (updates.pre_check !== undefined)` block that pushes to `fields` and `values`, following the existing pattern.

### 5. `obsidian-task-sync.ts`

- Add `pre_check?: string` to the `ObsidianTask` interface.
- Parse `pre_check` from frontmatter via existing `getValue()` helper.
- Pass it through to `createTask()` / `updateTask()` alongside other fields.
- Detect changes to `pre_check` in the sync diff logic and update DB accordingly.
- Extract `findObsidianVaultRoot()` from existing `findObsidianTasksDir()` — the vault root lookup is reusable and needed by the scheduler for script path resolution.

### 6. `task-scheduler.ts` — `runTask()`

Before `runContainerAgent`, insert pre-check logic:

1. If `task.pre_check` is set:
   a. Resolve the script path: use the extracted `findObsidianVaultRoot()` helper from `obsidian-task-sync.ts` to get the vault root, then join with `task.pre_check`.
   b. Verify the script file exists. If not — log error, update `last_result`, compute `next_run`, return early.
   c. Run script via `execFile('bash', [scriptPath, vaultRoot], {timeout: PRE_CHECK_TIMEOUT_MS})`.
   d. Parse stdout as JSON.
   e. If `run: false` or parse/execution error:
      - Call `logTaskRun()` with status `'skipped'` (for pre-check skip) or `'error'` (for script failure).
      - Update `last_result` with the reason/error.
      - Compute and set `next_run`.
      - Return early (do not launch agent).
   f. If `run: true` — continue to `runContainerAgent` as normal.

### 7. `task_run_logs` — new status value

Add `'skipped'` as a valid status alongside `'success'` and `'error'`. This enables querying how often tasks are actually running vs. being pre-check skipped — the core metric for this feature.

Update `TaskRunLog.status` type in `types.ts`:

```ts
status: 'success' | 'error' | 'skipped';
```

## Data Flow

```
Scheduler tick
  → getDueTasks()
  → for each task:
      → has pre_check?
        → YES: bash <script> <vaultRoot> (timeout: 5s)
          → parse JSON stdout
          → run: false? → logTaskRun(skipped), update last_result, compute next_run, skip
          → run: true?  → continue below
          → error?      → logTaskRun(error), update last_result, compute next_run, skip
        → NO: continue below
      → runContainerAgent(...)  // full agent launch
```

## Example Pre-check Script

`Memory_Obsidian/Scripts/pre-check-unreviewed-notes.sh`:

```bash
#!/bin/bash
VAULT="$1"
NOTES_DIR="$VAULT/Memory/notes"

count=$(grep -rl 'ai_task_reviewed: false' "$NOTES_DIR" 2>/dev/null | wc -l)
no_field=$(grep -rL 'ai_task_reviewed' "$NOTES_DIR" 2>/dev/null | wc -l)
total=$((count + no_field))

if [ "$total" -gt 0 ]; then
  echo "{\"run\": true, \"reason\": \"$total unreviewed notes\"}"
else
  echo "{\"run\": false, \"reason\": \"all notes reviewed\"}"
fi
```

## What This Does NOT Change

- Existing tasks without `pre_check` are unaffected.
- Task scheduling, queue management, and container runtime are unchanged.
- The IPC task sync JSON format gets `pre_check` added but it's optional.
