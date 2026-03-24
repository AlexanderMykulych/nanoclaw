# Token Usage Monitoring

## Problem

No visibility into how many tokens scheduled tasks consume. OAuth token expires every few hours, tasks fail silently, and there's no way to know which tasks are expensive or how much the system costs overall.

## Solution

Intercept Anthropic API responses in the credential proxy, extract `usage` data, store in SQLite, and display in the Telegram MiniApp — both as a global trend on Metrics and as per-task comparison on the Tasks page.

## Architecture

### 1. Database — new table `token_usage`

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

DB functions in `src/db.ts`:
- `insertTokenUsage(record)` — insert a row
- `getTokenUsageSummary(days)` — total input/output/cost per day
- `getTokenUsageByTask(days)` — per-task breakdown with totals
- `cleanupTokenUsage(days)` — retention cleanup (30 days), runs daily via `setInterval` in metrics-collector

**Note:** `cost_usd` is stored as a computed value at insert time. If model pricing changes, historical costs remain at the old price. This is intentional for simplicity.

### 2. Request attribution — identifying which task made the request

The claude-agent-sdk's `query()` does not expose HTTP-level configuration, so custom headers are not feasible. Instead, we use **URL-path-based attribution**: the metadata is encoded in the `ANTHROPIC_BASE_URL` that each container receives.

**Container-runner** (`src/container-runner.ts`):
- Currently sets `ANTHROPIC_BASE_URL=http://host:port` for all containers
- New: appends a path prefix with metadata: `ANTHROPIC_BASE_URL=http://host:port/meta/GROUP/TASK_ID`
- For user messages (no task): `http://host:port/meta/GROUP/_msg`
- The `taskId` field needs to be added to `ContainerInput` interface and passed from `task-scheduler.ts`

**Credential proxy** (`src/credential-proxy.ts`):
- Detects `/meta/` prefix in `req.url`
- Parses group and taskId from path: `/meta/telegram_main/obs-maosnap-review/v1/messages` → `group=telegram_main, taskId=obs-maosnap-review`
- Strips the `/meta/GROUP/TASK_ID` prefix before forwarding to Anthropic (upstream sees `/v1/messages` as normal)
- Only tracks requests to `/v1/messages` — ignores OAuth exchanges and other endpoints

**No agent-runner changes needed.** The SDK uses `ANTHROPIC_BASE_URL` as-is, appending `/v1/messages` to it. With the metadata prefix, the full URL becomes `http://host:port/meta/GROUP/TASK_ID/v1/messages` — the proxy handles the prefix stripping transparently.

**Note:** A single task run produces many API requests (tool use loops, subagent invocations). Each request creates a separate `token_usage` row. The per-task aggregation query sums them all.

### 3. Credential proxy — response interception

Current flow: proxy pipes upstream response directly to client (`upRes.pipe(res)`).

New flow:
1. Buffer the upstream response body (instead of piping)
2. Forward status code and headers to client immediately
3. Parse the JSON body
4. Extract `usage.input_tokens`, `usage.output_tokens`, and `model` from the response
5. Calculate cost using hardcoded pricing
6. Write to `token_usage` table (async, non-blocking — don't delay response)
7. Send the buffered body to client

**Content-type branching:**
- `application/json` + status 200 → buffer body, parse, extract usage, forward
- `text/event-stream` → pipe through Transform stream that watches for usage events
- Anything else (errors, 4xx/5xx, non-API responses) → pipe through unchanged, no tracking

**Streaming (SSE) interception:**
The Anthropic streaming format emits usage in two events:
- `message_start` → contains `usage.input_tokens`
- `message_delta` → contains `usage.output_tokens`

The Transform stream accumulates both values, then logs the combined usage after the stream ends. SSE lines are `data: {json}\n\n` — the transform must handle SSE framing (lines can split across TCP chunks), not naively JSON.parse each chunk.

**Edge cases:**
- Missing `usage` field — skip logging
- Parse errors — log warning, pipe response through unchanged
- `cache_creation_input_tokens` / `cache_read_input_tokens` — ignored in v1 (may affect cost accuracy slightly)
- Model field — extract from request body (more reliable than response) by parsing the buffered request chunks

### 4. Pricing

Hardcoded per-model pricing (USD per 1M tokens):

```typescript
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
  'claude-haiku-3-5-20241022': { input: 0.8, output: 4 },
};
```

Fallback: unknown models use Sonnet pricing. Cost formula: `(input_tokens * input_price + output_tokens * output_price) / 1_000_000`.

### 5. API endpoints

**`GET /api/token-usage/summary?days=7`**

Daily aggregation for trend chart:
```typescript
interface UsageSummaryRow {
  date: string;           // YYYY-MM-DD
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  request_count: number;
}
```

SQL:
```sql
SELECT
  date(timestamp) as date,
  SUM(input_tokens) as input_tokens,
  SUM(output_tokens) as output_tokens,
  ROUND(SUM(cost_usd), 4) as cost_usd,
  COUNT(*) as request_count
FROM token_usage
WHERE timestamp > datetime('now', '-' || ? || ' days')
GROUP BY date(timestamp)
ORDER BY date ASC
```

**`GET /api/token-usage/by-task?days=7`**

Per-task breakdown for comparison chart:
```typescript
interface UsageByTaskRow {
  task_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  request_count: number;
}
```

SQL:
```sql
SELECT
  COALESCE(task_id, '(messages)') as task_id,
  SUM(input_tokens) as input_tokens,
  SUM(output_tokens) as output_tokens,
  ROUND(SUM(cost_usd), 4) as cost_usd,
  COUNT(*) as request_count
FROM token_usage
WHERE timestamp > datetime('now', '-' || ? || ' days')
GROUP BY task_id
ORDER BY cost_usd DESC
```

**Routing:** Add both endpoints before existing `/api/tasks` in the `if/else if` chain (exact path match).

**Parameter validation:** `days` parsed as integer, default 7, clamp to `[1, 30]`.

### 6. MiniApp — Metrics page addition

New section at top of `MetricsView.vue`: "Token Usage"

- Line chart: cost per day over 7 days (SVG, same pattern as task timeline)
- Summary numbers below: total cost, total input tokens, total output tokens
- Fetches `/api/token-usage/summary?days=7`

### 7. MiniApp — Tasks page new "Usage" tab

Third tab on TasksView: "Stats" / "List" / "Usage"

**Usage tab:**
- Horizontal bar chart comparing tasks by cost
- Sorted by cost descending (most expensive first)
- Each bar: task name, cost ($), token counts (input/output)
- SVG inline, same style as existing charts
- Fetches `/api/token-usage/by-task?days=7`

### 8. MiniApp — Per-task cost on Stats tab

On each stat card (Stats tab), add a line showing token cost:
- `~$0.12 (45K in / 12K out)`
- Fetched as part of the by-task data (reuse same API call)

### 9. Build & Deploy

Same flow as task stats:
1. Backend: `src/db.ts`, `src/credential-proxy.ts`, `src/api.ts`
2. Container: `src/container-runner.ts` (no agent-runner changes needed)
3. Deploy backend to server, rebuild container (`./container/build.sh`) — needed because container-runner args change
4. Frontend: `mini-app/src/api.ts`, `mini-app/src/views/MetricsView.vue`, `mini-app/src/views/TasksView.vue`
5. Build and deploy mini-app

**Note:** The MiniApp frontend lives in the Obsidian vault on the server at `/workspace/extra/Memory_Obsidian/mini-app/`. It is NOT in the NanoClaw git repo.

Consider extracting usage tracking logic into `src/usage-tracker.ts` to keep `credential-proxy.ts` focused.

## Testing

- Verify credential proxy logs usage for non-streaming responses
- Verify credential proxy logs usage for streaming responses (message_delta event)
- Verify `/meta/GROUP/TASK_ID` prefix is stripped before forwarding to Anthropic
- Verify cost calculation with known model pricing
- Verify fallback pricing for unknown models
- Verify `/api/token-usage/summary` returns daily aggregation
- Verify `/api/token-usage/by-task` returns per-task breakdown
- Verify token_usage cleanup removes old records
- Verify Usage tab renders horizontal bar chart
- Verify Metrics page shows cost trend
- Verify Stats tab cards show per-task cost
