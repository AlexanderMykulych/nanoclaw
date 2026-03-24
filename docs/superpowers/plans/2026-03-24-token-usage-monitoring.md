# Token Usage Monitoring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track token consumption per task/group by intercepting Anthropic API responses in the credential proxy, storing usage in SQLite, and displaying in the MiniApp.

**Architecture:** URL-path metadata in `ANTHROPIC_BASE_URL` identifies which task made each request. Credential proxy buffers responses (JSON) or transforms streams (SSE) to extract usage. New `usage-tracker.ts` module handles pricing and DB writes. Frontend adds Usage tab to Tasks and cost section to Metrics.

**Tech Stack:** Node.js + better-sqlite3 (backend), Transform streams (SSE interception), Vue 3 + SVG (frontend), Vitest (tests)

**Spec:** `docs/superpowers/specs/2026-03-24-token-usage-monitoring-design.md`

---

### Task 1: Database schema + DB functions

**Files:**
- Modify: `src/db.ts`
- Test: `src/api.test.ts` (later in Task 3)

- [ ] **Step 1: Add `token_usage` table to `createSchema` in `src/db.ts`**

Add after the existing `task_run_logs` index (around line 66):

```sql
CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  group_folder TEXT,
  task_id TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp);
CREATE INDEX IF NOT EXISTS idx_token_usage_task ON token_usage(task_id, timestamp);
```

- [ ] **Step 2: Add DB functions after the `getTaskTimeline` function**

```typescript
export interface TokenUsageRecord {
  group_folder: string | null;
  task_id: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export function insertTokenUsage(record: TokenUsageRecord): void {
  db.prepare(
    `INSERT INTO token_usage (group_folder, task_id, model, input_tokens, output_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    record.group_folder,
    record.task_id,
    record.model,
    record.input_tokens,
    record.output_tokens,
    record.cost_usd,
  );
}

export interface UsageSummaryRow {
  date: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  request_count: number;
}

export function getTokenUsageSummary(days: number): UsageSummaryRow[] {
  return db
    .prepare(
      `SELECT
        date(timestamp) as date,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        ROUND(SUM(cost_usd), 4) as cost_usd,
        COUNT(*) as request_count
      FROM token_usage
      WHERE timestamp > datetime('now', '-' || ? || ' days')
      GROUP BY date(timestamp)
      ORDER BY date ASC`,
    )
    .all(days) as UsageSummaryRow[];
}

export interface UsageByTaskRow {
  task_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  request_count: number;
}

export function getTokenUsageByTask(days: number): UsageByTaskRow[] {
  return db
    .prepare(
      `SELECT
        COALESCE(task_id, '(messages)') as task_id,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        ROUND(SUM(cost_usd), 4) as cost_usd,
        COUNT(*) as request_count
      FROM token_usage
      WHERE timestamp > datetime('now', '-' || ? || ' days')
      GROUP BY task_id
      ORDER BY cost_usd DESC`,
    )
    .all(days) as UsageByTaskRow[];
}

export function cleanupTokenUsage(days: number): void {
  db.prepare(
    `DELETE FROM token_usage WHERE timestamp < datetime('now', '-' || ? || ' days')`,
  ).run(days);
}
```

- [ ] **Step 3: Add cleanup to metrics-collector**

In `src/metrics-collector.ts`, add import and cleanup call:

Add to imports (line 3):
```typescript
import { insertMetric, cleanupMetrics, cleanupTokenUsage } from './db.js';
```

Add to the daily cleanup `setInterval` (line 100):
```typescript
  setInterval(() => {
    cleanupMetrics(RETENTION_DAYS);
    cleanupTokenUsage(30);
  }, 24 * 60 * 60 * 1000);
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --run src/api.test.ts`
Expected: ALL PASS (schema change is backward-compatible)

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/metrics-collector.ts
git commit -m "feat: add token_usage DB schema, queries, and retention cleanup"
```

---

### Task 2: Usage tracker module + credential proxy interception

**Files:**
- Create: `src/usage-tracker.ts`
- Modify: `src/credential-proxy.ts`

- [ ] **Step 1: Create `src/usage-tracker.ts`**

```typescript
import { insertTokenUsage } from './db.js';
import { logger } from './logger.js';

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
  'claude-haiku-3-5-20241022': { input: 0.8, output: 4 },
};

const DEFAULT_PRICING = { input: 3, output: 15 }; // Sonnet fallback

function getPricing(model: string): { input: number; output: number } {
  // Try exact match first, then prefix match for versioned models
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key.split('-').slice(0, -1).join('-'))) return pricing;
  }
  return DEFAULT_PRICING;
}

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = getPricing(model);
  return (
    (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
  );
}

export interface RequestMeta {
  group: string | null;
  taskId: string | null;
}

/**
 * Parse /meta/GROUP/TASK_ID prefix from request URL.
 * Returns the metadata and the cleaned path (prefix stripped).
 */
export function parseMetaPrefix(url: string): {
  meta: RequestMeta;
  cleanPath: string;
} {
  const match = url.match(/^\/meta\/([^/]+)\/([^/]+)(\/.*)/);
  if (match) {
    return {
      meta: {
        group: match[1],
        taskId: match[2] === '_msg' ? null : match[2],
      },
      cleanPath: match[3],
    };
  }
  return { meta: { group: null, taskId: null }, cleanPath: url };
}

/**
 * Extract usage from a non-streaming JSON response body.
 */
export function extractUsageFromJson(body: string): {
  model: string;
  inputTokens: number;
  outputTokens: number;
} | null {
  try {
    const data = JSON.parse(body);
    if (!data.usage) return null;
    return {
      model: data.model || 'unknown',
      inputTokens: data.usage.input_tokens || 0,
      outputTokens: data.usage.output_tokens || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Parse SSE lines and accumulate usage from message_start and message_delta events.
 * Call with each chunk of SSE data. Returns accumulated usage when stream ends.
 */
export class SseUsageAccumulator {
  private buffer = '';
  private inputTokens = 0;
  private outputTokens = 0;
  private model = 'unknown';

  processChunk(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6).trim();
      if (jsonStr === '[DONE]') continue;
      try {
        const data = JSON.parse(jsonStr);
        if (data.type === 'message_start' && data.message?.usage) {
          this.inputTokens = data.message.usage.input_tokens || 0;
          this.model = data.message.model || this.model;
        }
        if (data.type === 'message_delta' && data.usage) {
          this.outputTokens = data.usage.output_tokens || 0;
        }
      } catch {
        // Skip unparseable lines
      }
    }
  }

  getResult(): {
    model: string;
    inputTokens: number;
    outputTokens: number;
  } | null {
    if (this.inputTokens === 0 && this.outputTokens === 0) return null;
    return {
      model: this.model,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    };
  }
}

/**
 * Log usage to the database. Non-blocking — errors are logged but don't propagate.
 */
export function logUsage(
  meta: RequestMeta,
  model: string,
  inputTokens: number,
  outputTokens: number,
): void {
  try {
    const cost = calculateCost(model, inputTokens, outputTokens);
    insertTokenUsage({
      group_folder: meta.group,
      task_id: meta.taskId,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: cost,
    });
    logger.debug(
      { model, inputTokens, outputTokens, cost, ...meta },
      'Token usage logged',
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to log token usage');
  }
}
```

- [ ] **Step 2: Modify `src/credential-proxy.ts` to intercept responses**

Replace the entire file with the updated version that:
1. Parses `/meta/` prefix from `req.url`, strips it before forwarding
2. For JSON responses (status 200, content-type application/json): buffers body, extracts usage, logs it
3. For SSE responses (text/event-stream): pipes through transform, accumulates usage
4. For everything else: pipes through unchanged

The key change is in the upstream response handler (currently lines 90-93):

```typescript
// OLD:
(upRes) => {
  res.writeHead(upRes.statusCode!, upRes.headers);
  upRes.pipe(res);
},

// NEW:
(upRes) => {
  const contentType = (upRes.headers['content-type'] || '') as string;
  const isMessages = cleanPath.includes('/v1/messages');
  const isJson = contentType.includes('application/json');
  const isSse = contentType.includes('text/event-stream');

  res.writeHead(upRes.statusCode!, upRes.headers);

  if (isMessages && upRes.statusCode === 200 && isJson) {
    // Buffer JSON response, extract usage, then forward
    const resChunks: Buffer[] = [];
    upRes.on('data', (c: Buffer) => resChunks.push(c));
    upRes.on('end', () => {
      const resBody = Buffer.concat(resChunks);
      res.end(resBody);
      const usage = extractUsageFromJson(resBody.toString());
      if (usage) {
        logUsage(meta, usage.model, usage.inputTokens, usage.outputTokens);
      }
    });
  } else if (isMessages && upRes.statusCode === 200 && isSse) {
    // Stream SSE through, accumulate usage
    const acc = new SseUsageAccumulator();
    upRes.on('data', (chunk: Buffer) => {
      res.write(chunk);
      acc.processChunk(chunk.toString());
    });
    upRes.on('end', () => {
      res.end();
      const usage = acc.getResult();
      if (usage) {
        logUsage(meta, usage.model, usage.inputTokens, usage.outputTokens);
      }
    });
  } else {
    // Pass through unchanged
    upRes.pipe(res);
  }
},
```

Also add at the top of the request handler, after `const body = Buffer.concat(chunks)`:

```typescript
const { meta, cleanPath } = parseMetaPrefix(req.url || '/');
```

And change `path: req.url` to `path: cleanPath` in the upstream request options.

Import the new module at the top:
```typescript
import {
  parseMetaPrefix,
  extractUsageFromJson,
  SseUsageAccumulator,
  logUsage,
} from './usage-tracker.js';
```

Also extract model from request body for more reliable attribution:
```typescript
// After const body = Buffer.concat(chunks):
let requestModel = 'unknown';
try {
  const reqData = JSON.parse(body.toString());
  if (reqData.model) requestModel = reqData.model;
} catch {}
```

Then use `requestModel` as fallback when logging: `usage.model || requestModel`.

- [ ] **Step 3: Run tests**

Run: `npm test -- --run`
Expected: ALL PASS (proxy changes don't break existing tests since test API doesn't go through proxy)

- [ ] **Step 4: Commit**

```bash
git add src/usage-tracker.ts src/credential-proxy.ts
git commit -m "feat: add usage tracking with response interception in credential proxy"
```

---

### Task 3: API endpoints + tests

**Files:**
- Modify: `src/api.ts`
- Modify: `src/api.test.ts`

- [ ] **Step 1: Add API endpoints to `src/api.ts`**

Add imports (extend existing import from db.js):
```typescript
import {
  // ... existing imports ...
  getTokenUsageSummary,
  getTokenUsageByTask,
  insertTokenUsage,
} from './db.js';
```

Add route handlers **before** the existing `path === '/api/tasks'` check. Insert after the `/api/errors` handler block:

```typescript
        } else if (path === '/api/token-usage/summary') {
          const days = Math.max(1, Math.min(30, parseInt(params.get('days') || '7', 10) || 7));
          sendJson(res, 200, getTokenUsageSummary(days));
        } else if (path === '/api/token-usage/by-task') {
          const days = Math.max(1, Math.min(30, parseInt(params.get('days') || '7', 10) || 7));
          sendJson(res, 200, getTokenUsageByTask(days));
```

- [ ] **Step 2: Add tests to `src/api.test.ts`**

Add `insertTokenUsage` to the import:
```typescript
import { _initTestDatabase, logError, logTaskRun, createTask, insertTokenUsage } from './db.js';
```

Add seed data in `beforeAll` after the existing task run log seeds:
```typescript
  // Seed token usage for usage API tests
  insertTokenUsage({ group_folder: 'telegram_main', task_id: 'obs-test-task', model: 'claude-sonnet-4-20250514', input_tokens: 1000, output_tokens: 500, cost_usd: 0.0105 });
  insertTokenUsage({ group_folder: 'telegram_main', task_id: 'obs-test-task', model: 'claude-sonnet-4-20250514', input_tokens: 2000, output_tokens: 1000, cost_usd: 0.021 });
  insertTokenUsage({ group_folder: 'telegram_main', task_id: null, model: 'claude-sonnet-4-20250514', input_tokens: 500, output_tokens: 200, cost_usd: 0.0045 });
```

Add test cases:
```typescript
  it('GET /api/token-usage/summary returns daily aggregation', async () => {
    const res = await fetchApi('/api/token-usage/summary');
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1); // all in same day
    expect(data[0].input_tokens).toBe(3500);
    expect(data[0].output_tokens).toBe(1700);
    expect(data[0].request_count).toBe(3);
  });

  it('GET /api/token-usage/by-task returns per-task breakdown', async () => {
    const res = await fetchApi('/api/token-usage/by-task');
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(data)).toBe(true);
    const task = data.find((t) => t.task_id === 'obs-test-task');
    expect(task).toBeDefined();
    expect(task!.input_tokens).toBe(3000);
    expect(task!.request_count).toBe(2);
    const msgs = data.find((t) => t.task_id === '(messages)');
    expect(msgs).toBeDefined();
    expect(msgs!.input_tokens).toBe(500);
  });
```

- [ ] **Step 3: Run tests**

Run: `npm test -- --run src/api.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/api.ts src/api.test.ts
git commit -m "feat: add token usage API endpoints with tests"
```

---

### Task 4: URL-path metadata in container-runner

**Files:**
- Modify: `src/container-runner.ts`
- Modify: `src/types.ts` (if `ContainerInput` is there — it's in container-runner.ts)

- [ ] **Step 1: Add `taskId` to `ContainerInput` interface**

In `src/container-runner.ts`, add `taskId` field to `ContainerInput` (line 37-46):

```typescript
export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  model?: string;
  taskId?: string;  // scheduled task ID for usage attribution
}
```

- [ ] **Step 2: Modify `buildContainerArgs` to accept and use metadata**

Change the function signature to accept optional group and taskId:

```typescript
function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  meta?: { group: string; taskId?: string },
): string[] {
```

Change the `ANTHROPIC_BASE_URL` line (currently line 247-249) to include metadata prefix:

```typescript
  // Route API traffic through the credential proxy with metadata for usage tracking
  const metaPath = meta
    ? `/meta/${encodeURIComponent(meta.group)}/${encodeURIComponent(meta.taskId || '_msg')}`
    : '';
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}${metaPath}`,
  );
```

- [ ] **Step 3: Update `runContainerAgent` to pass metadata**

In `runContainerAgent` (line 325), pass the metadata to `buildContainerArgs`:

```typescript
  const containerArgs = buildContainerArgs(mounts, containerName, {
    group: group.folder,
    taskId: input.taskId,
  });
```

- [ ] **Step 4: Update task-scheduler to pass taskId**

In `src/task-scheduler.ts` line 273-284, add `taskId` to the ContainerInput:

```typescript
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        model: task.model,
        taskId: task.id,  // NEW: for usage attribution
      },
```

- [ ] **Step 5: Run tests**

Run: `npm test -- --run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/container-runner.ts src/task-scheduler.ts
git commit -m "feat: pass task metadata in ANTHROPIC_BASE_URL for usage attribution"
```

---

### Task 5: Deploy backend to server

- [ ] **Step 1: Push and deploy**

```bash
git push
ssh root@159.69.207.195 "cd /workspace/project && git pull && npm run build && systemctl restart nanoclaw"
```

- [ ] **Step 2: Verify API endpoints work**

```bash
ssh root@159.69.207.195 "sleep 5 && curl -s 'http://127.0.0.1:3847/api/token-usage/summary' 2>&1 | head -c 50"
```

Expected: Returns 401 (auth required) — this means the endpoint exists and routing works.

- [ ] **Step 3: Verify proxy logs usage after a task runs**

Wait ~2 minutes for a scheduled task to run, then:
```bash
ssh root@159.69.207.195 "sqlite3 /workspace/project/store/messages.db 'SELECT COUNT(*) FROM token_usage;'"
```

Expected: > 0 (usage rows appear as tasks execute)

---

### Task 6: Update MiniApp frontend — API client + TasksView Usage tab + MetricsView

**Files (on server):**
- Modify: `/workspace/extra/Memory_Obsidian/mini-app/src/api.ts`
- Modify: `/workspace/extra/Memory_Obsidian/mini-app/src/views/TasksView.vue`
- Modify: `/workspace/extra/Memory_Obsidian/mini-app/src/views/MetricsView.vue`

- [ ] **Step 1: Add interfaces and methods to `api.ts`**

Add interfaces after `TimelinePoint`:
```typescript
export interface UsageSummary {
  date: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  request_count: number;
}

export interface UsageByTask {
  task_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  request_count: number;
}
```

Add methods to `api` object:
```typescript
  tokenUsageSummary: (days = 7) => fetchApi<UsageSummary[]>(`/api/token-usage/summary?days=${days}`),
  tokenUsageByTask: (days = 7) => fetchApi<UsageByTask[]>(`/api/token-usage/by-task?days=${days}`),
```

- [ ] **Step 2: Add "Usage" tab to TasksView.vue**

Add third tab button, Usage tab content with horizontal bar chart, and per-task cost on Stats cards. Key additions:
- Third tab: `<button :class="{ active: activeTab === 'usage' }" @click="switchTab('usage')">Usage</button>`
- Usage tab data: fetch `api.tokenUsageByTask()` on tab switch
- Horizontal bar chart: SVG bars, width proportional to cost, sorted descending
- Per-task cost on Stats cards: match stats with usage data by task_id, show `~$X.XX (NK in / NK out)`

- [ ] **Step 3: Add token usage section to MetricsView.vue**

Add a "Token Usage" section at the top of MetricsView with:
- Line chart of cost per day (SVG, same viewBox pattern)
- Summary: total cost, total input/output tokens
- Fetch `api.tokenUsageSummary()` on mount

- [ ] **Step 4: Build and deploy**

```bash
ssh root@159.69.207.195 "cd /workspace/extra/Memory_Obsidian/mini-app && npm run build 2>&1 | grep -E 'built|fail' && rm -rf /var/www/mini-app/* && cp -r dist/* /var/www/mini-app/ && echo 'Deployed'"
```

Expected: Build succeeds, deployed.

- [ ] **Step 5: Verify in Telegram**

Open MiniApp:
- Tasks → "Usage" tab → horizontal bar chart comparing tasks by cost
- Tasks → "Stats" tab → each card shows `~$X.XX (NK in / NK out)`
- Metrics → "Token Usage" section at top with cost trend chart
