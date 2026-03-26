# Scheduled Tasks Stats Tab Redesign

## Problem

The Stats tab in the Telegram MiniApp's Scheduled Tasks page is overloaded — each card shows 6+ metrics (success rate, avg duration, total runs with breakdown, token cost, last run timestamp) making it hard to quickly scan task health. Users need a visual hierarchy: health at a glance first, details on demand.

## Solution

Redesign the Stats tab with a Dashboard + Spark Cards layout:
- **Summary bar** at top with aggregated metrics (health %, total runs, total cost)
- **Spark cards** per task: status dot + name + duration sparkline + success rate%
- **Expanded view** on tap: full timeline chart, duration stats, runs breakdown, cost

## Architecture

### Backend

**No backend changes.** Existing endpoints provide all needed data:
- `GET /api/tasks/stats?days=7` — aggregated stats per task (success_rate, avg_duration_ms, runs, cost)
- `GET /api/tasks/:id/timeline?days=7` — hourly-bucketed timeline points (run_at, duration_ms, status)
- `GET /api/token-usage/by-task?days=7` — cost per task
- `GET /api/tasks/quarantine` — quarantined tasks

The only new computation is client-side: aggregating summary metrics (total health %, total runs, total cost) from the per-task data.

### Frontend

**Modified file:** `mini-app/src/views/TasksView.vue` (on server at `/workspace/extra/Memory_Obsidian/mini-app/src/views/TasksView.vue`)

#### Summary Bar

Three metric cards at the top of Stats tab:
- **Health**: weighted average success_rate across all tasks (weighted by total_runs)
- **Runs**: sum of total_runs across all tasks
- **Cost**: sum of cost_usd from tokenUsageByTask

Color coding: Health green (#4ade80), Runs blue (#60a5fa), Cost yellow (#fbbf24).

#### Spark Cards (Collapsed State)

Each task rendered as a compact row:
- **Status dot** (8px circle): green ≥90%, yellow ≥70%, red <70% (based on success_rate)
- **Task name**: capitalize, strip `obs-` prefix, replace `-` with spaces. Ellipsis overflow for long names.
- **Duration sparkline**: inline SVG (64×22px), polyline from timeline data points mapping duration_ms to Y axis. Line color matches status dot. Final point has a filled circle.
- **Success rate**: percentage, right-aligned, colored same as dot.

Sorted by success_rate ascending (worst first) — already the backend sort order.

#### Expanded State (On Tap)

Card expands inline with a subtle border matching the status color. Contains:

1. **Timeline chart**: full-width SVG with area fill, viewBox-based responsive scaling.
   - Horizontal grid lines for visual reference
   - Polyline for duration trend, colored by status color
   - Circles at each data point colored by individual run status (green=success, red=error)
   - X-axis labels: start date / "Duration (7d)" / end date
   - Height: 64px

2. **Metrics grid** (2×2):
   - Avg Duration (formatted as seconds)
   - Min / Max duration
   - Total runs with breakdown (success✓ error✗ skipped⊘)
   - Cost with token breakdown (input/output)

3. **Last run** timestamp at bottom.

Only one card expanded at a time (existing behavior preserved).

#### Sparkline Data

The sparkline uses the same `/api/tasks/:id/timeline` endpoint that the expanded chart uses. To avoid N+1 API calls on page load, sparkline data is **lazy**: sparklines show only after timeline data is fetched. On initial load, spark cards show just the dot + name + rate (no sparkline). When any card is expanded, its timeline data is cached and the sparkline appears.

Alternative: preload all timelines in parallel on mount if task count is small (≤10). This gives instant sparklines at the cost of more API calls.

**Recommended approach:** Preload all timelines on mount (task count is typically 5-8), cache in `timelines` ref. Sparklines render from cached data. Expanded view reuses the same cache.

#### Unchanged Elements

- **Quarantine section** at the top — no changes
- **Tabs** (Stats / List / Usage) — no changes
- **List tab** — no changes
- **Usage tab** — no changes
- **API client** (`mini-app/src/api.ts`) — no changes

### Build & Deploy

Same as existing flow:
1. Update `TasksView.vue` on server
2. Build mini-app (`cd /workspace/extra/Memory_Obsidian/mini-app && npm run build`)
3. Dist is served by Caddy automatically

No backend deploy needed.

## Testing

- Verify summary bar shows correct aggregated metrics
- Verify spark cards render for all tasks with correct status colors
- Verify sparklines render after timeline data loads
- Verify tap expands card with full chart and metrics
- Verify only one card expanded at a time
- Verify layout works on mobile (375px width)
- Verify long task names truncate with ellipsis
- Verify edge cases: 0 timeline points → no sparkline, 1 point → single dot
