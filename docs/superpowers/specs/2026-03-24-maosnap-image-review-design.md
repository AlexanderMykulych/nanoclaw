# Maosnap Image Review Agent

## Problem

Maosnap notes contain screenshots with numbered annotations and text explanations below. Currently they sit with `status: unprocessed` and no summary — you have to open the image to understand what the note is about.

## Solution

A scheduled container agent that reviews unprocessed maosnap notes, reads the screenshot via Claude vision, and writes a concise summary at the top of the note capturing the **essence** — not a description of the image.

## Architecture

Follows the existing scheduled task pattern: pre-check script → container agent → frontmatter marker.

### Files

| File | Location (relative to vault root) | Purpose |
|------|-----------------------------------|---------|
| Pre-check script | `Scripts/pre-check-maosnap-review.js` | Find unprocessed maosnap notes with images |
| Task definition | `Memory/mao/scheduled-tasks/maosnap-review.md` | Schedule, group, prompt |

### Pre-check Script

Node.js script that:
1. Recursively scans `Memory/` directory, **excluding `Memory/mao/`**
2. Reads `.md` files and checks frontmatter for `type: maosnap`
3. Filters out notes that already have `ai_image_reviewed: true`
4. Returns `{run: true, reason: "N unprocessed maosnaps: file1, file2..."}` or `{run: false, reason: "no unprocessed maosnaps"}`

### Task Definition

```yaml
schedule: "every 2m"
group: telegram_main
status: active
pre_check: "Scripts/pre-check-maosnap-review.js"
```

### Agent Prompt

The agent:
1. Finds all `.md` files in `Memory/` (excluding `Memory/mao/`) with `type: maosnap` and without `ai_image_reviewed: true`
2. For each note:
   a. Parses `![[filename.png]]` embed from the body
   b. Locates the image file in the vault (same directory, `attachments/`, vault root)
   c. Reads the image via the Read tool (Claude vision)
   d. Reads the numbered text annotations below the image
   e. Writes a `## Summary` section between frontmatter and the image embed
   f. Sets `ai_image_reviewed: true` and `status: processed` in frontmatter

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
status: processed
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

- `ai_image_reviewed: true` — prevents re-processing
- `status: processed` — updates note lifecycle status

### Language

Summary is written in the same language as the note's text annotations (typically Ukrainian).

## Testing

- Verify pre-check correctly finds unprocessed maosnap notes and skips `Memory/mao/`
- Verify pre-check skips notes with `ai_image_reviewed: true`
- Verify agent reads image and generates meaningful summary
- Verify frontmatter is updated correctly
- Verify `## Summary` is inserted between frontmatter and image embed
