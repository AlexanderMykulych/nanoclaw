# Task Stats in Telegram MiniApp

## Problem

Scheduled tasks execute every 1-2 minutes, but there's no way to see aggregated execution statistics — success rates, average durations, trends. The existing TasksView shows per-task run history (last 50 logs), but no dashboard-level overview.

## Solution

Replace the existing Scheduled Tasks page in the MiniApp with a tabbed view: "Stats" tab with aggregated metrics and drill-down timeline charts, "List" tab with the current task list functionality.

## Architecture

### Backend

Two new endpoints in `src/api.ts`, backed by new aggregation queries in `src/db.ts`.

**`GET /api/tasks/stats?days=7`**

Returns aggregated statistics per task for the last N days (default 7).

```typescript
interface TaskStats {
  task_id: string;
  total_runs: number;
  success_count: number;
  error_count: number;
  skipped_count: number;
  avg_duration_ms: number;   // excludes skipped runs (0ms)
  max_duration_ms: number;
  min_duration_ms: number;
  last_run: string | null;
  success_rate: number;      // percentage, 0-100
}
```

SQL query:
```sql
SELECT
  task_id,
  COUNT(*) as total_runs,
  SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
  SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped_count,
  ROUND(AVG(CASE WHEN status != 'skipped' THEN duration_ms END)) as avg_duration_ms,
  MAX(CASE WHEN status != 'skipped' THEN duration_ms END) as max_duration_ms,
  MIN(CASE WHEN status != 'skipped' THEN duration_ms END) as min_duration_ms,
  MAX(run_at) as last_run,
  ROUND(100.0 * SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) /
    NULLIF(SUM(CASE WHEN status != 'skipped' THEN 1 ELSE 0 END), 0), 1) as success_rate
FROM task_run_logs
WHERE run_at > datetime('now', '-' || ? || ' days')
GROUP BY task_id
ORDER BY success_rate ASC, total_runs DESC
```

Sorting: worst success rate first — surfaces problems immediately.

**`GET /api/tasks/:id/timeline?days=7`**

Returns raw run logs for a specific task over N days, for the timeline chart. Excludes skipped runs (they clutter the chart with 0ms points).

```typescript
interface TimelinePoint {
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
}
```

SQL:
```sql
SELECT run_at, duration_ms, status
FROM task_run_logs
WHERE task_id = ? AND status != 'skipped'
  AND run_at > datetime('now', '-' || ? || ' days')
ORDER BY run_at ASC
```

### Frontend

**Modified file:** `mini-app/src/views/TasksView.vue`

Tabs at top: "Stats" (default) / "List".

**Stats tab:**
- Fetches `/api/tasks/stats?days=7` on mount
- Renders a card per task, sorted by success rate (worst first)
- Each card shows:
  - Task name (formatted: strip `obs-` prefix, replace `-` with spaces)
  - Success rate badge (green ≥90%, yellow ≥70%, red <70%)
  - Avg duration in seconds
  - Total runs count (success/error/skipped breakdown)
  - Last run timestamp
- Tap on card → expands inline timeline chart
- Chart fetched lazily from `/api/tasks/:id/timeline?days=7`

**Timeline chart:**
- Inline SVG, no external libraries
- X-axis: time (7 days)
- Y-axis: duration in seconds
- Points connected by line, colored by status (green=success, red=error)
- Responsive width (fills card width)
- Height: 120px fixed

**List tab:**
- Existing TasksView functionality unchanged (task list with expandable run history)

**Modified file:** `mini-app/src/api.ts`

Add two new API calls:
```typescript
taskStats: (days = 7) => fetchApi<TaskStats[]>(`/api/tasks/stats?days=${days}`),
taskTimeline: (id: string, days = 7) => fetchApi<TimelinePoint[]>(`/api/tasks/${id}/timeline?days=${days}`),
```

Add `TaskStats` and `TimelinePoint` interfaces.

### Routing

No routing changes. The `/tasks` route stays, the page just gets tabs internally.

### Build & Deploy

MiniApp is built locally (`cd mini-app && npm run build`) and the `dist/` folder is committed to the Obsidian vault. Caddy on the server serves `dist/` as static files and reverse-proxies `/api/*` to NanoClaw port 3847.

After code changes:
1. Add DB query + endpoint to NanoClaw (`src/db.ts`, `src/api.ts`)
2. Build & deploy NanoClaw to server (`git push`, SSH pull, `npm run build`, restart)
3. Update Vue component + api client in `mini-app/`
4. Build mini-app (`npm run build`)
5. Deploy dist to server

## Testing

- Verify `/api/tasks/stats` returns correct aggregated data
- Verify `/api/tasks/stats?days=1` filters to last 24h only
- Verify `/api/tasks/:id/timeline` returns chronological points without skipped
- Verify success_rate calculation excludes skipped from denominator
- Verify avg_duration_ms excludes skipped runs
- Verify Stats tab renders all tasks sorted by success rate
- Verify tap on card loads and displays timeline chart
- Verify List tab preserves existing functionality
- Verify Telegram theme variables apply correctly to new elements
