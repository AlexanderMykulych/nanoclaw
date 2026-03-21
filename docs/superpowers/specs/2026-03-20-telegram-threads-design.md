# Telegram Threads as Isolated Groups

## Problem

NanoClaw ignores Telegram forum topics (threads). Messages from threads arrive but the bot replies to the main chat, not back to the thread. There's no way to have per-thread isolated context/memory.

## Solution

Treat each Telegram thread as an independent registered group with its own JID, folder, and agent context. Auto-register threads when the first message arrives, if the parent chat is already registered.

## JID Format

Thread JID: `tg:{chatId}_{threadId}` (e.g., `tg:-1001234567_789`).

Non-thread messages keep the existing format: `tg:{chatId}`.

The `_` separator is safe because Telegram chat IDs are numeric (negative for groups) and thread IDs are positive integers — no ambiguity.

## Auto-Registration

When a message arrives with `ctx.message.message_thread_id`:

1. Build thread JID: `tg:{chatId}_{threadId}`
2. Check if thread JID is already registered → deliver message as normal
3. If not registered, check if parent chat `tg:{chatId}` is registered
4. If parent is registered, auto-create a new group:
   - `name`: topic name from Telegram (or `Thread {threadId}` as fallback)
   - `folder`: `{parentFolder}_t{threadId}` (e.g., `telegram_main_t789`)
   - `trigger`: empty string
   - `requiresTrigger`: `false` (threads are typically direct conversations)
   - `containerConfig`: `undefined` (no inherited mounts — fully independent)
   - `isMain`: `false`
   - `added_at`: current ISO timestamp
5. Deliver message to the new group

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

All send/edit methods use this parser to add `message_thread_id` when present.

## `/chatid` Command

When executed inside a thread, return the thread JID:

```
Chat ID: `tg:-1001234567_789`
Name: Topic Name
Type: thread
```

## `ownsJid` Update

`ownsJid` already checks `jid.startsWith('tg:')` — thread JIDs match this, so no change needed.

## `setTyping` Update

Include `message_thread_id` when sending typing indicator in a thread.

## Changes

### 1. `src/channels/telegram.ts`

- Add `parseThreadJid()` helper function
- `message:text` handler: build thread JID when `message_thread_id` is present; check thread registration, then parent registration; auto-register if needed
- Non-text message handlers (`storeNonText`): same thread JID logic
- `/chatid` command: show thread JID when in a thread
- `sendMessage()`: use `parseThreadJid` to add `message_thread_id`
- `sendMessageWithId()`: same
- `editMessage()`: same
- `setTyping()`: same
- `sendTelegramMessage()`: already accepts `message_thread_id` in options — no change needed

### 2. `src/index.ts`

- `registerGroup()` is called from `setRegisteredGroup()` in db.ts — thread auto-registration uses this existing path
- Thread groups are stored in `registeredGroups` like any other group
- No structural changes needed — the Telegram channel handles auto-registration internally by calling the existing `onMessage` callback after registering

### 3. `src/channels/telegram.ts` — Auto-Registration Callback

The `TelegramChannelOpts` interface needs a new callback for registering groups:

```ts
export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
}
```

The orchestrator (`index.ts`) passes its `registerGroup` function when constructing the channel.

## What This Does NOT Change

- Existing non-thread Telegram groups work exactly as before
- Database schema unchanged — threads are regular registered groups
- Container runtime, scheduler, IPC — all unchanged
- Thread groups can have scheduled tasks, container configs, etc. — they're full groups
