# Maosnap Image Review Agent

## Problem

Maosnap notes contain screenshots with numbered annotations and text explanations below. Currently they sit with `status: unprocessed` and no summary — you have to open the image to understand what the note is about.

## Solution

A scheduled container agent that reviews unprocessed maosnap notes, reads the screenshot via Claude vision, and writes a concise summary at the top of the note capturing the **essence** — not a description of the image.

## Architecture

Follows the existing scheduled task pattern: pre-check script → container agent → frontmatter marker.

### Container Paths

Inside the container, the Obsidian vault is mounted at `/workspace/extra/Memory_Obsidian/`. All paths in the agent prompt use this prefix. The notes directory is `/workspace/extra/Memory_Obsidian/Memory/notes/` (and potentially other subdirs under `Memory/`, excluding `Memory/mao/`).

### Files

| File | Location (relative to vault root) | Purpose |
|------|-----------------------------------|---------|
| Pre-check script | `Scripts/pre-check-maosnap-review.js` | Find unprocessed maosnap notes with images |
| Task definition | `Memory/mao/scheduled-tasks/maosnap-review.md` | Schedule, group, prompt |

### Pre-check Script

```js
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const vault = process.argv[2];
if (!vault) {
  console.log(JSON.stringify({ run: false, reason: 'no vault path provided' }));
  process.exit(0);
}

const memDir = path.join(vault, 'Memory');
if (!fs.existsSync(memDir)) {
  console.log(JSON.stringify({ run: false, reason: 'Memory dir not found' }));
  process.exit(0);
}

const EXCLUDE = new Set(['mao']);
const needsReview = [];

function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // skip excluded top-level dirs under Memory/
    if (dir === memDir && EXCLUDE.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { scan(full); continue; }
    if (!entry.name.endsWith('.md')) continue;

    const content = fs.readFileSync(full, 'utf-8');
    if (!/type:\s*maosnap/.test(content)) continue;
    if (/ai_image_reviewed:\s*true/.test(content)) continue;

    needsReview.push(entry.name.replace(/\.md$/, ''));
    if (needsReview.length >= 10) return; // early exit — cap at 10
  }
}

scan(memDir);

if (needsReview.length > 0) {
  console.log(JSON.stringify({
    run: true,
    reason: `${needsReview.length} unprocessed maosnaps: ${needsReview.slice(0, 5).join(', ')}${needsReview.length > 5 ? '...' : ''}`,
  }));
} else {
  console.log(JSON.stringify({ run: false, reason: 'no unprocessed maosnaps' }));
}
```

### Task Definition

```yaml
schedule: "every 2m"
group: telegram_main
status: active
pre_check: "Scripts/pre-check-maosnap-review.js"
```

### Batch Size

The agent processes **at most 5 notes per run**. If more remain, the next 2-minute cycle picks them up. This keeps token usage and container runtime bounded.

### Agent Prompt

The agent:
1. Finds `.md` files in `/workspace/extra/Memory_Obsidian/Memory/` (excluding `Memory/mao/`) with `type: maosnap` and without `ai_image_reviewed: true`. Processes at most 5 notes.
2. For each note:
   a. Parses `![[filename.png]]` embed from the body
   b. Locates the image file (same directory as the note first, then `attachments/` subdirectory, then vault-level `attachments/`)
   c. Reads the image via the Read tool (Claude vision)
   d. Reads the numbered text annotations below the image
   e. Writes a `## Summary` section between frontmatter and the image embed
   f. Sets `ai_image_reviewed: true` in frontmatter
3. If a note has `type: maosnap` but no image embed — sets `ai_image_reviewed: true` anyway (nothing to extract)
4. If the image file is not found at any search path — skips the note, does NOT mark it reviewed (will retry next cycle)

### Summary Style

The summary captures the **essence** of what the screenshot is about — conclusions, decisions, key points. NOT a description like "На скріншоті зображено...".

The agent treats the numbered text below the image as annotations/hints to the screenshot content. The image + annotations together form the context from which the agent extracts the core meaning.

Example input:
```markdown
---
type: maosnap
date: 2026-03-24T12:04:01
source_app: "maosnap"
status: unprocessed
---

![[maosnap-2026-03-24-120401.png]]

1. Додати fallback для dev-режиму
2. Виправити CORS headers на proxy
3. Перевірити SSR bundle size
```

Example output:
```markdown
---
type: maosnap
date: 2026-03-24T12:04:01
source_app: "maosnap"
status: unprocessed
ai_image_reviewed: true
---

## Summary

Налаштування Vite конфігу для SSR з proxy на API. Потрібно додати fallback для dev-режиму, виправити CORS headers та перевірити розмір SSR бандлу.

![[maosnap-2026-03-24-120401.png]]

1. Додати fallback для dev-режиму
2. Виправити CORS headers на proxy
3. Перевірити SSR bundle size
```

### Image Location Strategy

Obsidian stores attachments in configurable locations. The agent searches for the image file in order:
1. Same directory as the note
2. `attachments/` subdirectory relative to note
3. Vault-level `attachments/` directory
4. Vault root

### Marking

- `ai_image_reviewed: true` — prevents re-processing (the agent's own marker, used by pre-check)
- `status` field is **not modified** by this agent — it belongs to the note lifecycle and may be used by other agents

### Language

Summary is written in the same language as the note's text annotations (typically Ukrainian).

### Edge Cases

- **No image embed** — note has `type: maosnap` but no `![[...]]`: mark `ai_image_reviewed: true`, skip summary
- **Image file not found** — skip note, do not mark reviewed (retry next cycle)
- **Multiple images** — process all images, combine into one summary
- **Note already has `## Summary`** — skip (already processed by another means)

### Error Handling

On success, agent returns: `"Reviewed N maosnaps: file1, file2, ..."`. On partial failure (some notes processed, some skipped), returns: `"Reviewed N/M maosnaps. Skipped: file3 (image not found)"`. This is logged to the `task_run_logs` table.

## Testing

- Verify pre-check correctly finds unprocessed maosnap notes and skips `Memory/mao/`
- Verify pre-check skips notes with `ai_image_reviewed: true`
- Verify pre-check early-exits at 10 results
- Verify agent reads image and generates meaningful summary (not a description)
- Verify agent processes at most 5 notes per run
- Verify frontmatter `ai_image_reviewed: true` is set after processing
- Verify `status` field is NOT modified
- Verify `## Summary` is inserted between frontmatter and image embed
- Verify notes without image embed are marked reviewed without summary
- Verify notes with missing image files are skipped and not marked
