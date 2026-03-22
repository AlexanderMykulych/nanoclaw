# Telegram Streaming & Message Editing

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable progressive message updates in Telegram — agent responses stream via edit-in-place instead of arriving as a single message after completion.

**Architecture:** Agent-runner emits `assistant` text content as streaming markers between tool calls. Host receives these via existing sentinel-based output parsing. Telegram channel sends first chunk as a new message, then edits it with each subsequent chunk. Edits are debounced (1s min interval) to respect Telegram rate limits. Final `result` text replaces the streaming message.

**Tech Stack:** grammy (Telegram Bot API), Claude Agent SDK (`query()` message stream), Node.js

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/types.ts` | Modify | Add `editMessage` and `sendMessageWithId` to `Channel` interface |
| `src/channels/telegram.ts` | Modify | Implement `editMessage`, `sendMessageWithId`, debounced editing |
| `container/agent-runner/src/index.ts` | Modify | Emit `assistant` text blocks as streaming output markers |
| `src/container-runner.ts` | Modify | Add `streaming` flag to `ContainerOutput` |
| `src/index.ts` | Modify | Streaming edit logic: send → edit → final replace |

---

### Task 1: Channel Interface — Add Edit & SendWithId

**Files:**
- Modify: `src/types.ts:82-93`

- [ ] **Step 1: Add optional methods to Channel interface**

Add `editMessage(jid, messageId, text)` and `sendMessageWithId(jid, text)` as optional methods.

- [ ] **Step 2: Build to verify**

Run: `npm run build`

---

### Task 2: Telegram Channel — Implement Edit & SendWithId

**Files:**
- Modify: `src/channels/telegram.ts:234-260`

- [ ] **Step 1: Implement `sendMessageWithId`**

Like `sendMessage` but returns the Telegram message_id as string. Only sends single message (no splitting) — streaming messages stay under 4096 chars.

- [ ] **Step 2: Implement `editMessage`**

Uses `bot.api.editMessageText()` with Markdown parse mode, falls back to plain text.

- [ ] **Step 3: Build to verify**

Run: `npm run build`

---

### Task 3: Agent Runner — Emit Assistant Text as Streaming Output

**Files:**
- Modify: `container/agent-runner/src/index.ts:446-474`

- [ ] **Step 1: Add `streaming` flag to ContainerOutput interface**

- [ ] **Step 2: Emit assistant text blocks between tool calls**

When `message.type === 'assistant'`, extract text content blocks. If non-empty after stripping `<internal>` tags, emit via `writeOutput({ status: 'success', result: text, streaming: true, newSessionId })`.

- [ ] **Step 3: Build container**

Run: `./container/build.sh`

---

### Task 4: Container Runner — Parse Streaming Flag

**Files:**
- Modify: `src/container-runner.ts:47-52`

- [ ] **Step 1: Add `streaming` field to ContainerOutput**

Add `streaming?: boolean` to the interface.

- [ ] **Step 2: Build to verify**

Run: `npm run build`

---

### Task 5: Index — Streaming Edit Logic

**Files:**
- Modify: `src/index.ts:206-235`

- [ ] **Step 1: Implement streaming edit flow**

Track `streamingMessageId` per invocation. On streaming output:
- First chunk: `sendMessageWithId()` → save message_id
- Subsequent chunks: `editMessage()` (debounced, 1s min interval)
- On `result`: edit with final text, or send new message if no prior streaming

- [ ] **Step 2: Build to verify**

Run: `npm run build`

- [ ] **Step 3: Test manually**

Send a message to the bot that triggers tool use (multi-step). Observe progressive message updates in Telegram.

---

### Task 6: Commit

- [ ] **Step 1: Commit all changes**

```bash
git add src/types.ts src/channels/telegram.ts container/agent-runner/src/index.ts src/container-runner.ts src/index.ts
git commit -m "feat: telegram streaming responses via progressive message editing"
```
