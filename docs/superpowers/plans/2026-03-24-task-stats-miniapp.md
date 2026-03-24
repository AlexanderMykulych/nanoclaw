# Task Stats MiniApp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add aggregated task execution statistics with timeline charts to the Telegram MiniApp's Scheduled Tasks page.

**Architecture:** Two new backend endpoints (`/api/tasks/stats`, `/api/tasks/:id/timeline`) backed by SQL aggregation queries, plus a revamped Vue component with tabs (Stats/List) and inline SVG timeline charts.

**Tech Stack:** Node.js + better-sqlite3 (backend), Vue 3 + TypeScript + inline SVG (frontend), Vitest (tests)

**Spec:** `docs/superpowers/specs/2026-03-24-task-stats-miniapp-design.md`

---

### Task 1: Add `getTaskStats` and `getTaskTimeline` DB functions

**Files:**
- Modify: `src/db.ts` (after `getTaskRunLogs` at line 809)
- Test: `src/api.test.ts`

- [ ] **Step 1: Write failing tests for the new endpoints**

Add to `src/api.test.ts` inside the existing `describe('API endpoints', ...)` block, before the closing `});`:

```typescript
  it('GET /api/tasks/stats returns aggregated stats array', async () => {
    const res = await fetchApi('/api/tasks/stats');
    expect(res.status).toBe(200);
    const data = (await res.json()) as unknown[];
    expect(Array.isArray(data)).toBe(true);
  });

  it('GET /api/tasks/stats respects days param', async () => {
    const res = await fetchApi('/api/tasks/stats?days=1');
    expect(res.status).toBe(200);
    const data = (await res.json()) as unknown[];
    expect(Array.isArray(data)).toBe(true);
  });

  it('GET /api/tasks/test-task/timeline returns timeline array', async () => {
    const res = await fetchApi('/api/tasks/test-task/timeline');
    expect(res.status).toBe(200);
    const data = (await res.json()) as unknown[];
    expect(Array.isArray(data)).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run`
Expected: FAIL — `getTaskStats` and `getTaskTimeline` not found, endpoints return 404.

- [ ] **Step 3: Add DB functions to `src/db.ts`**

Add after the `getTaskRunLogs` function (after line 809):

```typescript
export interface TaskStatsRow {
  task_id: string;
  total_runs: number;
  success_count: number;
  error_count: number;
  skipped_count: number;
  avg_duration_ms: number;
  max_duration_ms: number;
  min_duration_ms: number;
  last_run: string | null;
  success_rate: number;
}

export function getTaskStats(days: number): TaskStatsRow[] {
  return db
    .prepare(
      `SELECT
        task_id,
        COUNT(*) as total_runs,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped_count,
        COALESCE(ROUND(AVG(CASE WHEN status != 'skipped' THEN duration_ms END)), 0) as avg_duration_ms,
        COALESCE(MAX(CASE WHEN status != 'skipped' THEN duration_ms END), 0) as max_duration_ms,
        COALESCE(MIN(CASE WHEN status != 'skipped' THEN duration_ms END), 0) as min_duration_ms,
        MAX(run_at) as last_run,
        COALESCE(ROUND(100.0 * SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) /
          NULLIF(SUM(CASE WHEN status != 'skipped' THEN 1 ELSE 0 END), 0), 1), 100.0) as success_rate
      FROM task_run_logs
      WHERE run_at > datetime('now', '-' || ? || ' days')
      GROUP BY task_id
      ORDER BY success_rate ASC, total_runs DESC`,
    )
    .all(days) as TaskStatsRow[];
}

export interface TimelinePoint {
  run_at: string;
  duration_ms: number;
  status: string;
}

export function getTaskTimeline(
  taskId: string,
  days: number,
): TimelinePoint[] {
  return db
    .prepare(
      `SELECT
        strftime('%Y-%m-%dT%H:00', run_at) as run_at,
        ROUND(AVG(duration_ms)) as duration_ms,
        CASE WHEN SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) > 0 THEN 'error' ELSE 'success' END as status
      FROM task_run_logs
      WHERE task_id = ? AND status != 'skipped'
        AND run_at > datetime('now', '-' || ? || ' days')
      GROUP BY strftime('%Y-%m-%dT%H:00', run_at)
      ORDER BY run_at ASC`,
    )
    .all(taskId, days) as TimelinePoint[];
}
```

- [ ] **Step 4: Add endpoints to `src/api.ts`**

Add `getTaskStats` and `getTaskTimeline` to the import (line 4-11):

```typescript
import {
  getRegisteredGroupsList,
  getScheduledTasks,
  getTaskRunLogs,
  getTaskStats,
  getTaskTimeline,
  getErrors,
  getErrorCountSince,
  getMetrics,
} from './db.js';
```

Add two new route handlers **immediately after** `path === '/api/tasks'` (line 111) and **before** the existing `/api/tasks/:id/logs` regex (line 112):

```typescript
        } else if (path === '/api/tasks') {
          sendJson(res, 200, getScheduledTasks());
        } else if (path === '/api/tasks/stats') {
          const days = Math.max(1, Math.min(30, parseInt(params.get('days') || '7', 10) || 7));
          sendJson(res, 200, getTaskStats(days));
        } else if (path.match(/^\/api\/tasks\/[^/]+\/timeline$/)) {
          const taskId = path.split('/')[3];
          const days = Math.max(1, Math.min(30, parseInt(params.get('days') || '7', 10) || 7));
          sendJson(res, 200, getTaskTimeline(taskId, days));
        } else if (path.match(/^\/api\/tasks\/[^/]+\/logs$/)) {
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- --run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/api.ts src/api.test.ts
git commit -m "feat: add task stats and timeline API endpoints"
```

---

### Task 2: Add detailed DB tests with seeded data

**Files:**
- Modify: `src/api.test.ts`

- [ ] **Step 1: Add seeded data and detailed assertions**

Add a `logTaskRun` import at line 2 of `src/api.test.ts`:

```typescript
import { _initTestDatabase, logError, logTaskRun } from './db.js';
```

Add seed data in `beforeAll`, after the `logError` line (line 19):

```typescript
  // Seed task run logs for stats tests
  logTaskRun({ task_id: 'obs-test-task', run_at: new Date().toISOString(), duration_ms: 5000, status: 'success', result: 'ok', error: null });
  logTaskRun({ task_id: 'obs-test-task', run_at: new Date().toISOString(), duration_ms: 10000, status: 'success', result: 'ok', error: null });
  logTaskRun({ task_id: 'obs-test-task', run_at: new Date().toISOString(), duration_ms: 8000, status: 'error', result: null, error: 'timeout' });
  logTaskRun({ task_id: 'obs-test-task', run_at: new Date().toISOString(), duration_ms: 0, status: 'skipped', result: null, error: null });
```

Replace the simple stats/timeline tests from Task 1 with detailed ones:

```typescript
  it('GET /api/tasks/stats returns correct aggregated data', async () => {
    const res = await fetchApi('/api/tasks/stats');
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(data)).toBe(true);
    const task = data.find((t) => t.task_id === 'obs-test-task');
    expect(task).toBeDefined();
    expect(task!.total_runs).toBe(4);
    expect(task!.success_count).toBe(2);
    expect(task!.error_count).toBe(1);
    expect(task!.skipped_count).toBe(1);
    // avg of 5000, 10000, 8000 (excludes skipped) = 7667
    expect(task!.avg_duration_ms).toBeCloseTo(7667, -2);
    expect(task!.max_duration_ms).toBe(10000);
    expect(task!.min_duration_ms).toBe(5000);
    // success_rate = 2/3 * 100 = 66.7
    expect(task!.success_rate).toBeCloseTo(66.7, 0);
  });

  it('GET /api/tasks/stats clamps days param', async () => {
    const res = await fetchApi('/api/tasks/stats?days=999');
    expect(res.status).toBe(200);
    // Should clamp to 30, still return data
    const data = (await res.json()) as unknown[];
    expect(Array.isArray(data)).toBe(true);
  });

  it('GET /api/tasks/obs-test-task/timeline returns hourly buckets', async () => {
    const res = await fetchApi('/api/tasks/obs-test-task/timeline');
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(data)).toBe(true);
    // 3 non-skipped runs in the same hour → 1 bucket
    expect(data.length).toBe(1);
    expect(data[0].status).toBe('error'); // has at least one error
    expect(typeof data[0].duration_ms).toBe('number');
  });
```

- [ ] **Step 2: Run tests**

Run: `npm test -- --run`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/api.test.ts
git commit -m "test: add detailed task stats and timeline endpoint tests"
```

---

### Task 3: Update MiniApp API client

**Files:**
- Modify: `mini-app/src/api.ts` (on server at `/workspace/extra/Memory_Obsidian/mini-app/src/api.ts`)

- [ ] **Step 1: Add interfaces and API methods**

SSH to server and add `TaskStats` and `TimelinePoint` interfaces after the existing `TaskLog` interface, and add two new methods to the `api` object:

Interfaces to add after `TaskLog`:
```typescript
export interface TaskStats {
  task_id: string;
  total_runs: number;
  success_count: number;
  error_count: number;
  skipped_count: number;
  avg_duration_ms: number;
  max_duration_ms: number;
  min_duration_ms: number;
  last_run: string | null;
  success_rate: number;
}

export interface TimelinePoint {
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
}
```

Methods to add in the `api` object after `taskLogs`:
```typescript
  taskStats: (days = 7) => fetchApi<TaskStats[]>(`/api/tasks/stats?days=${days}`),
  taskTimeline: (id: string, days = 7) =>
    fetchApi<TimelinePoint[]>(`/api/tasks/${id}/timeline?days=${days}`),
```

- [ ] **Step 2: Commit**

No local commit — this file lives in the Obsidian vault on the server.

---

### Task 4: Rewrite TasksView.vue with Stats/List tabs

**Files:**
- Modify: `mini-app/src/views/TasksView.vue` (on server at `/workspace/extra/Memory_Obsidian/mini-app/src/views/TasksView.vue`)

- [ ] **Step 1: Rewrite TasksView.vue**

Replace the entire file with a tabbed component. The component should:

1. Two tabs: "Stats" (default active) and "List"
2. **Stats tab:**
   - On mount, fetch `api.taskStats()` and `api.tasks()`, join by `task_id`
   - Render cards sorted by success rate (worst first — already sorted by backend)
   - Each card: formatted name, success rate badge (color-coded), avg duration in seconds, runs breakdown, last run
   - Tap → expand with lazy-loaded SVG timeline chart from `api.taskTimeline(id)`
3. **List tab:**
   - Original TasksView functionality (tasks list with expandable run history)
4. **Timeline SVG chart:**
   - `viewBox` based, responsive width, 120px height
   - Map data points to coordinates: X = time proportion, Y = duration proportion
   - Line path connecting points, circles at each point
   - Green = success, red = error
   - Edge cases: 0 points → "No data", 1 point → single dot

Full component code to write (SSH to server):

```vue
<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { api, type ScheduledTask, type TaskLog, type TaskStats, type TimelinePoint } from '../api';

const activeTab = ref<'stats' | 'list'>('stats');

// Stats tab state
const stats = ref<TaskStats[]>([]);
const tasks = ref<ScheduledTask[]>([]);
const statsLoading = ref(true);
const expandedStat = ref<string | null>(null);
const timelines = ref<Record<string, TimelinePoint[]>>({});

// List tab state
const listLoading = ref(false);
const expandedTask = ref<string | null>(null);
const taskLogs = ref<Record<string, TaskLog[]>>({});

onMounted(async () => {
  try {
    const [s, t] = await Promise.all([api.taskStats(), api.tasks()]);
    stats.value = s;
    tasks.value = t;
  } finally {
    statsLoading.value = false;
  }
});

async function loadList() {
  if (tasks.value.length > 0) return;
  listLoading.value = true;
  try {
    tasks.value = await api.tasks();
  } finally {
    listLoading.value = false;
  }
}

function switchTab(tab: 'stats' | 'list') {
  activeTab.value = tab;
  if (tab === 'list') loadList();
}

async function toggleStatExpand(taskId: string) {
  if (expandedStat.value === taskId) {
    expandedStat.value = null;
    return;
  }
  expandedStat.value = taskId;
  if (!timelines.value[taskId]) {
    timelines.value[taskId] = await api.taskTimeline(taskId);
  }
}

async function toggleTaskExpand(taskId: string) {
  if (expandedTask.value === taskId) {
    expandedTask.value = null;
    return;
  }
  expandedTask.value = taskId;
  if (!taskLogs.value[taskId]) {
    taskLogs.value[taskId] = await api.taskLogs(taskId);
  }
}

function formatId(id: string): string {
  return id.replace(/^obs-/, '').replace(/-/g, ' ');
}

function formatDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function rateClass(rate: number): string {
  if (rate >= 90) return 'rate-good';
  if (rate >= 70) return 'rate-warn';
  return 'rate-bad';
}

function buildSvgPath(points: TimelinePoint[]): { path: string; circles: Array<{ cx: number; cy: number; color: string }> } {
  if (points.length === 0) return { path: '', circles: [] };

  const W = 300;
  const H = 100;
  const PAD = 4;

  const durations = points.map(p => p.duration_ms);
  const minD = Math.min(...durations);
  const maxD = Math.max(...durations);
  const rangeD = maxD - minD || 1;

  const circles: Array<{ cx: number; cy: number; color: string }> = [];
  const pathParts: string[] = [];

  points.forEach((p, i) => {
    const x = points.length === 1 ? W / 2 : PAD + (i / (points.length - 1)) * (W - PAD * 2);
    const y = PAD + (1 - (p.duration_ms - minD) / rangeD) * (H - PAD * 2);
    circles.push({ cx: x, cy: y, color: p.status === 'error' ? '#f87171' : '#4ade80' });
    pathParts.push(i === 0 ? `M${x},${y}` : `L${x},${y}`);
  });

  return { path: pathParts.join(' '), circles };
}
</script>

<template>
  <div>
    <h2 class="page-title">Scheduled Tasks</h2>

    <div class="tabs">
      <button :class="{ active: activeTab === 'stats' }" @click="switchTab('stats')">Stats</button>
      <button :class="{ active: activeTab === 'list' }" @click="switchTab('list')">List</button>
    </div>

    <!-- Stats Tab -->
    <div v-if="activeTab === 'stats'">
      <div v-if="statsLoading" class="loading">Loading...</div>
      <div v-else class="list">
        <div v-for="stat in stats" :key="stat.task_id" class="stat-card" @click="toggleStatExpand(stat.task_id)">
          <div class="stat-header">
            <div class="stat-name">{{ formatId(stat.task_id) }}</div>
            <span class="rate-badge" :class="rateClass(stat.success_rate)">{{ stat.success_rate }}%</span>
          </div>
          <div class="stat-meta">
            avg {{ formatDuration(stat.avg_duration_ms) }} · {{ stat.total_runs }} runs
            <span class="stat-breakdown">
              ({{ stat.success_count }}✓ {{ stat.error_count }}✗ {{ stat.skipped_count }}⊘)
            </span>
          </div>
          <div class="stat-meta">last: {{ formatDate(stat.last_run) }}</div>

          <div v-if="expandedStat === stat.task_id" class="timeline-section">
            <div v-if="!timelines[stat.task_id]" class="loading-small">Loading chart...</div>
            <div v-else-if="timelines[stat.task_id].length === 0" class="empty-chart">No data</div>
            <svg v-else class="timeline-chart" :viewBox="`0 0 300 100`" preserveAspectRatio="none">
              <path
                :d="buildSvgPath(timelines[stat.task_id]).path"
                fill="none"
                stroke="var(--hint-color)"
                stroke-width="1.5"
                stroke-opacity="0.4"
              />
              <circle
                v-for="(c, ci) in buildSvgPath(timelines[stat.task_id]).circles"
                :key="ci"
                :cx="c.cx"
                :cy="c.cy"
                r="2.5"
                :fill="c.color"
              />
            </svg>
            <div v-if="timelines[stat.task_id]?.length" class="chart-labels">
              <span>min {{ formatDuration(stat.min_duration_ms) }}</span>
              <span>max {{ formatDuration(stat.max_duration_ms) }}</span>
            </div>
          </div>
        </div>
        <div v-if="stats.length === 0" class="empty">No task runs in the last 7 days</div>
      </div>
    </div>

    <!-- List Tab -->
    <div v-if="activeTab === 'list'">
      <div v-if="listLoading" class="loading">Loading...</div>
      <div v-else class="list">
        <div v-for="task in tasks" :key="task.id" class="task-card" @click="toggleTaskExpand(task.id)">
          <div class="task-header">
            <div class="task-name">{{ formatId(task.id) }}</div>
            <span class="badge" :class="task.status">{{ task.status }}</span>
          </div>
          <div class="task-meta">
            {{ task.schedule_type }}: {{ task.schedule_value }} · next: {{ formatDate(task.next_run) }}
          </div>
          <div v-if="expandedTask === task.id" class="expanded">
            <div class="prompt-section">
              <div class="section-label">Prompt</div>
              <div class="prompt-text">{{ task.prompt }}</div>
            </div>
            <div class="logs-section">
              <div class="section-label">Run history</div>
              <div v-if="taskLogs[task.id]" class="logs">
                <div v-for="log in taskLogs[task.id]" :key="log.run_at" class="log-entry">
                  <span class="log-status" :class="log.status">{{ log.status }}</span>
                  <span class="log-date">{{ formatDate(log.run_at) }}</span>
                  <span class="log-duration">{{ log.duration_ms }}ms</span>
                </div>
                <div v-if="taskLogs[task.id].length === 0" class="empty-logs">No run history</div>
              </div>
              <div v-else class="empty-logs">Loading...</div>
            </div>
          </div>
        </div>
        <div v-if="tasks.length === 0" class="empty">No scheduled tasks</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-title { font-size: 20px; font-weight: 700; margin-bottom: 12px; }

.tabs { display: flex; gap: 0; margin-bottom: 14px; background: var(--secondary-bg); border-radius: 10px; padding: 3px; }
.tabs button { flex: 1; padding: 8px 0; border: none; background: transparent; color: var(--hint-color); font-size: 13px; font-weight: 600; border-radius: 8px; cursor: pointer; transition: all 0.15s; }
.tabs button.active { background: var(--button-color); color: #fff; }

.list { display: flex; flex-direction: column; gap: 8px; }

.stat-card { background: var(--secondary-bg); border-radius: 10px; padding: 12px 14px; cursor: pointer; transition: opacity 0.15s; }
.stat-card:active { opacity: 0.7; }
.stat-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.stat-name { font-weight: 600; font-size: 14px; text-transform: capitalize; }
.stat-meta { font-size: 11px; color: var(--hint-color); margin-top: 3px; }
.stat-breakdown { opacity: 0.7; }

.rate-badge { font-size: 11px; padding: 2px 8px; border-radius: 8px; font-weight: 700; flex-shrink: 0; }
.rate-good { background: #4ade8033; color: #4ade80; }
.rate-warn { background: #fbbf2433; color: #fbbf24; }
.rate-bad { background: #f8717133; color: #f87171; }

.timeline-section { margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.06); }
.timeline-chart { width: 100%; height: 120px; }
.chart-labels { display: flex; justify-content: space-between; font-size: 10px; color: var(--hint-color); margin-top: 4px; }
.empty-chart { font-size: 11px; color: var(--hint-color); text-align: center; padding: 20px 0; }
.loading-small { font-size: 11px; color: var(--hint-color); text-align: center; padding: 10px 0; }

.task-card { background: var(--secondary-bg); border-radius: 10px; padding: 12px 14px; cursor: pointer; transition: opacity 0.15s; }
.task-card:active { opacity: 0.7; }
.task-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.task-name { font-weight: 600; font-size: 14px; text-transform: capitalize; }
.task-meta { font-size: 11px; color: var(--hint-color); margin-top: 4px; }
.badge { font-size: 10px; padding: 2px 8px; border-radius: 8px; font-weight: 600; flex-shrink: 0; }
.badge.active { background: #4ade8033; color: #4ade80; }
.badge.paused { background: #fbbf2433; color: #fbbf24; }
.badge.completed { background: rgba(255,255,255,0.1); color: var(--hint-color); }

.expanded { margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.06); }
.section-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--hint-color); font-weight: 600; margin-bottom: 6px; }
.prompt-section { margin-bottom: 12px; }
.prompt-text { font-size: 12px; line-height: 1.5; color: var(--text-color); opacity: 0.8; white-space: pre-wrap; background: rgba(0,0,0,0.2); padding: 8px 10px; border-radius: 6px; max-height: 200px; overflow-y: auto; }
.logs { display: flex; flex-direction: column; gap: 6px; }
.log-entry { display: flex; gap: 8px; font-size: 11px; align-items: center; }
.log-status { padding: 1px 6px; border-radius: 4px; font-weight: 600; font-size: 10px; }
.log-status.success { background: #4ade8033; color: #4ade80; }
.log-status.error { background: #f8717133; color: #f87171; }
.log-status.skipped { background: #fbbf2433; color: #fbbf24; }
.log-date { color: var(--hint-color); }
.log-duration { color: var(--hint-color); opacity: 0.6; }
.empty-logs { font-size: 11px; color: var(--hint-color); }
.loading, .empty { text-align: center; padding: 24px; color: var(--hint-color); }
</style>
```

- [ ] **Step 2: Verify no build errors**

```bash
ssh root@159.69.207.195 "cd /workspace/extra/Memory_Obsidian/mini-app && npm run build 2>&1 | tail -5"
```

Expected: Build succeeds with no errors.

---

### Task 5: Deploy backend to server

- [ ] **Step 1: Push backend changes and deploy**

```bash
git push
ssh root@159.69.207.195 "cd /workspace/project && git pull && npm run build && systemctl restart nanoclaw"
```

- [ ] **Step 2: Verify new API endpoints work on server**

```bash
ssh root@159.69.207.195 "sleep 5 && curl -s http://127.0.0.1:3847/api/tasks/stats | head -c 200"
```

Expected: JSON array with task stats.

```bash
ssh root@159.69.207.195 "curl -s 'http://127.0.0.1:3847/api/tasks/obs-maosnap-review/timeline' | head -c 200"
```

Expected: JSON array with timeline points.

---

### Task 6: Build and deploy MiniApp

- [ ] **Step 1: Build the mini-app on server**

```bash
ssh root@159.69.207.195 "cd /workspace/extra/Memory_Obsidian/mini-app && npm run build 2>&1 | tail -5"
```

Expected: Build succeeds, output in `dist/`.

- [ ] **Step 2: Verify in browser**

Open the Telegram MiniApp and navigate to "Scheduled Tasks". Should see:
- Tabs: "Stats" / "List"
- Stats tab: cards with success rates, avg durations, run counts
- Tap a card → timeline chart expands
- List tab: original task list with expandable run history
