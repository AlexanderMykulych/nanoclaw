# MastraClaw Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal Telegram assistant on Mastra framework with per-thread memory, scheduled tasks, and Obsidian sync.

**Architecture:** Single Node.js process. grammy for Telegram polling, Mastra Agent with LibSQL-backed memory (per-thread isolation via threadId + resourceId), scheduled tasks via setInterval + SQLite, Obsidian markdown sync.

**Tech Stack:** Mastra (`@mastra/core`, `@mastra/memory`, `@mastra/libsql`), grammy, better-sqlite3, cron-parser, pino, zod, TypeScript (ES2022 modules)

**Spec:** `docs/superpowers/specs/2026-03-19-mastraclaw-design.md`

---

## File Map

| File | Responsibility |
|------|---------------|
| `src/config.ts` | Env vars, defaults, paths |
| `src/db/storage.ts` | better-sqlite3 connection, migrations |
| `src/db/tables.ts` | CRUD for scheduled_tasks, chat_config, task_run_logs |
| `src/telegram/thread-resolver.ts` | threadId from grammy context + threadId→dir mapping |
| `src/telegram/trigger.ts` | Trigger pattern matching (private=always, groups=@Bot) |
| `src/telegram/bot.ts` | grammy bot setup, message handler |
| `src/telegram/streaming.ts` | Edit-message streaming with debounce |
| `src/telegram/media.ts` | Photo/doc download, voice transcription (ElevenLabs) |
| `src/tools/filesystem.ts` | readFile, writeFile, listFiles (sandboxed) |
| `src/tools/send-message.ts` | Mastra tool: send Telegram message |
| `src/tools/schedule-task.ts` | Mastra tools: scheduleTask, listTasks, pauseTask, resumeTask, cancelTask |
| `src/agent.ts` | Mastra Agent + Memory config |
| `src/mastra/index.ts` | Mastra instance (entry point for Studio) |
| `src/scheduler/schedule-parser.ts` | Human-readable schedule → cron, computeNextRun |
| `src/scheduler/scheduler.ts` | setInterval loop, due task execution |
| `src/scheduler/obsidian-sync.ts` | Parse Obsidian markdown → DB tasks |
| `src/index.ts` | Entry point: bot + scheduler + obsidian sync + shutdown |
| `mastra.config.ts` | Mastra Studio entry point (re-exports Mastra instance) |
| `vitest.config.ts` | Vitest test config |

---

### Task 1: Project Scaffolding

**Files:**
- Create: `~/repo/mastraclaw/package.json`
- Create: `~/repo/mastraclaw/tsconfig.json`
- Create: `~/repo/mastraclaw/.env`
- Create: `~/repo/mastraclaw/.gitignore`

- [ ] **Step 1: Init project and install deps**

```bash
mkdir -p ~/repo/mastraclaw && cd ~/repo/mastraclaw
git init
npm init -y
```

- [ ] **Step 2: Install dependencies**

```bash
npm install @mastra/core@latest @mastra/memory@latest @mastra/libsql@latest grammy better-sqlite3 cron-parser pino zod dotenv
npm install -D typescript @types/node @types/better-sqlite3 mastra@latest tsx vitest
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: Create package.json scripts**

Add to `package.json`:
```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "dev:studio": "mastra dev",
    "build": "tsc",
    "check": "tsc --noEmit",
    "start": "node dist/index.js",
    "test": "vitest"
  }
}
```

- [ ] **Step 5: Create .env**

```env
TELEGRAM_BOT_TOKEN=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
ELEVENLABS_API_KEY=
ASSISTANT_NAME=Andy
TZ=Europe/Kyiv
OBSIDIAN_TASKS_DIR=
```

- [ ] **Step 6: Create .gitignore**

```
node_modules/
dist/
data/
.env
*.db
```

- [ ] **Step 7: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
  },
});
```

- [ ] **Step 8: Create mastra.config.ts**

This file is needed for `npx mastra dev` (Mastra Studio). It re-exports the Mastra instance:

```typescript
// This file is loaded by Mastra Studio CLI.
// The actual Mastra instance is initialized at runtime in src/mastra/index.ts.
// For Studio, we re-export it.
export { mastra } from './src/mastra/index.js';
```

- [ ] **Step 9: Create directory structure**

```bash
mkdir -p src/{telegram,scheduler,tools,db,mastra}
mkdir -p data/threads
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold MastraClaw project"
```

---

### Task 2: Config

**Files:**
- Create: `src/config.ts`

- [ ] **Step 1: Write test**

Create `src/config.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';

describe('config', () => {
  it('exports required config values with defaults', async () => {
    const config = await import('./config.js');
    expect(config.ASSISTANT_NAME).toBeDefined();
    expect(config.POLL_INTERVAL).toBeGreaterThan(0);
    expect(config.SCHEDULER_POLL_INTERVAL).toBeGreaterThan(0);
    expect(config.DATA_DIR).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run src/config.test.ts
```

- [ ] **Step 3: Implement config.ts**

```typescript
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
export const TIMEZONE = process.env.TZ || 'Europe/Kyiv';

export const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '2000', 10);
export const SCHEDULER_POLL_INTERVAL = parseInt(process.env.SCHEDULER_POLL_INTERVAL || '60000', 10);
export const OBSIDIAN_SYNC_INTERVAL = parseInt(process.env.OBSIDIAN_SYNC_INTERVAL || '300000', 10);

export const DATA_DIR = path.join(ROOT, 'data');
export const DB_PATH = path.join(DATA_DIR, 'mastraclaw.db');
export const THREADS_DIR = path.join(DATA_DIR, 'threads');

export const OBSIDIAN_TASKS_DIR = process.env.OBSIDIAN_TASKS_DIR || '';

export const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'anthropic/claude-sonnet-4-6';
```

- [ ] **Step 4: Run test, verify it passes**

```bash
npx vitest run src/config.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: add config module"
```

---

### Task 3: Database — Storage & Tables

**Files:**
- Create: `src/db/storage.ts`
- Create: `src/db/tables.ts`

- [ ] **Step 1: Write storage test**

Create `src/db/storage.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, closeDb } from './storage.js';
import Database from 'better-sqlite3';

describe('storage', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  afterEach(() => {
    closeDb(db);
  });

  it('creates all tables', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain('scheduled_tasks');
    expect(names).toContain('chat_config');
    expect(names).toContain('task_run_logs');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run src/db/storage.test.ts
```

- [ ] **Step 3: Implement storage.ts**

```typescript
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('cron', 'interval', 'once')),
  schedule_value TEXT NOT NULL,
  context_mode TEXT NOT NULL DEFAULT 'isolated' CHECK (context_mode IN ('thread', 'isolated')),
  model TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed')),
  next_run TEXT,
  last_run TEXT,
  last_result TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON scheduled_tasks(next_run);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON scheduled_tasks(status);

CREATE TABLE IF NOT EXISTS chat_config (
  thread_id TEXT PRIMARY KEY,
  trigger_pattern TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES scheduled_tasks(id),
  run_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'error')),
  result TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_logs ON task_run_logs(task_id, run_at);
`;

export function createDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

export function closeDb(db: Database.Database): void {
  db.close();
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
npx vitest run src/db/storage.test.ts
```

- [ ] **Step 5: Write tables CRUD test**

Create `src/db/tables.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createDb, closeDb } from './storage.js';
import { createTables } from './tables.js';

describe('tables CRUD', () => {
  let db: Database.Database;
  let tables: ReturnType<typeof createTables>;

  beforeEach(() => {
    db = createDb(':memory:');
    tables = createTables(db);
  });

  afterEach(() => {
    closeDb(db);
  });

  it('creates and retrieves a scheduled task', () => {
    tables.createTask({
      id: 'test-1',
      thread_id: 'tg:123',
      prompt: 'hello',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      next_run: '2026-03-20T09:00:00Z',
    });
    const task = tables.getTaskById('test-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('hello');
  });

  it('getDueTasks returns only active tasks with next_run <= now', () => {
    tables.createTask({
      id: 'due',
      thread_id: 'tg:123',
      prompt: 'due task',
      schedule_type: 'once',
      schedule_value: '2026-03-19T00:00:00Z',
      next_run: '2020-01-01T00:00:00Z', // in the past
    });
    tables.createTask({
      id: 'future',
      thread_id: 'tg:123',
      prompt: 'future task',
      schedule_type: 'once',
      schedule_value: '2099-01-01T00:00:00Z',
      next_run: '2099-01-01T00:00:00Z',
    });
    const due = tables.getDueTasks();
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe('due');
  });

  it('logs a task run', () => {
    tables.createTask({
      id: 'log-test',
      thread_id: 'tg:123',
      prompt: 'p',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      next_run: null,
    });
    tables.logTaskRun('log-test', {
      durationMs: 1500,
      status: 'success',
      result: 'done',
    });
    const logs = tables.getTaskRunLogs('log-test');
    expect(logs).toHaveLength(1);
    expect(logs[0].duration_ms).toBe(1500);
  });
});
```

- [ ] **Step 6: Implement tables.ts**

```typescript
import Database from 'better-sqlite3';

export interface TaskInput {
  id: string;
  thread_id: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode?: 'thread' | 'isolated';
  model?: string | null;
  status?: 'active' | 'paused';
  next_run: string | null;
}

export interface ScheduledTask {
  id: string;
  thread_id: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'thread' | 'isolated';
  model: string | null;
  status: 'active' | 'paused' | 'completed';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  last_error: string | null;
  created_at: string;
}

export interface TaskRunLog {
  id: number;
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

export function createTables(db: Database.Database) {
  const stmts = {
    createTask: db.prepare(`
      INSERT INTO scheduled_tasks (id, thread_id, prompt, schedule_type, schedule_value, context_mode, model, status, next_run)
      VALUES (@id, @thread_id, @prompt, @schedule_type, @schedule_value, @context_mode, @model, @status, @next_run)
    `),
    getTaskById: db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?'),
    getDueTasks: db.prepare(
      "SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= datetime('now')"
    ),
    getAllTasks: db.prepare('SELECT * FROM scheduled_tasks'),
    getTasksByThread: db.prepare('SELECT * FROM scheduled_tasks WHERE thread_id = ?'),
    updateTask: (id: string, fields: Partial<ScheduledTask>) => {
      const sets = Object.keys(fields).map(k => `${k} = @${k}`).join(', ');
      return db.prepare(`UPDATE scheduled_tasks SET ${sets} WHERE id = @id`).run({ ...fields, id });
    },
    deleteTask: db.prepare('DELETE FROM scheduled_tasks WHERE id = ?'),
    logTaskRun: db.prepare(`
      INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
      VALUES (@task_id, datetime('now'), @duration_ms, @status, @result, @error)
    `),
    getTaskRunLogs: db.prepare('SELECT * FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC'),
    getChatConfig: db.prepare('SELECT * FROM chat_config WHERE thread_id = ?'),
    setChatConfig: db.prepare(`
      INSERT OR REPLACE INTO chat_config (thread_id, trigger_pattern)
      VALUES (@thread_id, @trigger_pattern)
    `),
  };

  return {
    createTask(input: TaskInput) {
      stmts.createTask.run({
        ...input,
        context_mode: input.context_mode || 'isolated',
        model: input.model || null,
        status: input.status || 'active',
      });
    },
    getTaskById(id: string): ScheduledTask | undefined {
      return stmts.getTaskById.get(id) as ScheduledTask | undefined;
    },
    getDueTasks(): ScheduledTask[] {
      return stmts.getDueTasks.all() as ScheduledTask[];
    },
    getAllTasks(): ScheduledTask[] {
      return stmts.getAllTasks.all() as ScheduledTask[];
    },
    getTasksByThread(threadId: string): ScheduledTask[] {
      return stmts.getTasksByThread.all(threadId) as ScheduledTask[];
    },
    updateTask(id: string, fields: Partial<ScheduledTask>) {
      stmts.updateTask(id, fields);
    },
    deleteTask(id: string) {
      stmts.deleteTask.run(id);
    },
    logTaskRun(taskId: string, log: { durationMs: number; status: 'success' | 'error'; result?: string; error?: string }) {
      stmts.logTaskRun.run({
        task_id: taskId,
        duration_ms: log.durationMs,
        status: log.status,
        result: log.result || null,
        error: log.error || null,
      });
    },
    getTaskRunLogs(taskId: string): TaskRunLog[] {
      return stmts.getTaskRunLogs.all(taskId) as TaskRunLog[];
    },
    getChatConfig(threadId: string) {
      return stmts.getChatConfig.get(threadId) as { thread_id: string; trigger_pattern: string | null } | undefined;
    },
    setChatConfig(threadId: string, triggerPattern: string | null) {
      stmts.setChatConfig.run({ thread_id: threadId, trigger_pattern: triggerPattern });
    },
  };
}
```

- [ ] **Step 7: Run tests, verify they pass**

```bash
npx vitest run src/db/
```

- [ ] **Step 8: Commit**

```bash
git add src/db/
git commit -m "feat: add database storage and CRUD tables"
```

---

### Task 4: Thread Resolver & Trigger

**Files:**
- Create: `src/telegram/thread-resolver.ts`
- Create: `src/telegram/trigger.ts`

- [ ] **Step 1: Write thread-resolver test**

Create `src/telegram/thread-resolver.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { resolveThreadId, threadDir } from './thread-resolver.js';

describe('resolveThreadId', () => {
  it('returns tg:chatId for regular chat', () => {
    expect(resolveThreadId(123456, undefined)).toBe('tg:123456');
  });

  it('returns tg:chatId:threadId for forum topic', () => {
    expect(resolveThreadId(123456, 789)).toBe('tg:123456:789');
  });
});

describe('threadDir', () => {
  it('converts colons to dashes', () => {
    expect(threadDir('tg:123:789')).toMatch(/data\/threads\/tg-123-789$/);
  });

  it('handles simple thread id', () => {
    expect(threadDir('tg:123')).toMatch(/data\/threads\/tg-123$/);
  });
});
```

- [ ] **Step 2: Write trigger test**

Create `src/telegram/trigger.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { shouldRespond } from './trigger.js';

describe('shouldRespond', () => {
  it('always responds in private chat', () => {
    expect(shouldRespond('private', 'hello', null, 'Andy')).toBe(true);
  });

  it('responds in group when trigger matches', () => {
    expect(shouldRespond('group', '@Andy do something', null, 'Andy')).toBe(true);
  });

  it('does not respond in group without trigger', () => {
    expect(shouldRespond('group', 'hello', null, 'Andy')).toBe(false);
  });

  it('uses custom trigger pattern', () => {
    expect(shouldRespond('group', 'hey bot', '@bot', 'Andy')).toBe(true);
  });

  it('trigger match is case-insensitive', () => {
    expect(shouldRespond('group', '@andy help', null, 'Andy')).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests, verify they fail**

```bash
npx vitest run src/telegram/
```

- [ ] **Step 4: Implement thread-resolver.ts**

```typescript
import path from 'path';
import { THREADS_DIR } from '../config.js';

export function resolveThreadId(chatId: number, messageThreadId: number | undefined): string {
  return messageThreadId
    ? `tg:${chatId}:${messageThreadId}`
    : `tg:${chatId}`;
}

export function threadDir(threadId: string): string {
  return path.join(THREADS_DIR, threadId.replaceAll(':', '-'));
}

/** Parse chat ID and optional Telegram thread ID from a threadId string */
export function parseThreadId(threadId: string): { chatId: number; messageThreadId?: number } {
  const parts = threadId.replace('tg:', '').split(':');
  return {
    chatId: parseInt(parts[0], 10),
    messageThreadId: parts[1] ? parseInt(parts[1], 10) : undefined,
  };
}
```

- [ ] **Step 5: Implement trigger.ts**

```typescript
export function shouldRespond(
  chatType: string,
  text: string,
  customTrigger: string | null,
  assistantName: string,
): boolean {
  if (chatType === 'private') return true;

  const pattern = customTrigger || `@${assistantName}`;
  return new RegExp(pattern, 'i').test(text);
}
```

- [ ] **Step 6: Run tests, verify they pass**

```bash
npx vitest run src/telegram/
```

- [ ] **Step 7: Commit**

```bash
git add src/telegram/thread-resolver.ts src/telegram/thread-resolver.test.ts src/telegram/trigger.ts src/telegram/trigger.test.ts
git commit -m "feat: add thread resolver and trigger matching"
```

---

### Task 5: Filesystem Tools (sandboxed)

**Files:**
- Create: `src/tools/filesystem.ts`

- [ ] **Step 1: Write test**

Create `src/tools/filesystem.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createFsTools } from './filesystem.js';

describe('filesystem tools', () => {
  let tmpDir: string;
  let tools: ReturnType<typeof createFsTools>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mastraclaw-test-'));
    tools = createFsTools(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes and reads a file', async () => {
    await tools.writeFile.execute({ path: 'test.txt', content: 'hello' });
    const result = await tools.readFile.execute({ path: 'test.txt' });
    expect(result.content).toBe('hello');
  });

  it('lists files', async () => {
    await tools.writeFile.execute({ path: 'a.txt', content: '1' });
    await tools.writeFile.execute({ path: 'b.txt', content: '2' });
    const result = await tools.listFiles.execute({ path: '.' });
    expect(result.files).toHaveLength(2);
  });

  it('rejects path traversal with ..', async () => {
    await expect(
      tools.readFile.execute({ path: '../../../etc/passwd' })
    ).rejects.toThrow();
  });

  it('creates subdirectories', async () => {
    await tools.writeFile.execute({ path: 'sub/dir/file.txt', content: 'nested' });
    const result = await tools.readFile.execute({ path: 'sub/dir/file.txt' });
    expect(result.content).toBe('nested');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run src/tools/filesystem.test.ts
```

- [ ] **Step 3: Implement filesystem.ts**

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';

function safePath(baseDir: string, userPath: string): string {
  if (userPath.includes('..')) {
    throw new Error('Path traversal not allowed');
  }
  const resolved = path.resolve(baseDir, userPath);
  if (!resolved.startsWith(baseDir)) {
    throw new Error('Path outside sandbox');
  }
  return resolved;
}

export function createFsTools(baseDir: string) {
  const readFile = createTool({
    id: 'read-file',
    description: 'Read a file from the thread directory',
    inputSchema: z.object({
      path: z.string().describe('Relative path within thread directory'),
    }),
    outputSchema: z.object({
      content: z.string(),
    }),
    execute: async ({ path: userPath }) => {
      const fullPath = safePath(baseDir, userPath);
      const content = await fs.readFile(fullPath, 'utf-8');
      return { content };
    },
  });

  const writeFile = createTool({
    id: 'write-file',
    description: 'Write a file to the thread directory',
    inputSchema: z.object({
      path: z.string().describe('Relative path within thread directory'),
      content: z.string().describe('File content'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
    }),
    execute: async ({ path: userPath, content }) => {
      const fullPath = safePath(baseDir, userPath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');
      return { success: true };
    },
  });

  const listFiles = createTool({
    id: 'list-files',
    description: 'List files in the thread directory',
    inputSchema: z.object({
      path: z.string().optional().default('.').describe('Relative directory path'),
    }),
    outputSchema: z.object({
      files: z.array(z.string()),
    }),
    execute: async ({ path: userPath }) => {
      const fullPath = safePath(baseDir, userPath || '.');
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const files = entries.map(e => e.isDirectory() ? e.name + '/' : e.name);
      return { files };
    },
  });

  return { readFile, writeFile, listFiles };
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
npx vitest run src/tools/filesystem.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/tools/filesystem.ts src/tools/filesystem.test.ts
git commit -m "feat: add sandboxed filesystem tools"
```

---

### Task 6: Schedule Parser

**Files:**
- Create: `src/scheduler/schedule-parser.ts`

- [ ] **Step 1: Write test**

Create `src/scheduler/schedule-parser.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { parseSchedule, computeNextRun } from './schedule-parser.js';

describe('parseSchedule', () => {
  it('passes through cron expressions', () => {
    expect(parseSchedule('0 9 * * 1')).toEqual({ type: 'cron', value: '0 9 * * 1' });
  });

  it('parses "daily 8:00"', () => {
    expect(parseSchedule('daily 8:00')).toEqual({ type: 'cron', value: '0 8 * * *' });
  });

  it('parses "daily 8:00, 20:00"', () => {
    const result = parseSchedule('daily 8:00, 20:00');
    expect(result.type).toBe('cron');
    expect(result.value).toContain('8,20');
  });

  it('parses "weekly mon 9:00"', () => {
    expect(parseSchedule('weekly mon 9:00')).toEqual({ type: 'cron', value: '00 9 * * 1' });
  });

  it('parses "every 30m"', () => {
    expect(parseSchedule('every 30m')).toEqual({ type: 'cron', value: '*/30 * * * *' });
  });

  it('parses "every 2h"', () => {
    expect(parseSchedule('every 2h')).toEqual({ type: 'cron', value: '0 */2 * * *' });
  });
});

describe('computeNextRun', () => {
  it('returns null for once type', () => {
    expect(computeNextRun({ schedule_type: 'once', schedule_value: '', next_run: null })).toBeNull();
  });

  it('returns a future date for cron', () => {
    const next = computeNextRun({ schedule_type: 'cron', schedule_value: '0 9 * * *', next_run: null });
    expect(next).toBeDefined();
    expect(new Date(next!).getTime()).toBeGreaterThan(Date.now());
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run src/scheduler/schedule-parser.test.ts
```

- [ ] **Step 3: Implement schedule-parser.ts**

Port from NanoClaw's `obsidian-task-sync.ts` `parseSchedule()` and `task-scheduler.ts` `computeNextRun()`:

```typescript
import { CronExpressionParser } from 'cron-parser';
import { TIMEZONE } from '../config.js';

export function parseSchedule(schedule: string): { type: 'cron' | 'interval'; value: string } {
  const s = schedule.trim();

  // Already a cron expression
  if (/^[\d*\/,\-]+(\s+[\d*\/,\-]+){4}$/.test(s)) {
    return { type: 'cron', value: s };
  }

  // "every 30m" or "every 2h"
  const everyMatch = s.match(/^every\s+(\d+)\s*(m|h)$/i);
  if (everyMatch) {
    const n = parseInt(everyMatch[1], 10);
    const unit = everyMatch[2].toLowerCase();
    if (unit === 'm') return { type: 'cron', value: `*/${n} * * * *` };
    return { type: 'cron', value: `0 */${n} * * *` };
  }

  // "daily 8:00" or "daily 8:00, 20:00"
  const dailyMatch = s.match(/^daily\s+(.+)$/i);
  if (dailyMatch) {
    const times = dailyMatch[1].split(',').map(t => t.trim());
    const hours: string[] = [];
    const minutes: string[] = [];
    for (const time of times) {
      const [h, m] = time.split(':');
      hours.push(h);
      minutes.push(m || '0');
    }
    const uniqueMinutes = [...new Set(minutes)];
    const min = uniqueMinutes.length === 1 ? uniqueMinutes[0] : '0';
    return { type: 'cron', value: `${min} ${hours.join(',')} * * *` };
  }

  // "weekly mon 9:00" or "weekly mon,fri 9:00"
  const weeklyMatch = s.match(/^weekly\s+([\w,]+)\s+(\d{1,2}:\d{2})$/i);
  if (weeklyMatch) {
    const dayMap: Record<string, string> = {
      sun: '0', mon: '1', tue: '2', wed: '3', thu: '4', fri: '5', sat: '6',
    };
    const days = weeklyMatch[1]
      .split(',')
      .map(d => dayMap[d.trim().toLowerCase()] || d.trim())
      .join(',');
    const [h, m] = weeklyMatch[2].split(':');
    return { type: 'cron', value: `${m || '0'} ${h} * * ${days}` };
  }

  // Fallback: treat as cron
  return { type: 'cron', value: s };
}

export function computeNextRun(task: { schedule_type: string; schedule_value: string; next_run: string | null }): string | null {
  if (task.schedule_type === 'once') return null;

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, { tz: TIMEZONE });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) return null;
    const anchor = task.next_run ? new Date(task.next_run).getTime() : Date.now();
    let next = anchor + ms;
    while (next <= Date.now()) next += ms;
    return new Date(next).toISOString();
  }

  return null;
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
npx vitest run src/scheduler/schedule-parser.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/schedule-parser.ts src/scheduler/schedule-parser.test.ts
git commit -m "feat: add schedule parser with human-readable format support"
```

---

### Task 7: Send Message & Schedule Task Tools

**Files:**
- Create: `src/tools/send-message.ts`
- Create: `src/tools/schedule-task.ts`

- [ ] **Step 1: Implement send-message.ts**

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { Bot } from 'grammy';
import { parseThreadId } from '../telegram/thread-resolver.js';

export function createSendMessageTool(bot: Bot) {
  return createTool({
    id: 'send-message',
    description: 'Send a message to a Telegram chat or thread',
    inputSchema: z.object({
      threadId: z.string().describe('Thread ID in format tg:chatId or tg:chatId:threadId'),
      text: z.string().describe('Message text'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
    }),
    execute: async ({ threadId, text }) => {
      const { chatId, messageThreadId } = parseThreadId(threadId);
      await bot.api.sendMessage(chatId, text, {
        message_thread_id: messageThreadId,
      });
      return { success: true };
    },
  });
}
```

- [ ] **Step 2: Implement schedule-task.ts**

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { parseSchedule, computeNextRun } from '../scheduler/schedule-parser.js';
import type { createTables } from '../db/tables.js';
import { randomUUID } from 'crypto';

export function createScheduleTools(tables: ReturnType<typeof createTables>) {
  const scheduleTask = createTool({
    id: 'schedule-task',
    description: 'Create a new scheduled task',
    inputSchema: z.object({
      prompt: z.string().describe('Task instructions'),
      schedule: z.string().describe('Schedule: cron expression, "daily 8:00", "weekly mon 9:00", "every 30m"'),
      threadId: z.string().optional().describe('Thread to run in (uses current thread if omitted)'),
      contextMode: z.enum(['thread', 'isolated']).optional().default('isolated'),
      model: z.string().optional().describe('Model override, e.g. "google/gemini-2.5-pro"'),
    }),
    outputSchema: z.object({
      id: z.string(),
      nextRun: z.string().nullable(),
    }),
    execute: async ({ prompt, schedule, threadId, contextMode, model }, context) => {
      const parsed = parseSchedule(schedule);
      const id = `task-${randomUUID().slice(0, 8)}`;
      const taskData = {
        id,
        thread_id: threadId || 'unknown',
        prompt,
        schedule_type: parsed.type as 'cron' | 'interval' | 'once',
        schedule_value: parsed.value,
        context_mode: contextMode,
        model: model || null,
        next_run: null as string | null,
      };
      taskData.next_run = computeNextRun({
        schedule_type: taskData.schedule_type,
        schedule_value: taskData.schedule_value,
        next_run: null,
      });
      tables.createTask(taskData);
      return { id, nextRun: taskData.next_run };
    },
  });

  const listTasks = createTool({
    id: 'list-tasks',
    description: 'List scheduled tasks, optionally filtered by thread',
    inputSchema: z.object({
      threadId: z.string().optional().describe('Filter by thread ID'),
    }),
    outputSchema: z.object({
      tasks: z.array(z.object({
        id: z.string(),
        prompt: z.string(),
        schedule_type: z.string(),
        schedule_value: z.string(),
        status: z.string(),
        next_run: z.string().nullable(),
      })),
    }),
    execute: async ({ threadId }) => {
      const tasks = threadId
        ? tables.getTasksByThread(threadId)
        : tables.getAllTasks();
      return {
        tasks: tasks.map(t => ({
          id: t.id,
          prompt: t.prompt,
          schedule_type: t.schedule_type,
          schedule_value: t.schedule_value,
          status: t.status,
          next_run: t.next_run,
        })),
      };
    },
  });

  const pauseTask = createTool({
    id: 'pause-task',
    description: 'Pause a scheduled task',
    inputSchema: z.object({ id: z.string() }),
    outputSchema: z.object({ success: z.boolean() }),
    execute: async ({ id }) => {
      tables.updateTask(id, { status: 'paused' });
      return { success: true };
    },
  });

  const resumeTask = createTool({
    id: 'resume-task',
    description: 'Resume a paused scheduled task',
    inputSchema: z.object({ id: z.string() }),
    outputSchema: z.object({ success: z.boolean() }),
    execute: async ({ id }) => {
      const task = tables.getTaskById(id);
      if (!task) throw new Error(`Task ${id} not found`);
      const nextRun = computeNextRun(task);
      tables.updateTask(id, { status: 'active', next_run: nextRun });
      return { success: true };
    },
  });

  const cancelTask = createTool({
    id: 'cancel-task',
    description: 'Cancel and delete a scheduled task',
    inputSchema: z.object({ id: z.string() }),
    outputSchema: z.object({ success: z.boolean() }),
    execute: async ({ id }) => {
      tables.deleteTask(id);
      return { success: true };
    },
  });

  return { scheduleTask, listTasks, pauseTask, resumeTask, cancelTask };
}
```

- [ ] **Step 3: Commit**

```bash
git add src/tools/send-message.ts src/tools/schedule-task.ts
git commit -m "feat: add send-message and schedule-task Mastra tools"
```

---

### Task 8: Mastra Agent & Instance

**Files:**
- Create: `src/agent.ts`
- Create: `src/mastra/index.ts`

- [ ] **Step 1: Implement agent.ts**

```typescript
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { ModelRouterEmbeddingModel } from '@mastra/core/llm';
import type { Bot } from 'grammy';
import type { createTables } from './db/tables.js';

import { DEFAULT_MODEL, ASSISTANT_NAME } from './config.js';
import { createFsTools } from './tools/filesystem.js';
import { createSendMessageTool } from './tools/send-message.js';
import { createScheduleTools } from './tools/schedule-task.js';

const DB_URL = 'file:data/mastra.db';

export function createAgent(bot: Bot, tables: ReturnType<typeof createTables>) {
  const memory = new Memory({
    storage: new LibSQLStore({ id: 'mastra-storage', url: DB_URL }),
    vector: new LibSQLVector({ id: 'mastra-vector', url: DB_URL }),
    embedder: new ModelRouterEmbeddingModel('openai/text-embedding-3-small'),
    options: {
      lastMessages: 50,
      semanticRecall: { topK: 5 },
    },
  });

  // FS tools use a placeholder base dir; actual dir is set per-call via tool context
  // For now, we create default tools — the real sandboxing happens in the message handler
  const fsTools = createFsTools('data/threads/default');
  const sendMessage = createSendMessageTool(bot);
  const scheduleTools = createScheduleTools(tables);

  const agent = new Agent({
    id: 'mastraclaw-assistant',
    name: ASSISTANT_NAME,
    model: DEFAULT_MODEL,
    instructions: `You are ${ASSISTANT_NAME}, a personal AI assistant on Telegram.
You help with tasks, answer questions, manage schedules, and remember context from conversations.
You can read and write files in the user's thread directory.
You can schedule recurring tasks and send messages.
Be concise but helpful. Respond in the same language the user writes in.`,
    memory,
    tools: {
      ...fsTools,
      sendMessage,
      ...scheduleTools,
    },
  });

  return agent;
}
```

- [ ] **Step 2: Implement src/mastra/index.ts**

```typescript
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { createLogger } from '@mastra/core/logger';

// This file is the Mastra entry point for Studio.
// The actual agent is created in src/agent.ts and registered here at runtime.

export let mastra: Mastra;

export function initMastra(agents: Record<string, any>) {
  mastra = new Mastra({
    agents,
    storage: new LibSQLStore({ id: 'mastra-studio', url: 'file:data/mastra.db' }),
    logger: createLogger({ name: 'mastraclaw', level: 'info' }),
  });
  return mastra;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/agent.ts src/mastra/index.ts
git commit -m "feat: add Mastra agent with memory and tools"
```

---

### Task 9: Telegram Bot — Message Handler

**Files:**
- Create: `src/telegram/bot.ts`
- Create: `src/telegram/streaming.ts`

- [ ] **Step 1: Implement streaming.ts**

```typescript
import type { Api } from 'grammy';

const MIN_EDIT_INTERVAL = 1000; // ms between edits (Telegram rate limit)

export class StreamingMessage {
  private chatId: number;
  private messageId: number;
  private messageThreadId?: number;
  private api: Api;
  private lastEdit = 0;
  private pendingText = '';
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(api: Api, chatId: number, messageId: number, messageThreadId?: number) {
    this.api = api;
    this.chatId = chatId;
    this.messageId = messageId;
    this.messageThreadId = messageThreadId;
  }

  async update(text: string): Promise<void> {
    this.pendingText = text;
    const now = Date.now();
    const elapsed = now - this.lastEdit;

    if (elapsed >= MIN_EDIT_INTERVAL) {
      await this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), MIN_EDIT_INTERVAL - elapsed);
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pendingText) return;
    try {
      await this.api.editMessageText(this.chatId, this.messageId, this.pendingText);
      this.lastEdit = Date.now();
    } catch {
      // Telegram may reject edits if text hasn't changed
    }
  }
}
```

- [ ] **Step 2: Implement bot.ts**

```typescript
import { Bot } from 'grammy';
import type { Agent } from '@mastra/core/agent';
import pino from 'pino';

import { ASSISTANT_NAME } from '../config.js';
import { resolveThreadId, threadDir } from './thread-resolver.js';
import { shouldRespond } from './trigger.js';
import { StreamingMessage } from './streaming.js';

const logger = pino({ name: 'telegram' });

/** Register message handlers on an existing Bot instance */
export function setupBotHandlers(bot: Bot, agent: Agent) {

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    const chatType = ctx.chat.type;
    const threadId = resolveThreadId(ctx.chat.id, ctx.message.message_thread_id);

    // Check trigger
    if (!shouldRespond(chatType, text, null, ASSISTANT_NAME)) return;

    // Typing indicator
    await ctx.replyWithChatAction('typing');

    try {
      // Send placeholder
      const placeholder = await ctx.reply('...', {
        message_thread_id: ctx.message.message_thread_id,
      });

      // Stream response
      const stream = await agent.stream(text, {
        memory: {
          thread: threadId,
          resource: 'owner',
        },
      });

      const streaming = new StreamingMessage(
        ctx.api,
        ctx.chat.id,
        placeholder.message_id,
        ctx.message.message_thread_id,
      );

      let fullText = '';
      for await (const chunk of stream.textStream) {
        fullText += chunk;
        await streaming.update(fullText);
      }

      // Final flush
      await streaming.flush();

      // Handle long messages (split at 4096 chars)
      if (fullText.length > 4096) {
        // Delete placeholder and send chunks
        await ctx.api.deleteMessage(ctx.chat.id, placeholder.message_id);
        for (let i = 0; i < fullText.length; i += 4096) {
          await ctx.reply(fullText.slice(i, i + 4096), {
            message_thread_id: ctx.message.message_thread_id,
          });
        }
      }
    } catch (err) {
      logger.error({ err, threadId }, 'Agent error');
      await ctx.reply('Something went wrong. Please try again.', {
        message_thread_id: ctx.message.message_thread_id,
      });
    }
  });

}
```

- [ ] **Step 3: Commit**

```bash
git add src/telegram/bot.ts src/telegram/streaming.ts
git commit -m "feat: add Telegram bot with streaming responses"
```

---

### Task 10: Media Handling

**Files:**
- Create: `src/telegram/media.ts`

- [ ] **Step 1: Implement media.ts**

```typescript
import type { Context } from 'grammy';
import fs from 'fs/promises';
import path from 'path';
import pino from 'pino';
import { threadDir } from './thread-resolver.js';
import { ELEVENLABS_API_KEY } from '../config.js';

const logger = pino({ name: 'media' });

/** Download a Telegram file to the thread's attachments directory */
export async function downloadFile(ctx: Context, fileId: string, threadId: string, filename: string): Promise<string> {
  const dir = path.join(threadDir(threadId), 'attachments');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, filename);

  const file = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;

  const response = await fetch(url);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(filePath, buffer);

  return `attachments/${filename}`;
}

/** Handle photo messages — download largest photo */
export async function handlePhoto(ctx: Context, threadId: string): Promise<string> {
  const photos = ctx.message?.photo;
  if (!photos?.length) return '';
  const largest = photos[photos.length - 1];
  const relPath = await downloadFile(ctx, largest.file_id, threadId, `photo_${Date.now()}.jpg`);
  return `[Photo attached: ${relPath}]`;
}

/** Handle document messages */
export async function handleDocument(ctx: Context, threadId: string): Promise<string> {
  const doc = ctx.message?.document;
  if (!doc) return '';
  const filename = doc.file_name || `document_${Date.now()}`;
  const relPath = await downloadFile(ctx, doc.file_id, threadId, filename);
  return `[Document attached: ${relPath}]`;
}

/** Transcribe voice message via ElevenLabs Speech-to-Text */
export async function handleVoice(ctx: Context, threadId: string): Promise<string> {
  const voice = ctx.message?.voice || ctx.message?.audio;
  if (!voice) return '';

  if (!ELEVENLABS_API_KEY) {
    return '[Voice message received but ELEVENLABS_API_KEY not configured]';
  }

  try {
    // Download voice file
    const file = await ctx.api.getFile(voice.file_id);
    const url = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());

    // Save to attachments
    const dir = path.join(threadDir(threadId), 'attachments');
    await fs.mkdir(dir, { recursive: true });
    const audioPath = path.join(dir, `voice_${Date.now()}.ogg`);
    await fs.writeFile(audioPath, buffer);

    // Send to ElevenLabs Speech-to-Text
    const formData = new FormData();
    formData.append('file', new Blob([buffer]), 'voice.ogg');
    formData.append('model_id', 'scribe_v1');

    const sttResponse = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
      },
      body: formData,
    });

    if (!sttResponse.ok) {
      logger.error({ status: sttResponse.status }, 'ElevenLabs STT failed');
      return '[Voice message: transcription failed]';
    }

    const result = await sttResponse.json() as { text: string };
    return result.text || '[Voice message: empty transcription]';
  } catch (err) {
    logger.error({ err }, 'Voice transcription error');
    return '[Voice message: transcription error]';
  }
}
```

- [ ] **Step 2: Update bot.ts to handle media**

Add media handlers to `bot.ts` — add handlers for photo, document, and voice messages that extract text via media.ts and pass it to the agent just like text messages.

- [ ] **Step 3: Commit**

```bash
git add src/telegram/media.ts src/telegram/bot.ts
git commit -m "feat: add media handling with ElevenLabs voice transcription"
```

---

### Task 11: Scheduler

**Files:**
- Create: `src/scheduler/scheduler.ts`

- [ ] **Step 1: Implement scheduler.ts**

```typescript
import type { Agent } from '@mastra/core/agent';
import pino from 'pino';
import type { createTables } from '../db/tables.js';
import { computeNextRun } from './schedule-parser.js';
import { parseThreadId } from '../telegram/thread-resolver.js';
import type { Bot } from 'grammy';

const logger = pino({ name: 'scheduler' });

export function startScheduler(
  agent: Agent,
  tables: ReturnType<typeof createTables>,
  bot: Bot,
  intervalMs: number,
): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    const dueTasks = tables.getDueTasks();
    if (!dueTasks.length) return;

    logger.info({ count: dueTasks.length }, 'Processing due tasks');

    for (const task of dueTasks) {
      const startTime = Date.now();
      try {
        const threadId = task.context_mode === 'thread'
          ? task.thread_id
          : `task:${task.id}`;

        const result = await agent.generate(task.prompt, {
          memory: {
            thread: threadId,
            resource: 'owner',
          },
        });

        const durationMs = Date.now() - startTime;

        // Log success
        tables.logTaskRun(task.id, {
          durationMs,
          status: 'success',
          result: result.text,
        });

        // Send result to Telegram thread if there's text
        if (result.text) {
          const { chatId, messageThreadId } = parseThreadId(task.thread_id);
          await bot.api.sendMessage(chatId, result.text, {
            message_thread_id: messageThreadId,
          });
        }

        // Update next run
        const nextRun = computeNextRun(task);
        if (nextRun) {
          tables.updateTask(task.id, { next_run: nextRun, last_run: new Date().toISOString(), last_result: result.text });
        } else {
          tables.updateTask(task.id, { status: 'completed', last_run: new Date().toISOString(), last_result: result.text });
        }

        logger.info({ taskId: task.id, durationMs }, 'Task completed');
      } catch (err) {
        const durationMs = Date.now() - startTime;
        tables.logTaskRun(task.id, {
          durationMs,
          status: 'error',
          error: String(err),
        });

        // Still advance next_run to prevent stuck tasks
        const nextRun = computeNextRun(task);
        tables.updateTask(task.id, {
          next_run: nextRun,
          last_run: new Date().toISOString(),
          last_error: String(err),
        });

        logger.error({ taskId: task.id, err }, 'Scheduled task failed');
      }
    }
  }, intervalMs);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/scheduler/scheduler.ts
git commit -m "feat: add scheduled task executor"
```

---

### Task 12: Obsidian Sync

**Files:**
- Create: `src/scheduler/obsidian-sync.ts`

- [ ] **Step 1: Implement obsidian-sync.ts**

Port from NanoClaw's `obsidian-task-sync.ts`, simplified (no container mounts, no group lookup — uses threadId directly):

```typescript
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import type { createTables } from '../db/tables.js';
import { parseSchedule, computeNextRun } from './schedule-parser.js';
import { OBSIDIAN_TASKS_DIR } from '../config.js';

const logger = pino({ name: 'obsidian-sync' });
const TASK_ID_PREFIX = 'obs-';

interface ObsidianTask {
  id: string;
  schedule: string;
  threadId: string;
  status: 'active' | 'paused';
  prompt: string;
  model?: string;
}

function parseMarkdownTask(filePath: string, filename: string): ObsidianTask | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!fmMatch) return null;

    const frontmatter = fmMatch[1];
    const body = fmMatch[2].trim();

    const getValue = (key: string): string | undefined => {
      const match = frontmatter.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, 'm'));
      return match?.[1];
    };

    const schedule = getValue('schedule');
    const threadId = getValue('thread');
    const status = getValue('status') as 'active' | 'paused' | undefined;
    const model = getValue('model');

    if (!schedule || !threadId || !body) {
      logger.warn({ filePath }, 'Obsidian task: missing required fields');
      return null;
    }

    return {
      id: TASK_ID_PREFIX + filename.replace(/\.md$/, ''),
      schedule,
      threadId,
      status: status || 'active',
      prompt: body,
      model,
    };
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to parse Obsidian task');
    return null;
  }
}

export function syncObsidianTasks(tables: ReturnType<typeof createTables>): void {
  if (!OBSIDIAN_TASKS_DIR || !fs.existsSync(OBSIDIAN_TASKS_DIR)) return;

  let files: string[];
  try {
    files = fs.readdirSync(OBSIDIAN_TASKS_DIR).filter(f => f.endsWith('.md'));
  } catch {
    return;
  }

  const obsidianTasks = new Map<string, ObsidianTask>();
  for (const file of files) {
    const task = parseMarkdownTask(path.join(OBSIDIAN_TASKS_DIR, file), file);
    if (task) obsidianTasks.set(task.id, task);
  }

  const allDbTasks = tables.getAllTasks();
  const existingObsTasks = allDbTasks.filter(t => t.id.startsWith(TASK_ID_PREFIX));

  // Create or update
  for (const [id, obsTask] of obsidianTasks) {
    const parsed = parseSchedule(obsTask.schedule);
    const existing = tables.getTaskById(id);

    if (!existing) {
      const nextRun = obsTask.status === 'active'
        ? computeNextRun({ schedule_type: parsed.type, schedule_value: parsed.value, next_run: null })
        : null;

      tables.createTask({
        id,
        thread_id: obsTask.threadId,
        prompt: obsTask.prompt,
        schedule_type: parsed.type as 'cron' | 'interval' | 'once',
        schedule_value: parsed.value,
        context_mode: 'thread',
        model: obsTask.model || null,
        status: obsTask.status,
        next_run: nextRun,
      });
      logger.info({ taskId: id }, 'Obsidian task created');
    } else {
      const changes: Record<string, unknown> = {};
      if (existing.prompt !== obsTask.prompt) changes.prompt = obsTask.prompt;
      if (existing.schedule_value !== parsed.value) {
        changes.schedule_value = parsed.value;
        changes.schedule_type = parsed.type;
        if (obsTask.status === 'active') {
          changes.next_run = computeNextRun({ schedule_type: parsed.type, schedule_value: parsed.value, next_run: null });
        }
      }
      if (existing.status !== obsTask.status) {
        changes.status = obsTask.status;
        if (obsTask.status === 'active' && !existing.next_run) {
          changes.next_run = computeNextRun({ schedule_type: parsed.type, schedule_value: parsed.value, next_run: null });
        }
      }
      if ((existing.model || null) !== (obsTask.model || null)) {
        changes.model = obsTask.model || null;
      }

      if (Object.keys(changes).length > 0) {
        tables.updateTask(id, changes as any);
        logger.info({ taskId: id, changes: Object.keys(changes) }, 'Obsidian task updated');
      }
    }
  }

  // Delete removed files
  for (const dbTask of existingObsTasks) {
    if (!obsidianTasks.has(dbTask.id)) {
      tables.deleteTask(dbTask.id);
      logger.info({ taskId: dbTask.id }, 'Obsidian task deleted');
    }
  }
}

export function startObsidianSync(tables: ReturnType<typeof createTables>, intervalMs: number): ReturnType<typeof setInterval> {
  // Initial sync
  syncObsidianTasks(tables);
  // Recurring sync
  return setInterval(() => syncObsidianTasks(tables), intervalMs);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/scheduler/obsidian-sync.ts
git commit -m "feat: add Obsidian markdown task sync"
```

---

### Task 13: Entry Point & Graceful Shutdown

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Implement index.ts**

```typescript
import 'dotenv/config';
import { Bot } from 'grammy';
import pino from 'pino';
import fs from 'fs';

import { TELEGRAM_BOT_TOKEN, DB_PATH, DATA_DIR, SCHEDULER_POLL_INTERVAL, OBSIDIAN_SYNC_INTERVAL } from './config.js';
import { createDb, closeDb } from './db/storage.js';
import { createTables } from './db/tables.js';
import { createAgent } from './agent.js';
import { setupBotHandlers } from './telegram/bot.js';
import { startScheduler } from './scheduler/scheduler.js';
import { startObsidianSync } from './scheduler/obsidian-sync.js';
import { initMastra } from './mastra/index.js';

const logger = pino({ name: 'mastraclaw' });

// Validate required env vars
if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');

// Ensure data directory exists
fs.mkdirSync(DATA_DIR, { recursive: true });

// Initialize database
const db = createDb(DB_PATH);
const tables = createTables(db);

// Single Bot instance — shared between tools and message handler
const bot = new Bot(TELEGRAM_BOT_TOKEN);

// Create Mastra agent (uses bot for send-message tool)
const agent = createAgent(bot, tables);

// Register with Mastra Studio
initMastra({ assistant: agent });

// Setup Telegram message handlers on the same bot
setupBotHandlers(bot, agent);

// Start scheduler and Obsidian sync
const schedulerTimer = startScheduler(agent, tables, bot, SCHEDULER_POLL_INTERVAL);
const obsidianTimer = startObsidianSync(tables, OBSIDIAN_SYNC_INTERVAL);

// Graceful shutdown
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down...');

  bot.stop();
  clearInterval(schedulerTimer);
  clearInterval(obsidianTimer);

  // Wait briefly for in-flight requests
  await new Promise(resolve => setTimeout(resolve, 2000));

  closeDb(db);
  logger.info('Shutdown complete');
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start
logger.info('Starting MastraClaw...');
bot.start({
  onStart: (info) => logger.info({ username: info.username }, 'Bot started'),
});
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run check
```

Fix any type errors that surface.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add entry point with graceful shutdown"
```

---

### Task 14: Run All Tests & Fix

- [ ] **Step 1: Run all tests**

```bash
npx vitest run
```

Expected: All tests pass (config, db/storage, db/tables, telegram/thread-resolver, telegram/trigger, tools/filesystem, scheduler/schedule-parser).

- [ ] **Step 2: Fix any failures**

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: verify all tests pass"
```

---

### Task 15: Smoke Test — End to End

- [ ] **Step 1: Add real API keys to .env**

Fill in `TELEGRAM_BOT_TOKEN` and `ANTHROPIC_API_KEY` in `.env`.

- [ ] **Step 2: Start the bot**

```bash
npm run dev
```

- [ ] **Step 3: Send a test message to the bot on Telegram**

Verify:
- Bot responds with streaming (edit-message)
- Memory persists (ask "what did I just say?")
- Thread isolation works in forum groups

- [ ] **Step 4: Test scheduled task via agent**

Ask the bot: "Schedule a task to greet me every day at 9:00"
Verify the task appears in the database.

- [ ] **Step 5: Test Mastra Studio**

```bash
npx mastra dev
```

Open `http://localhost:4111`, verify agent appears with tools and memory threads.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "chore: smoke test passed, MastraClaw v1 complete"
```
