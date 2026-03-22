# Telegram Threads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Treat Telegram forum threads as isolated groups with their own agent context.

**Architecture:** Thread JID `tg:chatId_threadId` maps to an independent registered group. Auto-register on first message if parent chat is registered. All outbound methods parse the JID to include `message_thread_id`.

**Tech Stack:** TypeScript, grammY, better-sqlite3, vitest

**Spec:** `docs/superpowers/specs/2026-03-20-telegram-threads-design.md`

---

### Task 1: Add `parseThreadJid` helper and `registerGroup` to ChannelOpts

**Files:**
- Modify: `src/channels/registry.ts:8-12`
- Modify: `src/channels/telegram.ts:18-22`
- Modify: `src/index.ts:552-580`

- [ ] **Step 1: Add `registerGroup` to `ChannelOpts`**

In `src/channels/registry.ts`, add to the interface:

```ts
export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
}
```

- [ ] **Step 2: Update `TelegramChannelOpts` to match**

In `src/channels/telegram.ts`, update:

```ts
export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
}
```

- [ ] **Step 3: Add `parseThreadJid` helper**

In `src/channels/telegram.ts`, add before the class:

```ts
/**
 * Parse a Telegram JID into chat ID and optional thread ID.
 * Thread JID format: tg:{chatId}_{threadId}
 */
export function parseThreadJid(jid: string): { chatId: string; threadId?: number } {
  const numeric = jid.replace(/^tg:/, '');
  const underscoreIdx = numeric.lastIndexOf('_');
  if (underscoreIdx > 0) {
    const threadId = parseInt(numeric.substring(underscoreIdx + 1), 10);
    if (!isNaN(threadId)) {
      return {
        chatId: numeric.substring(0, underscoreIdx),
        threadId,
      };
    }
  }
  return { chatId: numeric };
}
```

- [ ] **Step 4: Wire `registerGroup` in `index.ts`**

In `src/index.ts`, add to `channelOpts` (~line 579):

```ts
registerGroup: registerGroup,
```

- [ ] **Step 5: Build and verify**

Run: `npm run build`

- [ ] **Step 6: Commit**

```bash
git add src/channels/registry.ts src/channels/telegram.ts src/index.ts
git commit -m "feat: add parseThreadJid helper and registerGroup to ChannelOpts"
```

---

### Task 2: Thread-aware inbound message handling

**Files:**
- Modify: `src/channels/telegram.ts` — `message:text` handler, `storeNonText`, voice handler, `/chatid`, photo handler, document handler

- [ ] **Step 1: Add `buildThreadJid` helper method to class**

In `TelegramChannel`, add a private helper that builds the JID and auto-registers:

```ts
/**
 * Build JID for a message, handling thread awareness.
 * Returns thread JID if in a forum thread, parent JID otherwise.
 * Auto-registers thread groups when first message arrives.
 */
private buildJid(ctx: any): string {
  const parentJid = `tg:${ctx.chat.id}`;
  const threadId = ctx.message?.message_thread_id;

  // No thread or General topic (threadId=1) → use parent JID
  if (!threadId || threadId === 1) return parentJid;

  const threadJid = `tg:${ctx.chat.id}_${threadId}`;

  // Already registered → use thread JID
  if (this.opts.registeredGroups()[threadJid]) return threadJid;

  // Check if parent is registered for auto-registration
  const parentGroup = this.opts.registeredGroups()[parentJid];
  if (!parentGroup || !this.opts.registerGroup) return parentJid;

  // Auto-register thread as independent group
  try {
    this.opts.registerGroup(threadJid, {
      name: `Thread ${threadId}`,
      folder: `${parentGroup.folder}_t${threadId}`,
      trigger: '',
      requiresTrigger: false,
      added_at: new Date().toISOString(),
      isMain: false,
    });
    logger.info(
      { threadJid, parentJid, threadId },
      'Auto-registered Telegram thread as group',
    );
  } catch (err) {
    logger.warn(
      { threadJid, err },
      'Failed to auto-register thread',
    );
    return parentJid;
  }

  return threadJid;
}
```

- [ ] **Step 2: Update `message:text` handler to use `buildJid`**

Replace `const chatJid = \`tg:${ctx.chat.id}\`;` (line 127) with:

```ts
const chatJid = this.buildJid(ctx);
```

- [ ] **Step 3: Update `storeNonText` to use `buildJid`**

Replace `const chatJid = \`tg:${ctx.chat.id}\`;` (line 204) with:

```ts
const chatJid = this.buildJid(ctx);
```

- [ ] **Step 4: Update voice handler to use `buildJid`**

Replace `const chatJid = \`tg:${ctx.chat.id}\`;` (line 305) with:

```ts
const chatJid = this.buildJid(ctx);
```

Also update the logger chatJid at line 291:
```ts
chatJid: this.buildJid(ctx),
```

- [ ] **Step 5: Update photo handler to use `buildJid`**

Replace `const chatJid = \`tg:${ctx.chat.id}\`;` (line 241) with:

```ts
const chatJid = this.buildJid(ctx);
```

- [ ] **Step 6: Update document handler to use `buildJid`**

Replace `const chatJid = \`tg:${ctx.chat.id}\`;` (line 347) with:

```ts
const chatJid = this.buildJid(ctx);
```

- [ ] **Step 7: Update `/chatid` command**

Replace the `/chatid` handler (lines 104-116) with:

```ts
this.bot.command('chatid', (ctx) => {
  const chatId = ctx.chat.id;
  const chatType = ctx.chat.type;
  const threadId = ctx.message?.message_thread_id;
  const chatName =
    chatType === 'private'
      ? ctx.from?.first_name || 'Private'
      : (ctx.chat as any).title || 'Unknown';

  if (threadId && threadId !== 1) {
    ctx.reply(
      `Chat ID: \`tg:${chatId}_${threadId}\`\nName: ${chatName}\nType: thread`,
      { parse_mode: 'Markdown' },
    );
  } else {
    ctx.reply(
      `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
      { parse_mode: 'Markdown' },
    );
  }
});
```

- [ ] **Step 8: Build and verify**

Run: `npm run build`

- [ ] **Step 9: Commit**

```bash
git add src/channels/telegram.ts
git commit -m "feat: thread-aware inbound message handling with auto-registration"
```

---

### Task 3: Thread-aware outbound messages

**Files:**
- Modify: `src/channels/telegram.ts` — `sendMessage`, `sendMessageWithId`, `editMessage`, `setTyping`

- [ ] **Step 1: Update `sendMessage` to use `parseThreadJid`**

Replace the method body (lines 426-452):

```ts
async sendMessage(jid: string, text: string): Promise<void> {
  if (!this.bot) {
    logger.warn('Telegram bot not initialized');
    return;
  }

  try {
    const { chatId, threadId } = parseThreadJid(jid);
    const options = threadId ? { message_thread_id: threadId } : {};

    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await sendTelegramMessage(this.bot.api, chatId, text, options);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await sendTelegramMessage(
          this.bot.api,
          chatId,
          text.slice(i, i + MAX_LENGTH),
          options,
        );
      }
    }
    logger.info({ jid, length: text.length }, 'Telegram message sent');
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send Telegram message');
  }
}
```

- [ ] **Step 2: Update `sendMessageWithId` to use `parseThreadJid`**

Replace the method body (lines 454-487):

```ts
async sendMessageWithId(
  jid: string,
  text: string,
): Promise<string | undefined> {
  if (!this.bot) {
    logger.warn('Telegram bot not initialized');
    return undefined;
  }

  try {
    const { chatId, threadId } = parseThreadJid(jid);
    const MAX_LENGTH = 4096;
    const truncated =
      text.length > MAX_LENGTH ? text.slice(0, MAX_LENGTH) : text;
    const threadOpts = threadId ? { message_thread_id: threadId } : {};

    let sent;
    try {
      sent = await this.bot.api.sendMessage(chatId, truncated, {
        parse_mode: 'Markdown',
        ...threadOpts,
      });
    } catch {
      sent = await this.bot.api.sendMessage(chatId, truncated, threadOpts);
    }

    logger.info(
      { jid, messageId: sent.message_id },
      'Telegram message sent with ID',
    );
    return sent.message_id.toString();
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send Telegram message with ID');
    return undefined;
  }
}
```

- [ ] **Step 3: Update `editMessage` to use `parseThreadJid`**

Replace the method body (lines 489-523):

```ts
async editMessage(
  jid: string,
  messageId: string,
  text: string,
): Promise<void> {
  if (!this.bot) {
    logger.warn('Telegram bot not initialized');
    return;
  }

  try {
    const { chatId } = parseThreadJid(jid);
    const msgId = parseInt(messageId, 10);
    const MAX_LENGTH = 4096;
    const truncated =
      text.length > MAX_LENGTH ? text.slice(0, MAX_LENGTH) : text;

    try {
      await this.bot.api.editMessageText(chatId, msgId, truncated, {
        parse_mode: 'Markdown',
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('message is not modified')) {
        return;
      }
      await this.bot.api.editMessageText(chatId, msgId, truncated);
    }
    logger.debug({ jid, messageId }, 'Telegram message edited');
  } catch (err) {
    logger.error({ jid, messageId, err }, 'Failed to edit Telegram message');
  }
}
```

- [ ] **Step 4: Update `setTyping` to use `parseThreadJid`**

Replace the method body (lines 541-549):

```ts
async setTyping(jid: string, isTyping: boolean): Promise<void> {
  if (!this.bot || !isTyping) return;
  try {
    const { chatId, threadId } = parseThreadJid(jid);
    const opts = threadId ? { message_thread_id: threadId } : {};
    await this.bot.api.sendChatAction(chatId, 'typing', opts);
  } catch (err) {
    logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
  }
}
```

- [ ] **Step 5: Build and run tests**

Run: `npm run build && npx vitest run src/channels/telegram.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/channels/telegram.ts
git commit -m "feat: thread-aware outbound messages (send, edit, typing)"
```

---

### Task 4: Final build and verification

- [ ] **Step 1: Full build**

Run: `npm run build`

- [ ] **Step 2: Run all tests**

Run: `npx vitest run`
