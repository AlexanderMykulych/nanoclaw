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
- `cleanupTokenUsage(days)` — retention cleanup (30 days)

### 2. Request attribution — identifying which task made the request

**Container-runner** (`src/container-runner.ts`) passes two new env vars to each container:
- `NANOCLAW_GROUP` — group folder name (e.g., `telegram_main`)
- `NANOCLAW_TASK_ID` — task ID if scheduled task (e.g., `obs-maosnap-review`), empty for user messages

**Agent-runner** (`container/agent-runner/`) reads these env vars and injects a custom header on every Anthropic API request:
```
X-Nanoclaw-Meta: {"group":"telegram_main","taskId":"obs-maosnap-review"}
```

This is done by configuring the SDK's HTTP client or by setting a request interceptor. The header is added to requests going to the credential proxy (via `ANTHROPIC_BASE_URL`).

**Credential proxy** (`src/credential-proxy.ts`) reads and strips `X-Nanoclaw-Meta` before forwarding to Anthropic (Anthropic would reject unknown headers).

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

**Important:** Only intercept responses with `Content-Type: application/json` and status 200. Streaming responses (`text/event-stream`) are handled differently — the usage is in the final `message_stop` event. For streaming:
1. Pipe through a transform that watches for `event: message_stop` or `event: message_delta` with `usage` field
2. Extract usage from the delta event
3. Pipe everything through unchanged

**Edge cases:**
- Non-JSON responses (errors, 4xx/5xx) — pipe through, don't log usage
- Missing `usage` field — skip logging
- Parse errors — log warning, pipe response through unchanged

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
2. Container: `src/container-runner.ts`, `container/agent-runner/`
3. Deploy backend to server, rebuild container (`./container/build.sh`)
4. Frontend: `mini-app/src/api.ts`, `mini-app/src/views/MetricsView.vue`, `mini-app/src/views/TasksView.vue`
5. Build and deploy mini-app

**Note:** Container rebuild is required because agent-runner changes.

## Testing

- Verify credential proxy logs usage for non-streaming responses
- Verify credential proxy logs usage for streaming responses (message_delta event)
- Verify X-Nanoclaw-Meta header is stripped before forwarding
- Verify cost calculation with known model pricing
- Verify fallback pricing for unknown models
- Verify `/api/token-usage/summary` returns daily aggregation
- Verify `/api/token-usage/by-task` returns per-task breakdown
- Verify token_usage cleanup removes old records
- Verify Usage tab renders horizontal bar chart
- Verify Metrics page shows cost trend
- Verify Stats tab cards show per-task cost
