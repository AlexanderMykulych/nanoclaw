# Telegram Threads as Isolated Groups

## Problem

NanoClaw ignores Telegram forum topics (threads). Messages from threads arrive but the bot replies to the main chat, not back to the thread. There's no way to have per-thread isolated context/memory.

## Solution

Treat each Telegram thread as an independent registered group with its own JID, folder, and agent context. Auto-register threads when the first message arrives, if the parent chat is already registered.

## JID Format

Thread JID: `tg:{chatId}_{threadId}` (e.g., `tg:-1001234567_789`).

Non-thread messages keep the existing format: `tg:{chatId}`.

The `_` separator is safe because Telegram chat IDs are numeric (negative for groups) and thread IDs are positive integers — no ambiguity.

**General topic (threadId=1):** Some Telegram clients send `message_thread_id=1` for the "General" topic, others omit it. Treat threadId=1 as the parent chat (map to `tg:{chatId}`, not `tg:{chatId}_1`) to avoid creating a confusing duplicate group.

## Auto-Registration

When a message arrives with `ctx.message.message_thread_id` (and threadId != 1):

1. Build thread JID: `tg:{chatId}_{threadId}`
2. Check if thread JID is already registered → deliver message as normal
3. If not registered, check if parent chat `tg:{chatId}` is registered
4. If parent is registered, auto-create a new group:
   - `name`: `Thread {threadId}` (topic names are not available on message context without extra API calls — use simple fallback)
   - `folder`: `{parentFolder}_t{threadId}` (e.g., `telegram_main_t789`)
   - `trigger`: empty string
   - `requiresTrigger`: `false` (threads are typically direct conversations)
   - `containerConfig`: `undefined` (no inherited mounts — fully independent)
   - `isMain`: `false`
   - `added_at`: current ISO timestamp
5. Deliver message to the new group

**Folder uniqueness:** `setRegisteredGroup` uses `INSERT OR REPLACE` on JID primary key. If a folder name collision occurs (UNIQUE constraint on folder), catch the error, log it, and skip auto-registration for that thread.

**Race condition:** Two simultaneous messages in the same thread could both attempt registration. Since `setRegisteredGroup` is idempotent (INSERT OR REPLACE) and `fs.mkdirSync` with `recursive: true` is idempotent, this is safe.

If the parent chat is NOT registered, ignore the message (same as current behavior for unregistered chats).

## Outbound Messages

`sendMessage`, `sendMessageWithId`, and `editMessage` must route replies to the correct thread.

Parse the JID: if it contains `_`, extract the thread ID portion and include `message_thread_id` in the Telegram API call.

```ts
function parseThreadJid(jid: string): { chatId: string; threadId?: number } {
  const numeric = jid.replace(/^tg:/, '');
  const underscoreIdx = numeric.lastIndexOf('_');
  if (underscoreIdx > 0) {
    return {
      chatId: numeric.substring(0, underscoreIdx),
      threadId: parseInt(numeric.substring(underscoreIdx + 1), 10),
    };
  }
  return { chatId: numeric };
}
```

All send/edit methods use this parser to add `message_thread_id` when present:

- `sendMessage()`: pass `message_thread_id` to `sendTelegramMessage` options for both single and chunked paths
- `sendMessageWithId()`: pass `message_thread_id` directly to `bot.api.sendMessage` in both Markdown and fallback paths
- `editMessage()`: pass `message_thread_id` to `bot.api.editMessageText`

## `/chatid` Command

When executed inside a thread (and threadId != 1), return the thread JID:

```
Chat ID: `tg:-1001234567_789`
Name: Thread Name
Type: thread
```

Access `ctx.message?.message_thread_id` which is available on command contexts in grammY.

## `ownsJid` Update

`ownsJid` already checks `jid.startsWith('tg:')` — thread JIDs match this, so no change needed.

## `setTyping` Update

Include `message_thread_id` when sending typing indicator in a thread.

## Changes

### 1. `src/channels/telegram.ts`

- Add `parseThreadJid()` helper function
- **`message:text` handler**: build thread JID when `message_thread_id` is present (skip threadId=1); check thread registration, then parent registration; auto-register if needed
- **Non-text handlers (`storeNonText`)**: same thread JID logic — the `storeNonText` closure builds `chatJid`, update it to include thread ID
- **Voice handler**: has its own inline message delivery path (lines 276-339) that bypasses `storeNonText` — must also build thread-aware JID at line 305
- **`/chatid` command**: show thread JID when `ctx.message?.message_thread_id` is present and != 1
- **`sendMessage()`**: use `parseThreadJid`, pass `message_thread_id` in options for both single-message and chunked (loop) paths
- **`sendMessageWithId()`**: use `parseThreadJid`, pass `message_thread_id` to `bot.api.sendMessage` in both Markdown and plain-text fallback paths
- **`editMessage()`**: use `parseThreadJid`, pass `message_thread_id` to `bot.api.editMessageText`
- **`setTyping()`**: use `parseThreadJid`, pass `message_thread_id` to `sendChatAction`
- `sendTelegramMessage()`: already accepts `message_thread_id` in options — no change needed

### 2. `src/channels/telegram.ts` — Registration Callback

Add `registerGroup` to `TelegramChannelOpts`:

```ts
export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
}
```

### 3. `src/channels/registry.ts` — ChannelOpts

Add `registerGroup` to the shared `ChannelOpts` interface so it's available to all channels:

```ts
export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
}
```

### 4. `src/index.ts` — Wire up registerGroup

Pass the existing `registerGroup` function in `channelOpts`:

```ts
const channelOpts: ChannelOpts = {
  onMessage: ...,
  onChatMetadata: ...,
  registeredGroups: () => registeredGroups,
  registerGroup: registerGroup,  // existing function at line 94
};
```

## What This Does NOT Change

- Existing non-thread Telegram groups work exactly as before
- Database schema unchanged — threads are regular registered groups
- Container runtime, scheduler, IPC — all unchanged
- Thread groups can have scheduled tasks, container configs, etc. — they're full groups
