# Pre-check for Scheduled Tasks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Skip expensive agent container launches when a lightweight pre-check script determines there's no work to do.

**Architecture:** Add optional `pre_check` field to scheduled tasks. Before launching the container agent, run a bash script on the host that outputs JSON `{run, reason}`. If `run: false`, skip the agent and log the result.

**Tech Stack:** Node.js, child_process.execFile, better-sqlite3, vitest

**Spec:** `docs/superpowers/specs/2026-03-20-pre-check-scheduled-tasks-design.md`

---

### Task 1: Add `pre_check` to types and DB schema

**Files:**
- Modify: `src/types.ts:56-70` (ScheduledTask interface)
- Modify: `src/types.ts:72-79` (TaskRunLog interface)
- Modify: `src/db.ts:86-101` (createSchema migrations)
- Modify: `src/db.ts:373-394` (createTask)
- Modify: `src/db.ts:416-464` (updateTask)

- [ ] **Step 1: Add `pre_check` to `ScheduledTask` interface**

In `src/types.ts`, add after `model?: string;`:

```ts
pre_check?: string;
```

- [ ] **Step 2: Add `'skipped'` to `TaskRunLog.status`**

In `src/types.ts`, change:

```ts
status: 'success' | 'error';
```

to:

```ts
status: 'success' | 'error' | 'skipped';
```

- [ ] **Step 3: Add DB migration for `pre_check` column**

In `src/db.ts` `createSchema()`, after the `model` migration block (~line 101), add:

```ts
// Add pre_check column to scheduled_tasks if it doesn't exist
try {
  database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN pre_check TEXT`);
} catch {
  /* column already exists */
}
```

- [ ] **Step 4: Update `createTask()` to include `pre_check`**

In `src/db.ts` `createTask()`, update the SQL INSERT to add `pre_check` column and `.run()` argument:

```ts
export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at, model, pre_check)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
    task.model || null,
    task.pre_check || null,
  );
}
```

- [ ] **Step 5: Update `updateTask()` to support `pre_check`**

In `src/db.ts` `updateTask()`, add `'pre_check'` to the Pick union and add the handler block:

```ts
export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
      | 'model'
      | 'pre_check'
    >
  >,
): void {
```

After the `model` block, add:

```ts
if (updates.pre_check !== undefined) {
  fields.push('pre_check = ?');
  values.push(updates.pre_check);
}
```

- [ ] **Step 6: Run existing tests to verify no regression**

Run: `npx vitest run src/db.test.ts src/task-scheduler.test.ts`
Expected: All existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/db.ts
git commit -m "feat: add pre_check field to scheduled tasks schema"
```

---

### Task 2: Add `PRE_CHECK_TIMEOUT_MS` to config

**Files:**
- Modify: `src/config.ts:17` (after SCHEDULER_POLL_INTERVAL)

- [ ] **Step 1: Add constant**

In `src/config.ts`, after `export const SCHEDULER_POLL_INTERVAL = 60000;`, add:

```ts
export const PRE_CHECK_TIMEOUT_MS = 5000;
```

- [ ] **Step 2: Commit**

```bash
git add src/config.ts
git commit -m "feat: add PRE_CHECK_TIMEOUT_MS config constant"
```

---

### Task 3: Extract `findObsidianVaultRoot()` from obsidian-task-sync

**Files:**
- Modify: `src/obsidian-task-sync.ts:188-210` (extract helper, refactor existing function)

- [ ] **Step 1: Extract `findObsidianVaultRoot()` and refactor `findObsidianTasksDir()`**

In `src/obsidian-task-sync.ts`, replace the `findObsidianTasksDir` function with two functions:

```ts
/**
 * Find the Obsidian vault root (hostPath) from registered group mounts.
 */
export function findObsidianVaultRoot(
  groups: Record<string, RegisteredGroup>,
): string | null {
  for (const group of Object.values(groups)) {
    const mounts = group.containerConfig?.additionalMounts;
    if (!mounts) continue;
    for (const mount of mounts) {
      if (mount.hostPath.includes('Memory_Obsidian')) {
        return mount.hostPath;
      }
    }
  }
  return null;
}

/**
 * Find the Obsidian tasks directory on the host filesystem.
 */
function findObsidianTasksDir(
  groups: Record<string, RegisteredGroup>,
): string | null {
  const vaultRoot = findObsidianVaultRoot(groups);
  if (!vaultRoot) return null;

  const tasksDir = path.join(vaultRoot, OBSIDIAN_TASKS_SUBPATH);
  if (fs.existsSync(tasksDir)) {
    return tasksDir;
  }
  const parentDir = path.join(vaultRoot, 'Memory/mao');
  if (fs.existsSync(parentDir)) {
    fs.mkdirSync(tasksDir, { recursive: true });
    return tasksDir;
  }
  return null;
}
```

- [ ] **Step 2: Run tests to verify no regression**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/obsidian-task-sync.ts
git commit -m "refactor: extract findObsidianVaultRoot from obsidian-task-sync"
```

---

### Task 4: Sync `pre_check` from Obsidian frontmatter

**Files:**
- Modify: `src/obsidian-task-sync.ts:33-40` (ObsidianTask interface)
- Modify: `src/obsidian-task-sync.ts:120-174` (parseMarkdownTask)
- Modify: `src/obsidian-task-sync.ts:259-329` (sync logic)

- [ ] **Step 1: Add `pre_check` to `ObsidianTask` interface**

In `src/obsidian-task-sync.ts`, add to the `ObsidianTask` interface:

```ts
pre_check?: string;
```

- [ ] **Step 2: Parse `pre_check` in `parseMarkdownTask()`**

After `const model = getValue('model');` (~line 145), add:

```ts
const pre_check = getValue('pre_check');
```

And include it in the return object:

```ts
return {
  id,
  schedule,
  group,
  status: status || 'active',
  prompt: body,
  model,
  pre_check,
};
```

- [ ] **Step 3: Pass `pre_check` through in sync create path**

In the `createTask` call (~line 279), add `pre_check`:

```ts
createTask({
  id,
  group_folder: obsTask.group,
  chat_jid: chatJid,
  prompt: obsTask.prompt,
  schedule_type: parsed.type,
  schedule_value: parsed.value,
  context_mode: 'group',
  next_run: nextRun,
  status: obsTask.status,
  created_at: new Date().toISOString(),
  model: obsTask.model,
  pre_check: obsTask.pre_check,
});
```

- [ ] **Step 4: Detect `pre_check` changes in sync update path**

In the change detection block (~line 299-319), after the `model` check, add:

```ts
if ((existingTask.pre_check || null) !== (obsTask.pre_check || null)) {
  changes.pre_check = obsTask.pre_check || null;
}
```

- [ ] **Step 5: Commit**

```bash
git add src/obsidian-task-sync.ts
git commit -m "feat: sync pre_check field from Obsidian task frontmatter"
```

---

### Task 5: Implement pre-check execution in task-scheduler

**Files:**
- Modify: `src/task-scheduler.ts:1-22` (imports)
- Modify: `src/task-scheduler.ts:78-243` (runTask function)
- Test: `src/task-scheduler.test.ts`

- [ ] **Step 1: Write failing test — pre-check skips task when run is false**

In `src/task-scheduler.test.ts`, add:

```ts
import { execFile } from 'child_process';

describe('pre-check', () => {
  it('skips agent launch when pre-check returns run: false', async () => {
    // Create a temp script that outputs run: false
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'precheck-'));
    const scriptPath = path.join(tmpDir, 'check.sh');
    fs.writeFileSync(scriptPath, '#!/bin/bash\necho \'{"run": false, "reason": "nothing to do"}\'\n');

    _initTestDatabase();
    createTask({
      id: 'precheck-test',
      group_folder: 'test',
      chat_jid: 'tg:123',
      prompt: 'do stuff',
      schedule_type: 'cron',
      schedule_value: '*/5 * * * *',
      context_mode: 'group',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
      pre_check: scriptPath,
    });

    const runContainerAgent = vi.fn();

    const { runPreCheck } = await import('./task-scheduler.js');
    const result = await runPreCheck(scriptPath, tmpDir);

    expect(result.run).toBe(false);
    expect(result.reason).toBe('nothing to do');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns run: true when pre-check approves', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'precheck-'));
    const scriptPath = path.join(tmpDir, 'check.sh');
    fs.writeFileSync(scriptPath, '#!/bin/bash\necho \'{"run": true, "reason": "3 files found"}\'\n');

    const { runPreCheck } = await import('./task-scheduler.js');
    const result = await runPreCheck(scriptPath, tmpDir);

    expect(result.run).toBe(true);
    expect(result.reason).toBe('3 files found');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns run: false with error when script fails', async () => {
    const { runPreCheck } = await import('./task-scheduler.js');
    const result = await runPreCheck('/nonexistent/script.sh', '/tmp');

    expect(result.run).toBe(false);
    expect(result.reason).toMatch(/not found|no such file|error/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/task-scheduler.test.ts`
Expected: FAIL — `runPreCheck` is not exported.

- [ ] **Step 3: Implement `runPreCheck()` and integrate into `runTask()`**

In `src/task-scheduler.ts`, add import at top:

```ts
import { execFile } from 'child_process';
import { PRE_CHECK_TIMEOUT_MS } from './config.js';
import { findObsidianVaultRoot } from './obsidian-task-sync.js';
```

Add the `runPreCheck` function before `runTask`:

```ts
export interface PreCheckResult {
  run: boolean;
  reason: string;
}

export async function runPreCheck(
  scriptPath: string,
  vaultRoot: string,
): Promise<PreCheckResult> {
  return new Promise((resolve) => {
    if (!fs.existsSync(scriptPath)) {
      resolve({ run: false, reason: `Pre-check script not found: ${scriptPath}` });
      return;
    }

    execFile(
      'bash',
      [scriptPath, vaultRoot],
      { timeout: PRE_CHECK_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            run: false,
            reason: `Pre-check error: ${error.message}`,
          });
          return;
        }

        try {
          const result = JSON.parse(stdout.trim());
          resolve({
            run: Boolean(result.run),
            reason: result.reason || (result.run ? 'approved' : 'skipped'),
          });
        } catch {
          resolve({
            run: false,
            reason: `Pre-check invalid JSON: ${stdout.trim().slice(0, 200)}`,
          });
        }
      },
    );
  });
}
```

In `runTask()`, after the group lookup and `writeTasksSnapshot` call (~line 147), before the `let result` line, insert:

```ts
// Pre-check: run lightweight script before launching agent
if (task.pre_check) {
  const vaultRoot = findObsidianVaultRoot(deps.registeredGroups());
  if (!vaultRoot) {
    logger.warn(
      { taskId: task.id },
      'Pre-check configured but Obsidian vault not found',
    );
  } else {
    const scriptPath = path.resolve(vaultRoot, task.pre_check);
    const preCheckResult = await runPreCheck(scriptPath, vaultRoot);

    if (!preCheckResult.run) {
      logger.info(
        { taskId: task.id, reason: preCheckResult.reason },
        'Task skipped by pre-check',
      );

      logTaskRun({
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        status: 'skipped',
        result: preCheckResult.reason,
        error: null,
      });

      const nextRun = computeNextRun(task);
      updateTaskAfterRun(task.id, nextRun, `Skipped: ${preCheckResult.reason}`);
      return;
    }

    logger.info(
      { taskId: task.id, reason: preCheckResult.reason },
      'Pre-check passed, launching agent',
    );
  }
}
```

Add `path` import at top if not already present:

```ts
import path from 'path';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/task-scheduler.test.ts`
Expected: All tests pass including new pre-check tests.

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/task-scheduler.ts src/task-scheduler.test.ts
git commit -m "feat: implement pre-check execution for scheduled tasks"
```

---

### Task 6: Build and verify

**Files:** None (verification only)

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: No TypeScript errors.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 3: Final commit if any fixes needed**
