# MastraClaw — Personal Telegram Assistant on Mastra

**Date:** 2026-03-19
**Location:** `~/repo/mastraclaw/`
**Status:** Design approved

## Motivation

Replace NanoClaw's hand-rolled infrastructure (Docker containers, IPC, credential proxy, channel registry) with Mastra framework to get simpler architecture, Mastra Studio, built-in memory, and multi-model support out of the box.

## Core Architecture

Single Node.js process. No Docker containers. All agents run in-process.

```
┌─────────────────────────────────────────────────────┐
│                    Single Node.js Process            │
│                                                     │
│  grammy (polling)                                   │
│       ↓                                             │
│  Thread Resolver                                    │
│    chat_id → "tg:${chatId}"            (private)    │
│    chat_id + thread_id → "tg:${chatId}:${tid}"      │
│       ↓                                             │
│  Mastra Agent  ←── threadId + resourceId ("owner")  │
│       ↓                                             │
│    Tools: send_message, schedule_task,              │
│           readFile, writeFile, listFiles            │
│                                                     │
│  Scheduler (setInterval 60s) ──→ Mastra Agent       │
│  Obsidian Sync (setInterval 5m) ──→ SQLite tasks    │
└─────────────────────────────────────────────────────┘
```

## Channel: Telegram only

- **Library:** grammy
- **Mode:** polling (no public URL needed)
- **Threads:** Telegram forum topics supported — each topic gets isolated memory
- **Trigger:** private chat = always respond; groups = `@BotName` or custom pattern
- **Streaming:** edit-message approach for real-time response updates (debounce edits to respect Telegram rate limits)
- **Media:** photos/documents saved to thread attachments folder
- **Voice:** ElevenLabs Speech-to-Text API for transcription. Flow: download audio from Telegram → save to attachments → send to ElevenLabs → inject transcript as user message text. On failure, send error note to user.
- **Long messages:** split responses exceeding Telegram's 4096-char limit into multiple messages

### Thread ID Resolution

```typescript
function resolveThreadId(ctx: Context): string {
  const chatId = ctx.chat.id;
  const tid = ctx.message?.message_thread_id;
  return tid ? `tg:${chatId}:${tid}` : `tg:${chatId}`;
}

// threadId → directory name (colons replaced with dashes)
function threadDir(threadId: string): string {
  return path.join('data/threads', threadId.replaceAll(':', '-'));
}
// "tg:123456:789" → "data/threads/tg-123456-789"
```

## Mastra Agent & Memory

```typescript
const agent = new Agent({
  name: 'assistant',
  model: anthropic('claude-sonnet-4-6'),
  memory: new Memory({
    storage: new LibSQLStore({ url: 'file:data/mastra.db' }),
    vector: new LibSQLVector({ url: 'file:data/mastra.db' }),
    embedder: openai.textEmbeddingModel('text-embedding-3-small'),
    options: {
      lastMessages: 50,
      semanticRecall: { topK: 5 },
    }
  }),
  tools: { sendMessage, scheduleTask, listTasks, pauseTask, resumeTask, cancelTask, readFile, writeFile, listFiles },
});
```

**Memory isolation uses two dimensions:**
- `threadId` — conversation thread (Telegram chat or forum topic)
- `resourceId` — always `"owner"` (single-user system). Enables future cross-thread semantic search with `scope: 'resource'`.

```typescript
// Every agent call passes memory context
await agent.generate(userMessage, {
  threadId: resolveThreadId(ctx),
  resourceId: 'owner',
});
```

- **Thread isolation:** Mastra memory auto-isolates per threadId
- **Semantic recall:** agent searches past conversations within thread (or cross-thread via resourceId scope)
- **Working memory:** Mastra `workingMemory` can store per-thread structured state (preferences, context labels) — consider for future enhancement

**Multi-model:** default Claude Sonnet. Scheduled tasks can specify a model string (e.g., `google:gemini-2.5-pro`). A helper creates the appropriate agent instance or uses the model provider function.

## Filesystem Access

Sandboxed per-thread. Path traversal prevention: resolve to absolute path, verify it starts with the thread directory prefix. Reject any path containing `..`.

```
data/
  threads/
    tg-123456/              # private chat
    tg-123456-789/          # forum thread
      attachments/          # downloaded from Telegram
      files/                # created by agent
```

Tools:
- `readFile(path)` — read from thread dir
- `writeFile(path, content)` — write to thread dir
- `listFiles(path?)` — list files in thread dir

## Scheduled Tasks

### Database Tables

```sql
scheduled_tasks (
  id TEXT PRIMARY KEY,
  thread_id TEXT,          -- memory threadId AND Telegram reply target
  prompt TEXT,
  schedule_type TEXT,      -- 'cron' | 'interval' | 'once'
  schedule_value TEXT,     -- '0 9 * * 1' | '300000' | ISO timestamp
  context_mode TEXT,       -- 'thread' | 'isolated'
  model TEXT,              -- optional, e.g. 'google:gemini-2.5-pro'
  status TEXT,             -- 'active' | 'paused' | 'completed'
  next_run TEXT,
  last_run TEXT,
  last_result TEXT,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)

chat_config (
  thread_id TEXT PRIMARY KEY,
  trigger_pattern TEXT,    -- custom trigger regex for this chat/thread
  created_at TEXT DEFAULT (datetime('now'))
)

task_run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT REFERENCES scheduled_tasks(id),
  run_at TEXT,
  duration_ms INTEGER,
  status TEXT,             -- 'success' | 'error'
  result TEXT,
  error TEXT
)
```

### Scheduler Loop

```typescript
setInterval(async () => {
  const dueTasks = await db.getDueTasks();
  for (const task of dueTasks) {
    const startTime = Date.now();
    try {
      const threadId = task.context_mode === 'thread'
        ? task.threadId
        : `task:${task.id}`;

      const result = await agent.generate(task.prompt, {
        threadId,
        resourceId: 'owner',
        // model override handled by creating task-specific agent or provider function
      });

      await db.logTaskRun(task.id, {
        durationMs: Date.now() - startTime,
        status: 'success',
        result: result.text,
      });
    } catch (err) {
      await db.logTaskRun(task.id, {
        durationMs: Date.now() - startTime,
        status: 'error',
        error: String(err),
      });
      logger.error({ taskId: task.id, err }, 'Scheduled task failed');
      // Continue with remaining tasks
    }
  }
}, 60_000);
```

### Agent Tools for Tasks

- `scheduleTask({ prompt, schedule, threadId?, model? })` — create
- `listTasks({ threadId? })` — list
- `pauseTask(id)` / `resumeTask(id)` / `cancelTask(id)`

### Obsidian Sync

Same as NanoClaw:
- Path: `Memory/mao/scheduled-tasks/*.md`
- YAML frontmatter: `schedule`, `status`, `model`
- Task body = prompt
- ID prefix: `obs-{filename}`
- Syncs every 5 minutes
- Human-readable schedules: `daily 8:00`, `weekly mon 9:00`, `every 30m`

## Mastra Studio & Multi-Model

```typescript
// mastra.config.ts
export const mastra = new Mastra({
  agents: { assistant: agent },
  storage: new LibSQLStore({ url: 'file:data/mastra.db' }),
  logger: createLogger({ name: 'mastra', level: 'info' }),
});
```

**Studio provides:**
- Thread browser with history
- Memory inspection (recent + semantic)
- Traces (full prompt/tool/response logs)
- Tool testing UI
- Agent playground

**Multi-model support:**
- Default: `anthropic('claude-sonnet-4-6')`
- Per-task: `google('gemini-2.5-pro')`, `openai('gpt-4o')`, `groq('llama-4-scout')`, etc.
- Just set API keys in `.env`

**Running:**
```bash
npm run dev          # bot + scheduler
npx mastra dev       # Mastra Studio on localhost:4111
```

## Graceful Shutdown

```typescript
async function shutdown() {
  logger.info('Shutting down...');
  bot.stop();                     // stop Telegram polling
  clearInterval(schedulerTimer);  // stop scheduler
  clearInterval(obsidianTimer);   // stop Obsidian sync
  // wait for in-flight agent calls (with timeout)
  await Promise.race([flushPending(), delay(10_000)]);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

## Project Structure

```
src/
  index.ts              # Entry point: bot + scheduler + obsidian sync + shutdown
  agent.ts              # Mastra Agent config, memory, instructions

  telegram/
    bot.ts              # grammy bot, message handler, media
    thread-resolver.ts  # chat_id → threadId mapping + threadId → dir mapping
    trigger.ts          # trigger pattern matching
    media.ts            # photos, documents, voice (ElevenLabs)
    streaming.ts        # edit-message streaming with debounce

  scheduler/
    scheduler.ts        # setInterval loop, picks due tasks, error handling
    obsidian-sync.ts    # parses markdown → scheduled_tasks
    schedule-parser.ts  # cron / interval / once / human-readable

  tools/
    send-message.ts     # send message to Telegram
    schedule-task.ts    # CRUD for scheduled tasks
    filesystem.ts       # readFile, writeFile, listFiles (sandboxed, path validated)

  db/
    storage.ts          # LibSQL connection, migrations
    tables.ts           # scheduled_tasks, chat_config, task_run_logs

  config.ts             # env vars, defaults

data/
  mastra.db             # LibSQL — memory + tasks + config
  threads/              # per-thread files

mastra.config.ts        # Mastra config for Studio
```

## Comparison with NanoClaw

| NanoClaw | MastraClaw | Status |
|----------|-----------|--------|
| `container-runner.ts` | — | Removed (in-process agents) |
| `ipc.ts` + file watchers | — | Removed (direct JS calls) |
| `credential-proxy.ts` | — | Removed (direct API keys) |
| `group-queue.ts` | — | Removed (no container concurrency) |
| `mount-security.ts` | — | Removed (sandboxed FS tools) |
| `container/` (Dockerfile, agent-runner) | — | Removed |
| `channels/registry.ts` | `telegram/bot.ts` | Single channel, simpler |
| `db.ts` (7 tables) | `db/` (3 tables + Mastra memory) | Less |
| `task-scheduler.ts` | `scheduler/` | Similar scope |
| Custom session management | Mastra Memory | Built-in |
| No UI | Mastra Studio | Built-in |
| Claude only | Any model | Built-in |

**Estimated size:** ~15 files, ~1500 lines of code (vs ~30+ files, ~5000+ in NanoClaw).

## Notes

- **No data migration from NanoClaw** — clean start. NanoClaw continues running independently.
- **API verification needed** — Mastra API surface should be verified against installed version during implementation. The code examples in this spec are illustrative; exact signatures may differ.
