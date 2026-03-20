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

**Timeout:** 5 seconds. Pre-checks must be fast — file checks, not heavy computation.

## Changes

### 1. DB Schema — `scheduled_tasks` table

Add column:

```sql
ALTER TABLE scheduled_tasks ADD COLUMN pre_check TEXT;
```

### 2. `obsidian-task-sync.ts`

- Parse `pre_check` from frontmatter via existing `getValue()` helper.
- Pass it through to `createTask()` / `updateTask()` alongside other fields.

### 3. `types.ts` — `ScheduledTask` interface

Add optional field:

```ts
pre_check?: string;
```

### 4. `db.ts`

- Migration: `ALTER TABLE scheduled_tasks ADD COLUMN pre_check TEXT`
- Update `createTask()` to accept and store `pre_check`.
- Update `updateTask()` to support updating `pre_check`.

### 5. `task-scheduler.ts` — `runTask()`

Before `runContainerAgent`, insert pre-check logic:

1. If `task.pre_check` is set:
   a. Resolve the script path: find the Obsidian vault `hostPath` from the group's `containerConfig.additionalMounts`, append `pre_check` value.
   b. Run script via `child_process.execFile` with 5s timeout, passing vault root as `$1`.
   c. Parse stdout as JSON.
   d. If `run: false` or parse/execution error:
      - Log reason.
      - Update `last_result` with the reason/error.
      - Compute and set `next_run`.
      - Return early (do not launch agent).
   e. If `run: true` — continue to `runContainerAgent` as normal.

### 6. `obsidian-task-sync.ts` — `ObsidianTask` interface

Add optional field:

```ts
pre_check?: string;
```

Sync logic: detect changes to `pre_check` and update DB accordingly.

## Data Flow

```
Scheduler tick
  → getDueTasks()
  → for each task:
      → has pre_check?
        → YES: execFile(script, [vaultPath], {timeout: 5000})
          → parse JSON stdout
          → run: false? → log, update last_result, compute next_run, skip
          → run: true?  → continue below
          → error?      → log, update last_result, compute next_run, skip
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
