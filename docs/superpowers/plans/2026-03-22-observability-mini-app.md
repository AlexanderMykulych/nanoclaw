# NanoClaw Observability Mini App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Telegram Mini App that shows NanoClaw health, groups, scheduled tasks, and error log — replacing the need for SSH access to check system status.

**Architecture:** New HTTP API server (`src/api.ts`) running alongside the main process, serving JSON endpoints. Vue 3 SPA (`mini-app/`) built with Vite, deployed as static files behind Caddy reverse proxy. Pino custom transport writes errors to new `error_log` SQLite table. Telegram `/check` command and Bot Menu Button open the Mini App.

**Tech Stack:** Node.js `node:http`, Vue 3, Vue Router, Vite, Telegram WebApp SDK, Pino transport, better-sqlite3, Caddy

**Spec:** `docs/superpowers/specs/2026-03-22-observability-mini-app-design.md`

---

## File Map

### New Files (NanoClaw backend)

| File | Responsibility |
|------|----------------|
| `src/api.ts` | HTTP API server — routes, request parsing, JSON responses |
| `src/api-auth.ts` | Telegram initData HMAC validation middleware |
| `src/api-auth.test.ts` | Tests for initData validation |
| `src/error-log-transport.ts` | Pino transport — writes error+ entries to SQLite |
| `src/error-log-transport.test.ts` | Tests for transport filtering and writing |

### Modified Files (NanoClaw backend)

| File | Changes |
|------|---------|
| `src/db.ts` | Add `error_log` table creation, `logError()` / `getErrors()` / `cleanupErrors()` query functions |
| `src/logger.ts` | Switch from single transport to `pino.transport({ targets: [...] })` with pino-pretty + custom error transport |
| `src/config.ts` | Add `API_PORT` constant (default 3847) |
| `src/index.ts` | Start API server in main init, pass `queue` reference for runtime data |
| `src/channels/telegram.ts` | Add `/check` command handler, call `setMenuButton` on bot start |
| `src/group-queue.ts` | Add `getStatus()` public method returning active containers info |

### New Files (Mini App frontend)

| File | Responsibility |
|------|----------------|
| `mini-app/package.json` | Separate project deps (vue, vue-router, vite) |
| `mini-app/tsconfig.json` | TypeScript config for Vue SPA |
| `mini-app/vite.config.ts` | Vite config with API proxy for dev |
| `mini-app/index.html` | Entry HTML |
| `mini-app/src/main.ts` | App bootstrap — Telegram SDK init, router, mount |
| `mini-app/src/App.vue` | Root layout with router-view |
| `mini-app/src/api.ts` | Typed fetch wrapper with initData auth header |
| `mini-app/src/composables/useHealth.ts` | Polling composable for /api/health |
| `mini-app/src/views/HomeView.vue` | Health indicator + drill-down cards |
| `mini-app/src/views/GroupsView.vue` | Groups list |
| `mini-app/src/views/TasksView.vue` | Scheduled tasks + run logs |
| `mini-app/src/views/ErrorsView.vue` | Paginated error log |
| `mini-app/src/components/HealthIndicator.vue` | OK/WARNING/ERROR circle |
| `mini-app/src/components/DrillCard.vue` | Reusable navigation card |

---

## Task 1: error_log table + DB functions

**Files:**
- Modify: `src/db.ts`
- Test: `src/db.test.ts`

- [ ] **Step 1: Write failing test for logError and getErrors**

In `src/db.test.ts`, add:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase, logError, getErrors, getErrorCountSince, cleanupErrors, _backdateErrors as backdateErrors } from './db.js';

describe('error_log', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('stores and retrieves errors', () => {
    logError({
      level: 'error',
      source: 'container',
      groupFolder: 'test-group',
      message: 'Container spawn failed',
      stack: 'Error: spawn ENOENT\n  at ...',
    });
    logError({
      level: 'error',
      source: 'ipc',
      message: 'Parse error',
    });

    const errors = getErrors({ limit: 50, offset: 0 });
    expect(errors).toHaveLength(2);
    expect(errors[0].source).toBe('ipc'); // newest first
    expect(errors[1].source).toBe('container');
    expect(errors[1].group_folder).toBe('test-group');
    expect(errors[1].stack).toContain('ENOENT');
  });

  it('respects limit and offset', () => {
    for (let i = 0; i < 10; i++) {
      logError({ level: 'error', message: `Error ${i}` });
    }
    const page = getErrors({ limit: 3, offset: 2 });
    expect(page).toHaveLength(3);
  });

  it('counts errors in time window', () => {
    logError({ level: 'error', message: 'recent' });
    const count = getErrorCountSince(60); // last 60 minutes
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('cleans up old errors', () => {
    logError({ level: 'error', message: 'old error' });
    // Manually backdate the record via exported test helper
    backdateErrors(6);
    cleanupErrors(5);
    expect(getErrors({ limit: 50, offset: 0 })).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/db.test.ts`
Expected: FAIL — `logError`, `getErrors`, `getErrorCountSince`, `cleanupErrors` not exported

- [ ] **Step 3: Implement error_log table and query functions**

In `src/db.ts`, add table creation inside `initDatabase()` after existing tables:

```typescript
database.exec(`
  CREATE TABLE IF NOT EXISTS error_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    level TEXT NOT NULL,
    source TEXT,
    group_folder TEXT,
    message TEXT NOT NULL,
    stack TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_error_log_timestamp ON error_log(timestamp);
`);
```

Add query functions (export them):

```typescript
export interface ErrorLogEntry {
  id: number;
  timestamp: string;
  level: string;
  source: string | null;
  group_folder: string | null;
  message: string;
  stack: string | null;
}

export interface LogErrorInput {
  level: string;
  source?: string;
  groupFolder?: string;
  message: string;
  stack?: string;
}

export function logError(input: LogErrorInput): void {
  db.prepare(
    `INSERT INTO error_log (level, source, group_folder, message, stack)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.level, input.source ?? null, input.groupFolder ?? null, input.message, input.stack ?? null);
}

export function getErrors(opts: { limit: number; offset: number }): ErrorLogEntry[] {
  return db
    .prepare('SELECT * FROM error_log ORDER BY timestamp DESC LIMIT ? OFFSET ?')
    .all(opts.limit, opts.offset) as ErrorLogEntry[];
}

export function getErrorCountSince(minutes: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM error_log
       WHERE timestamp > datetime('now', '-' || ? || ' minutes')`,
    )
    .get(minutes) as { count: number };
  return row.count;
}

export function cleanupErrors(days: number): void {
  db.prepare(
    `DELETE FROM error_log WHERE timestamp < datetime('now', '-' || ? || ' days')`,
  ).run(days);
}

// Test helper — backdate all error_log entries by N days
export function _backdateErrors(days: number): void {
  db.prepare(
    `UPDATE error_log SET timestamp = datetime('now', '-' || ? || ' days')`,
  ).run(days);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat: add error_log table with logError/getErrors/cleanupErrors"
```

---

## Task 2: Pino error transport

**Files:**
- Create: `src/error-log-transport.ts`
- Create: `src/error-log-transport.test.ts`
- Modify: `src/logger.ts`

- [ ] **Step 1: Write failing test for error log transport**

Create `src/error-log-transport.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { shouldLogToDb, extractErrorFields } from './error-log-transport.js';

describe('error-log-transport', () => {
  it('filters by log level — only error and fatal', () => {
    expect(shouldLogToDb(50)).toBe(true);  // error
    expect(shouldLogToDb(60)).toBe(true);  // fatal
    expect(shouldLogToDb(30)).toBe(false); // info
    expect(shouldLogToDb(40)).toBe(false); // warn
  });

  it('extracts structured fields from pino log object', () => {
    const logObj = {
      level: 50,
      msg: 'Container spawn failed',
      source: 'container',
      groupFolder: 'main-chat',
      err: { message: 'ENOENT', stack: 'Error: ENOENT\n  at ...' },
    };
    const fields = extractErrorFields(logObj);
    expect(fields).toEqual({
      level: 'error',
      source: 'container',
      groupFolder: 'main-chat',
      message: 'Container spawn failed',
      stack: 'Error: ENOENT\n  at ...',
    });
  });

  it('handles log objects without structured fields', () => {
    const logObj = { level: 50, msg: 'Something failed' };
    const fields = extractErrorFields(logObj);
    expect(fields).toEqual({
      level: 'error',
      source: undefined,
      groupFolder: undefined,
      message: 'Something failed',
      stack: undefined,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/error-log-transport.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement error log transport helpers**

Create `src/error-log-transport.ts`:

```typescript
import { logError, type LogErrorInput } from './db.js';

const LEVEL_NAMES: Record<number, string> = {
  50: 'error',
  60: 'fatal',
};

export function shouldLogToDb(level: number): boolean {
  return level >= 50;
}

export function extractErrorFields(logObj: Record<string, unknown>): LogErrorInput {
  const level = LEVEL_NAMES[logObj.level as number] ?? 'error';
  const err = logObj.err as { message?: string; stack?: string } | undefined;

  return {
    level,
    source: logObj.source as string | undefined,
    groupFolder: logObj.groupFolder as string | undefined,
    message: (logObj.msg as string) || err?.message || 'Unknown error',
    stack: err?.stack,
  };
}

export function writeErrorToDb(logObj: Record<string, unknown>): void {
  if (!shouldLogToDb(logObj.level as number)) return;
  const fields = extractErrorFields(logObj);
  logError(fields);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/error-log-transport.test.ts`
Expected: PASS

- [ ] **Step 5: Integrate transport into logger.ts**

Replace `src/logger.ts` with `pino.multistream()` — this keeps pino-pretty for stdout AND adds a custom Writable for DB errors. Note: we can't use `pino.transport()` for the DB stream because transports run in worker threads and can't access the main thread's SQLite connection.

```typescript
import pino from 'pino';
import { Writable } from 'stream';
import pretty from 'pino-pretty';

let dbWriter: ((logObj: Record<string, unknown>) => void) | null = null;

export function setErrorDbWriter(fn: (logObj: Record<string, unknown>) => void): void {
  dbWriter = fn;
}

const dbStream = new Writable({
  write(chunk, _encoding, callback) {
    if (dbWriter) {
      try {
        const obj = JSON.parse(chunk.toString());
        if (obj.level >= 50) dbWriter(obj);
      } catch {
        // ignore parse errors
      }
    }
    callback();
  },
});

const prettyStream = pretty({ colorize: true });

export const logger = pino(
  { level: process.env.LOG_LEVEL || 'info' },
  pino.multistream([
    { stream: prettyStream },
    { level: 'error', stream: dbStream },
  ]),
);

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
```

Then in `src/index.ts`, after `initDatabase()`:

```typescript
import { setErrorDbWriter } from './logger.js';
import { writeErrorToDb } from './error-log-transport.js';

setErrorDbWriter(writeErrorToDb);
```

- [ ] **Step 6: Run all tests**

Run: `npm test -- --run`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/error-log-transport.ts src/error-log-transport.test.ts src/logger.ts
git commit -m "feat: add Pino error transport writing to error_log SQLite table"
```

---

## Task 3: API auth (Telegram initData validation)

**Files:**
- Create: `src/api-auth.ts`
- Create: `src/api-auth.test.ts`

- [ ] **Step 1: Write failing test for initData validation**

Create `src/api-auth.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { validateTelegramInitData } from './api-auth.js';

const BOT_TOKEN = 'test:fake-bot-token';

function buildInitData(params: Record<string, string>, token: string): string {
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const checkEntries = Object.entries(params)
    .filter(([k]) => k !== 'hash')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const hash = crypto.createHmac('sha256', secret).update(checkEntries).digest('hex');
  return new URLSearchParams({ ...params, hash }).toString();
}

describe('validateTelegramInitData', () => {
  it('accepts valid initData', () => {
    const authDate = Math.floor(Date.now() / 1000).toString();
    const initData = buildInitData(
      { auth_date: authDate, user: '{"id":123}', query_id: 'test' },
      BOT_TOKEN,
    );
    expect(validateTelegramInitData(initData, BOT_TOKEN)).toBe(true);
  });

  it('rejects tampered initData', () => {
    const authDate = Math.floor(Date.now() / 1000).toString();
    const initData = buildInitData(
      { auth_date: authDate, user: '{"id":123}' },
      BOT_TOKEN,
    );
    const tampered = initData.replace('123', '456');
    expect(validateTelegramInitData(tampered, BOT_TOKEN)).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateTelegramInitData('', BOT_TOKEN)).toBe(false);
  });

  it('rejects missing hash', () => {
    expect(validateTelegramInitData('auth_date=123&user=test', BOT_TOKEN)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/api-auth.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement validateTelegramInitData**

Create `src/api-auth.ts`:

```typescript
import crypto from 'crypto';

export function validateTelegramInitData(initData: string, botToken: string): boolean {
  if (!initData) return false;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return false;

  params.delete('hash');
  const checkString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');

  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(computedHash, 'hex'));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/api-auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/api-auth.ts src/api-auth.test.ts
git commit -m "feat: add Telegram initData HMAC validation"
```

---

## Task 4: GroupQueue status method

**Files:**
- Modify: `src/group-queue.ts`
- Modify: `src/group-queue.test.ts`

- [ ] **Step 1: Write failing test for getStatus()**

Add to `src/group-queue.test.ts`:

```typescript
describe('getStatus', () => {
  it('returns empty when no containers active', () => {
    const status = queue.getStatus();
    expect(status.activeCount).toBe(0);
    expect(status.containers).toEqual([]);
    expect(status.queuedCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/group-queue.test.ts`
Expected: FAIL — `getStatus` not a function

- [ ] **Step 3: Implement getStatus()**

Add to `src/group-queue.ts`:

```typescript
export interface QueueStatus {
  activeCount: number;
  queuedCount: number;
  containers: Array<{
    jid: string;
    containerName: string | null;
    groupFolder: string | null;
    isTaskContainer: boolean;
    runningTaskId: string | null;
  }>;
}

// Inside class GroupQueue:
getStatus(): QueueStatus {
  const containers: QueueStatus['containers'] = [];
  for (const [jid, state] of this.groups) {
    if (state.active) {
      containers.push({
        jid,
        containerName: state.containerName,
        groupFolder: state.groupFolder,
        isTaskContainer: state.isTaskContainer,
        runningTaskId: state.runningTaskId,
      });
    }
  }
  return {
    activeCount: this.activeCount,
    queuedCount: this.waitingGroups.length,
    containers,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/group-queue.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/group-queue.ts src/group-queue.test.ts
git commit -m "feat: add GroupQueue.getStatus() for runtime container info"
```

---

## Task 5: HTTP API server

**Files:**
- Create: `src/api.ts`
- Modify: `src/config.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Add API_PORT to config**

In `src/config.ts`, add:

```typescript
export const API_PORT = parseInt(process.env.API_PORT || '3847', 10);
```

- [ ] **Step 2: Create src/api.ts with all endpoints**

```typescript
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { logger } from './logger.js';
import { validateTelegramInitData } from './api-auth.js';
import {
  getRegisteredGroupsList,
  getScheduledTasks,
  getTaskRunLogs,
  getErrors,
  getErrorCountSince,
} from './db.js';
import type { GroupQueue } from './group-queue.js';
import { readEnvFile } from './env.js';

interface ApiDeps {
  queue: GroupQueue;
  version: string;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Telegram-Web-App-Init-Data',
  });
  res.end(JSON.stringify(data));
}

function parseUrl(url: string): { path: string; params: URLSearchParams } {
  const parsed = new URL(url, 'http://localhost');
  return { path: parsed.pathname, params: parsed.searchParams };
}

export function startApiServer(port: number, deps: ApiDeps): Promise<Server> {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const botToken = process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';

  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Telegram-Web-App-Init-Data',
        });
        res.end();
        return;
      }

      // Auth check
      const initData = req.headers['telegram-web-app-init-data'] as string || '';
      if (botToken && !validateTelegramInitData(initData, botToken)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }

      const { path, params } = parseUrl(req.url || '/');

      try {
        if (path === '/api/health') {
          const queueStatus = deps.queue.getStatus();
          const errorsLastHour = getErrorCountSince(60);
          let status: 'ok' | 'warning' | 'error' = 'ok';
          if (errorsLastHour > 0) status = 'warning';
          // Check for critical errors (container spawn failures in last hour)
          const recentErrors = getErrors({ limit: 10, offset: 0 });
          const hasCritical = recentErrors.some(
            (e) =>
              e.source === 'container' &&
              e.timestamp > new Date(Date.now() - 3600000).toISOString(),
          );
          if (hasCritical) status = 'error';

          sendJson(res, 200, {
            status,
            uptime: process.uptime(),
            version: deps.version,
            groups_count: getRegisteredGroupsList().length,
            tasks_count: getScheduledTasks().length,
            errors_last_hour: errorsLastHour,
            active_containers: queueStatus.activeCount,
            queued_containers: queueStatus.queuedCount,
          });
        } else if (path === '/api/groups') {
          const groups = getRegisteredGroupsList();
          const queueStatus = deps.queue.getStatus();
          const activeJids = new Set(queueStatus.containers.map((c) => c.jid));
          const result = groups.map((g) => ({
            jid: g.jid,
            name: g.name,
            folder: g.folder,
            has_active_container: activeJids.has(g.jid),
          }));
          sendJson(res, 200, result);
        } else if (path === '/api/tasks') {
          sendJson(res, 200, getScheduledTasks());
        } else if (path.match(/^\/api\/tasks\/[^/]+\/logs$/)) {
          const taskId = path.split('/')[3];
          sendJson(res, 200, getTaskRunLogs(taskId));
        } else if (path === '/api/errors') {
          const limit = parseInt(params.get('limit') || '50', 10);
          const offset = parseInt(params.get('offset') || '0', 10);
          sendJson(res, 200, getErrors({ limit, offset }));
        } else {
          sendJson(res, 404, { error: 'Not found' });
        }
      } catch (err) {
        logger.error({ err, path }, 'API request error');
        sendJson(res, 500, { error: 'Internal server error' });
      }
    });

    server.listen(port, '127.0.0.1', () => {
      logger.info({ port }, 'API server started');
      resolve(server);
    });

    server.on('error', reject);
  });
}
```

- [ ] **Step 3: Add missing DB query functions if needed**

In `src/db.ts`, ensure these are exported. Note: `getAllRegisteredGroups()` already exists returning `Record<string, RegisteredGroup>` — this new function returns a flat array with `last_message_time` from the `chats` table joined in:

```typescript
export function getRegisteredGroupsList(): Array<{ jid: string; name: string; folder: string; last_message_time: string | null }> {
  return db.prepare(`
    SELECT g.jid, g.name, g.folder, c.last_message_time
    FROM registered_groups g
    LEFT JOIN chats c ON g.jid = c.jid
    ORDER BY c.last_message_time DESC
  `).all() as Array<{
    jid: string;
    name: string;
    folder: string;
    last_message_time: string | null;
  }>;
}

export function getScheduledTasks(): ScheduledTask[] {
  return db.prepare('SELECT * FROM scheduled_tasks ORDER BY next_run ASC').all() as ScheduledTask[];
}

export function getTaskRunLogs(taskId: string): Array<{
  run_at: string;
  duration_ms: number;
  status: string;
  result: string | null;
  error: string | null;
}> {
  return db
    .prepare('SELECT run_at, duration_ms, status, result, error FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT 50')
    .all(taskId) as Array<{ run_at: string; duration_ms: number; status: string; result: string | null; error: string | null }>;
}
```

- [ ] **Step 4: Wire API server into index.ts**

In `src/index.ts`, after `initDatabase()` and before channels setup:

```typescript
import { startApiServer } from './api.js';
import { setErrorDbWriter } from './logger.js';
import { writeErrorToDb } from './error-log-transport.js';
import { cleanupErrors } from './db.js';
import { API_PORT } from './config.js';
import { readFileSync } from 'fs';

// After initDatabase():
setErrorDbWriter(writeErrorToDb);
cleanupErrors(5);

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
const apiServer = await startApiServer(API_PORT, {
  queue,
  version: pkg.version,
});

// In shutdown handler, add:
apiServer.close();
```

- [ ] **Step 5: Run all tests and typecheck**

Run: `npm test -- --run && npm run typecheck`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/api.ts src/config.ts src/index.ts src/db.ts
git commit -m "feat: add HTTP API server with health, groups, tasks, errors endpoints"
```

---

## Task 6: Telegram /check command + Menu Button

**Files:**
- Modify: `src/channels/telegram.ts`

- [ ] **Step 1: Add MINI_APP_URL to config**

In `src/config.ts`:

```typescript
export const MINI_APP_URL = process.env.MINI_APP_URL || '';
```

- [ ] **Step 2: Add /check command and menu button in telegram.ts**

In `src/channels/telegram.ts`, inside `connect()` method, after existing commands (`/ping`):

```typescript
import { MINI_APP_URL } from './config.js';

// After /ping command:
if (MINI_APP_URL) {
  this.bot.command('check', (ctx) => {
    ctx.reply('Open NanoClaw Dashboard:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📊 Dashboard', web_app: { url: MINI_APP_URL } }],
        ],
      },
    });
  });
}
```

In the `onStart` callback (where bot startup is confirmed), add menu button setup:

```typescript
// Inside bot.start() onStart callback:
if (MINI_APP_URL) {
  this.bot.api.setChatMenuButton({
    menu_button: {
      type: 'web_app',
      text: 'Dashboard',
      web_app: { url: MINI_APP_URL },
    },
  }).catch((err) => {
    logger.warn({ err }, 'Failed to set menu button');
  });
}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/channels/telegram.ts src/config.ts
git commit -m "feat: add /check command and Bot Menu Button for Mini App"
```

---

## Task 7: Vue Mini App scaffold

**Files:**
- Create: all files under `mini-app/`

- [ ] **Step 1: Initialize mini-app project**

```bash
mkdir -p mini-app/src/{views,components,composables}
```

- [ ] **Step 2: Create package.json**

Create `mini-app/package.json`:

```json
{
  "name": "nanoclaw-mini-app",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc --noEmit && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "vue": "^3.5.0",
    "vue-router": "^4.5.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.2.0",
    "typescript": "^5.7.0",
    "vite": "^6.1.0",
    "vue-tsc": "^2.2.0"
  }
}
```

- [ ] **Step 3: Create tsconfig.json**

Create `mini-app/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "preserve",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "noEmit": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts", "src/**/*.vue"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

Create `mini-app/tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 4: Create vite.config.ts**

Create `mini-app/vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': '/src' },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3847',
        changeOrigin: true,
      },
    },
  },
});
```

- [ ] **Step 5: Create index.html**

Create `mini-app/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no" />
  <title>NanoClaw</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

- [ ] **Step 6: Create src/main.ts**

Create `mini-app/src/main.ts`:

```typescript
import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./views/HomeView.vue') },
    { path: '/groups', component: () => import('./views/GroupsView.vue') },
    { path: '/tasks', component: () => import('./views/TasksView.vue') },
    { path: '/errors', component: () => import('./views/ErrorsView.vue') },
  ],
});

// Telegram BackButton integration
const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

router.afterEach((to) => {
  if (to.path !== '/' && tg) {
    tg.BackButton.show();
  } else if (tg) {
    tg.BackButton.hide();
  }
});

if (tg) {
  tg.BackButton.onClick(() => router.back());
}

const app = createApp(App);
app.use(router);
app.mount('#app');
```

- [ ] **Step 7: Create src/env.d.ts for Telegram types**

Create `mini-app/src/env.d.ts`:

```typescript
/// <reference types="vite/client" />

interface TelegramWebApp {
  ready(): void;
  expand(): void;
  close(): void;
  initData: string;
  themeParams: {
    bg_color?: string;
    text_color?: string;
    hint_color?: string;
    button_color?: string;
    button_text_color?: string;
    secondary_bg_color?: string;
  };
  BackButton: {
    show(): void;
    hide(): void;
    onClick(cb: () => void): void;
  };
}

interface Window {
  Telegram?: {
    WebApp?: TelegramWebApp;
  };
}
```

- [ ] **Step 8: Create src/App.vue**

Create `mini-app/src/App.vue`:

```vue
<script setup lang="ts">
const tg = window.Telegram?.WebApp;
const theme = tg?.themeParams ?? {};

const cssVars = {
  '--bg-color': theme.bg_color ?? '#0f0f23',
  '--text-color': theme.text_color ?? '#e0e0e0',
  '--hint-color': theme.hint_color ?? '#999999',
  '--button-color': theme.button_color ?? '#60a5fa',
  '--secondary-bg': theme.secondary_bg_color ?? '#1a1a3e',
};
</script>

<template>
  <div class="app" :style="cssVars">
    <router-view />
  </div>
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}

.app {
  background: var(--bg-color);
  color: var(--text-color);
  min-height: 100vh;
  padding: 16px;
}
</style>
```

- [ ] **Step 9: Install dependencies and verify build**

```bash
cd mini-app && npm install && npm run build
```

Expected: Build succeeds (views are empty placeholders for now, but scaffold works)

- [ ] **Step 10: Commit**

```bash
git add mini-app/
git commit -m "feat: scaffold Vue Mini App with router, Telegram SDK, and theme integration"
```

---

## Task 8: API fetch wrapper

**Files:**
- Create: `mini-app/src/api.ts`

- [ ] **Step 1: Create typed API client**

Create `mini-app/src/api.ts`:

```typescript
const tg = window.Telegram?.WebApp;

async function fetchApi<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (tg?.initData) {
    headers['Telegram-Web-App-Init-Data'] = tg.initData;
  }

  const res = await fetch(path, { headers });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

export interface HealthResponse {
  status: 'ok' | 'warning' | 'error';
  uptime: number;
  version: string;
  groups_count: number;
  tasks_count: number;
  errors_last_hour: number;
  active_containers: number;
  queued_containers: number;
}

export interface Group {
  jid: string;
  name: string;
  folder: string;
  has_active_container: boolean;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  status: string;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
}

export interface TaskLog {
  run_at: string;
  duration_ms: number;
  status: string;
  result: string | null;
  error: string | null;
}

export interface ErrorEntry {
  id: number;
  timestamp: string;
  level: string;
  source: string | null;
  group_folder: string | null;
  message: string;
  stack: string | null;
}

export const api = {
  health: () => fetchApi<HealthResponse>('/api/health'),
  groups: () => fetchApi<Group[]>('/api/groups'),
  tasks: () => fetchApi<ScheduledTask[]>('/api/tasks'),
  taskLogs: (id: string) => fetchApi<TaskLog[]>(`/api/tasks/${id}/logs`),
  errors: (limit = 50, offset = 0) =>
    fetchApi<ErrorEntry[]>(`/api/errors?limit=${limit}&offset=${offset}`),
};
```

- [ ] **Step 2: Commit**

```bash
git add mini-app/src/api.ts
git commit -m "feat: add typed API client with Telegram initData auth"
```

---

## Task 9: useHealth composable

**Files:**
- Create: `mini-app/src/composables/useHealth.ts`

- [ ] **Step 1: Create polling composable**

Create `mini-app/src/composables/useHealth.ts`:

```typescript
import { ref, onMounted, onUnmounted } from 'vue';
import { api, type HealthResponse } from '../api';

export function useHealth(intervalMs = 30000) {
  const health = ref<HealthResponse | null>(null);
  const loading = ref(true);
  const error = ref<string | null>(null);
  let timer: ReturnType<typeof setInterval> | null = null;

  async function fetch() {
    try {
      health.value = await api.health();
      error.value = null;
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  onMounted(() => {
    fetch();
    timer = setInterval(fetch, intervalMs);
  });

  onUnmounted(() => {
    if (timer) clearInterval(timer);
  });

  return { health, loading, error, refresh: fetch };
}
```

- [ ] **Step 2: Commit**

```bash
git add mini-app/src/composables/useHealth.ts
git commit -m "feat: add useHealth polling composable"
```

---

## Task 10: Shared components (HealthIndicator + DrillCard)

**Files:**
- Create: `mini-app/src/components/HealthIndicator.vue`
- Create: `mini-app/src/components/DrillCard.vue`

- [ ] **Step 1: Create HealthIndicator component**

Create `mini-app/src/components/HealthIndicator.vue`:

```vue
<script setup lang="ts">
const props = defineProps<{
  status: 'ok' | 'warning' | 'error';
  uptime: number;
  version: string;
  summary: string;
}>();

const statusColors: Record<string, string> = {
  ok: '#4ade80',
  warning: '#fbbf24',
  error: '#f87171',
};

const statusLabels: Record<string, string> = {
  ok: 'OK',
  warning: 'WARNING',
  error: 'ERROR',
};

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}
</script>

<template>
  <div class="health-indicator">
    <div
      class="circle"
      :style="{
        borderColor: statusColors[props.status],
        background: `radial-gradient(circle, ${statusColors[props.status]}20, transparent)`,
      }"
    >
      <span class="label" :style="{ color: statusColors[props.status] }">
        {{ statusLabels[props.status] }}
      </span>
    </div>
    <div class="info">
      Uptime {{ formatUptime(props.uptime) }} · v{{ props.version }}
    </div>
    <div class="summary">{{ props.summary }}</div>
  </div>
</template>

<style scoped>
.health-indicator {
  text-align: center;
  padding: 24px 0;
}

.circle {
  width: 100px;
  height: 100px;
  border-radius: 50%;
  border: 3px solid;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
}

.label {
  font-size: 28px;
  font-weight: 800;
}

.info {
  margin-top: 12px;
  font-size: 13px;
  color: var(--hint-color);
}

.summary {
  margin-top: 4px;
  font-size: 12px;
  color: var(--hint-color);
  opacity: 0.7;
}
</style>
```

- [ ] **Step 2: Create DrillCard component**

Create `mini-app/src/components/DrillCard.vue`:

```vue
<script setup lang="ts">
defineProps<{
  icon: string;
  title: string;
  subtitle: string;
  alert?: boolean;
}>();

const emit = defineEmits<{
  tap: [];
}>();
</script>

<template>
  <div class="drill-card" :class="{ alert }" @click="emit('tap')">
    <div class="card-icon">{{ icon }}</div>
    <div class="card-content">
      <div class="card-title">{{ title }}</div>
      <div class="card-subtitle">{{ subtitle }}</div>
    </div>
    <div class="card-arrow">›</div>
  </div>
</template>

<style scoped>
.drill-card {
  background: var(--secondary-bg);
  border-radius: 12px;
  padding: 14px;
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  transition: opacity 0.15s;
}

.drill-card:active {
  opacity: 0.7;
}

.drill-card.alert {
  border-left: 2px solid #f87171;
}

.card-icon {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  flex-shrink: 0;
}

.card-content {
  flex: 1;
  min-width: 0;
}

.card-title {
  font-weight: 600;
  font-size: 14px;
}

.card-subtitle {
  font-size: 11px;
  color: var(--hint-color);
  margin-top: 2px;
}

.card-arrow {
  font-size: 20px;
  color: var(--hint-color);
  opacity: 0.4;
}
</style>
```

- [ ] **Step 3: Commit**

```bash
git add mini-app/src/components/
git commit -m "feat: add HealthIndicator and DrillCard components"
```

---

## Task 11: HomeView

**Files:**
- Create: `mini-app/src/views/HomeView.vue`

- [ ] **Step 1: Implement HomeView**

Create `mini-app/src/views/HomeView.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useHealth } from '../composables/useHealth';
import HealthIndicator from '../components/HealthIndicator.vue';
import DrillCard from '../components/DrillCard.vue';

const router = useRouter();
const { health, loading, error } = useHealth();

const summary = computed(() => {
  if (!health.value) return '';
  const h = health.value;
  const parts: string[] = [];
  parts.push(`${h.groups_count} groups`);
  parts.push(`${h.tasks_count} tasks`);
  if (h.errors_last_hour > 0) {
    parts.push(`${h.errors_last_hour} error${h.errors_last_hour > 1 ? 's' : ''} in last hour`);
  }
  return parts.join(' · ');
});

const containersSubtitle = computed(() => {
  if (!health.value) return '';
  const h = health.value;
  const parts = [`${h.active_containers} running`];
  if (h.queued_containers > 0) parts.push(`${h.queued_containers} queued`);
  return parts.join(' · ');
});
</script>

<template>
  <div class="home">
    <div v-if="loading" class="loading">Loading...</div>
    <div v-else-if="error" class="error-msg">{{ error }}</div>
    <template v-else-if="health">
      <HealthIndicator
        :status="health.status"
        :uptime="health.uptime"
        :version="health.version"
        :summary="summary"
      />

      <div class="cards">
        <DrillCard
          icon="👥"
          title="Groups"
          :subtitle="`${health.groups_count} registered`"
          @tap="router.push('/groups')"
        />
        <DrillCard
          icon="⏰"
          title="Scheduled Tasks"
          :subtitle="`${health.tasks_count} active`"
          @tap="router.push('/tasks')"
        />
        <DrillCard
          icon="⚠️"
          title="Errors"
          :subtitle="health.errors_last_hour > 0
            ? `${health.errors_last_hour} in last hour`
            : 'No recent errors'"
          :alert="health.errors_last_hour > 0"
          @tap="router.push('/errors')"
        />
        <DrillCard
          icon="📦"
          title="Containers"
          :subtitle="containersSubtitle"
          @tap="() => {}"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 8px;
}

.loading,
.error-msg {
  text-align: center;
  padding: 40px 0;
  color: var(--hint-color);
}

.error-msg {
  color: #f87171;
}
</style>
```

- [ ] **Step 2: Verify build**

```bash
cd mini-app && npm run build
```

Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add mini-app/src/views/HomeView.vue
git commit -m "feat: add HomeView with health indicator and drill-down cards"
```

---

## Task 12: Detail views (Groups, Tasks, Errors)

**Files:**
- Create: `mini-app/src/views/GroupsView.vue`
- Create: `mini-app/src/views/TasksView.vue`
- Create: `mini-app/src/views/ErrorsView.vue`

- [ ] **Step 1: Create GroupsView**

Create `mini-app/src/views/GroupsView.vue`:

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api, type Group } from '../api';

const groups = ref<Group[]>([]);
const loading = ref(true);

onMounted(async () => {
  try {
    groups.value = await api.groups();
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div>
    <h2 class="page-title">Groups</h2>
    <div v-if="loading" class="loading">Loading...</div>
    <div v-else class="list">
      <div v-for="group in groups" :key="group.jid" class="list-item">
        <div class="item-name">{{ group.name || group.folder }}</div>
        <div class="item-meta">
          <span v-if="group.has_active_container" class="badge active">active</span>
          <span v-else class="badge idle">idle</span>
        </div>
      </div>
      <div v-if="groups.length === 0" class="empty">No registered groups</div>
    </div>
  </div>
</template>

<style scoped>
.page-title {
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 16px;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.list-item {
  background: var(--secondary-bg);
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.item-name {
  font-weight: 500;
  font-size: 14px;
}

.badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 8px;
  font-weight: 600;
}

.badge.active {
  background: #4ade8033;
  color: #4ade80;
}

.badge.idle {
  background: rgba(255, 255, 255, 0.1);
  color: var(--hint-color);
}

.loading, .empty {
  text-align: center;
  padding: 24px;
  color: var(--hint-color);
}
</style>
```

- [ ] **Step 2: Create TasksView**

Create `mini-app/src/views/TasksView.vue`:

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api, type ScheduledTask, type TaskLog } from '../api';

const tasks = ref<ScheduledTask[]>([]);
const loading = ref(true);
const expandedTask = ref<string | null>(null);
const taskLogs = ref<Record<string, TaskLog[]>>({});

onMounted(async () => {
  try {
    tasks.value = await api.tasks();
  } finally {
    loading.value = false;
  }
});

async function toggleLogs(taskId: string) {
  if (expandedTask.value === taskId) {
    expandedTask.value = null;
    return;
  }
  expandedTask.value = taskId;
  if (!taskLogs.value[taskId]) {
    taskLogs.value[taskId] = await api.taskLogs(taskId);
  }
}

function formatDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleString();
}
</script>

<template>
  <div>
    <h2 class="page-title">Scheduled Tasks</h2>
    <div v-if="loading" class="loading">Loading...</div>
    <div v-else class="list">
      <div v-for="task in tasks" :key="task.id" class="task-card" @click="toggleLogs(task.id)">
        <div class="task-header">
          <div class="task-prompt">{{ task.prompt.slice(0, 80) }}{{ task.prompt.length > 80 ? '...' : '' }}</div>
          <span class="badge" :class="task.status">{{ task.status }}</span>
        </div>
        <div class="task-meta">
          {{ task.schedule_type }}: {{ task.schedule_value }} · next: {{ formatDate(task.next_run) }}
        </div>

        <div v-if="expandedTask === task.id && taskLogs[task.id]" class="logs">
          <div v-for="log in taskLogs[task.id]" :key="log.run_at" class="log-entry">
            <span class="log-status" :class="log.status">{{ log.status }}</span>
            <span class="log-date">{{ formatDate(log.run_at) }}</span>
            <span class="log-duration">{{ log.duration_ms }}ms</span>
          </div>
          <div v-if="taskLogs[task.id].length === 0" class="empty">No run history</div>
        </div>
      </div>
      <div v-if="tasks.length === 0" class="empty">No scheduled tasks</div>
    </div>
  </div>
</template>

<style scoped>
.page-title {
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 16px;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.task-card {
  background: var(--secondary-bg);
  border-radius: 10px;
  padding: 12px 14px;
  cursor: pointer;
}

.task-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}

.task-prompt {
  font-weight: 500;
  font-size: 13px;
  flex: 1;
}

.task-meta {
  font-size: 11px;
  color: var(--hint-color);
  margin-top: 6px;
}

.badge {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 8px;
  font-weight: 600;
  flex-shrink: 0;
}

.badge.active { background: #4ade8033; color: #4ade80; }
.badge.paused { background: #fbbf2433; color: #fbbf24; }
.badge.completed { background: rgba(255,255,255,0.1); color: var(--hint-color); }

.logs {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(255,255,255,0.05);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.log-entry {
  display: flex;
  gap: 8px;
  font-size: 11px;
  align-items: center;
}

.log-status {
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 600;
  font-size: 10px;
}

.log-status.success { background: #4ade8033; color: #4ade80; }
.log-status.error { background: #f8717133; color: #f87171; }
.log-status.skipped { background: #fbbf2433; color: #fbbf24; }

.log-date { color: var(--hint-color); }
.log-duration { color: var(--hint-color); opacity: 0.6; }

.loading, .empty {
  text-align: center;
  padding: 24px;
  color: var(--hint-color);
}
</style>
```

- [ ] **Step 3: Create ErrorsView**

Create `mini-app/src/views/ErrorsView.vue`:

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api, type ErrorEntry } from '../api';

const errors = ref<ErrorEntry[]>([]);
const loading = ref(true);
const offset = ref(0);
const limit = 30;
const hasMore = ref(true);

async function loadErrors(append = false) {
  loading.value = true;
  try {
    const data = await api.errors(limit, offset.value);
    if (append) {
      errors.value.push(...data);
    } else {
      errors.value = data;
    }
    hasMore.value = data.length === limit;
  } finally {
    loading.value = false;
  }
}

function loadMore() {
  offset.value += limit;
  loadErrors(true);
}

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

onMounted(() => loadErrors());
</script>

<template>
  <div>
    <h2 class="page-title">Errors</h2>
    <div v-if="loading && errors.length === 0" class="loading">Loading...</div>
    <div v-else class="list">
      <div v-for="err in errors" :key="err.id" class="error-item">
        <div class="error-header">
          <span class="error-source" v-if="err.source">{{ err.source }}</span>
          <span class="error-time">{{ timeAgo(err.timestamp) }}</span>
        </div>
        <div class="error-message">{{ err.message }}</div>
        <div v-if="err.group_folder" class="error-group">{{ err.group_folder }}</div>
      </div>
      <div v-if="errors.length === 0" class="empty">No errors in the last 5 days</div>
      <button v-if="hasMore && errors.length > 0" class="load-more" @click="loadMore">
        Load more
      </button>
    </div>
  </div>
</template>

<style scoped>
.page-title {
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 16px;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.error-item {
  background: var(--secondary-bg);
  border-radius: 10px;
  padding: 12px 14px;
  border-left: 2px solid #f87171;
}

.error-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.error-source {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #f87171;
  font-weight: 600;
}

.error-time {
  font-size: 11px;
  color: var(--hint-color);
}

.error-message {
  font-size: 13px;
  line-height: 1.4;
}

.error-group {
  font-size: 11px;
  color: var(--hint-color);
  margin-top: 4px;
}

.load-more {
  background: var(--secondary-bg);
  color: var(--button-color);
  border: none;
  border-radius: 10px;
  padding: 12px;
  font-size: 14px;
  cursor: pointer;
  width: 100%;
  margin-top: 4px;
}

.loading, .empty {
  text-align: center;
  padding: 24px;
  color: var(--hint-color);
}
</style>
```

- [ ] **Step 4: Verify build**

```bash
cd mini-app && npm run build
```

Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add mini-app/src/views/
git commit -m "feat: add GroupsView, TasksView, ErrorsView detail pages"
```

---

## Task 13: Integration test — API endpoints

**Files:**
- Create: `src/api.test.ts`

- [ ] **Step 1: Write integration test**

Create `src/api.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { _initTestDatabase, logError } from './db.js';
import { GroupQueue } from './group-queue.js';

// We test the route logic by importing the handler directly
// For a lightweight approach, start the server on a random port

import { startApiServer } from './api.js';
import type { Server } from 'http';

let server: Server;
let port: number;

beforeAll(async () => {
  _initTestDatabase();
  // Seed test data
  logError({ level: 'error', source: 'container', message: 'Test error' });

  const queue = new GroupQueue();
  // Start server on random port
  server = await startApiServer(0, { queue, version: '1.0.0-test' });
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server?.close();
});

async function fetchApi(path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`);
}

describe('API endpoints', () => {
  it('GET /api/health returns health data', async () => {
    const res = await fetchApi('/api/health');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toMatch(/ok|warning|error/);
    expect(data.version).toBe('1.0.0-test');
    expect(typeof data.uptime).toBe('number');
  });

  it('GET /api/errors returns error list', async () => {
    const res = await fetchApi('/api/errors');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data[0].message).toBe('Test error');
  });

  it('GET /api/tasks returns tasks array', async () => {
    const res = await fetchApi('/api/tasks');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('GET /api/groups returns groups array', async () => {
    const res = await fetchApi('/api/groups');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('GET /unknown returns 404', async () => {
    const res = await fetchApi('/api/unknown');
    expect(res.status).toBe(404);
  });
});
```

Note: The test skips auth validation because `TELEGRAM_BOT_TOKEN` won't be set in test env — the API should pass through when no token is configured.

- [ ] **Step 2: Run test**

Run: `npm test -- --run src/api.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/api.test.ts
git commit -m "test: add API endpoint integration tests"
```

---

## Task 14: Deploy setup + .gitignore

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add mini-app build output and .superpowers to .gitignore**

Add to `.gitignore`:

```
# Mini App build output
mini-app/dist/
mini-app/node_modules/

# Superpowers brainstorm files
.superpowers/
```

- [ ] **Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: add mini-app and .superpowers to gitignore"
```

---

## Task 15: Manual end-to-end verification

- [ ] **Step 1: Build backend**

```bash
npm run build
```

Expected: Compiles without errors

- [ ] **Step 2: Build Mini App**

```bash
cd mini-app && npm run build
```

Expected: `mini-app/dist/` created with index.html and assets

- [ ] **Step 3: Test locally**

Start NanoClaw in dev mode:
```bash
npm run dev
```

Verify API responds:
```bash
curl http://localhost:3847/api/health
```

Expected: JSON with `{ status: "ok", uptime: ..., version: ... }`

- [ ] **Step 4: Test Mini App dev server**

```bash
cd mini-app && npm run dev
```

Open the URL in browser. Verify:
- Health indicator shows
- Drill-down cards are present
- Tapping cards navigates to detail views
- API data loads (via Vite proxy to localhost:3847)

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A && git commit -m "fix: address issues found during manual verification"
```
