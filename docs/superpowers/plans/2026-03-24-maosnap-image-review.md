# Maosnap Image Review Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a scheduled agent that reviews maosnap notes with screenshots and writes concise summaries extracted from the image + text annotations.

**Architecture:** Two files deployed to the Obsidian vault on the production server: a Node.js pre-check script and a task definition markdown file. No changes to the NanoClaw codebase — uses existing scheduled task infrastructure.

**Tech Stack:** Node.js (pre-check script), Obsidian vault markdown (task definition), Claude vision (image analysis in container agent)

**Spec:** `docs/superpowers/specs/2026-03-24-maosnap-image-review-design.md`

---

### Task 1: Create the pre-check script

**Files:**
- Create: `Scripts/pre-check-maosnap-review.js` (on server at `/workspace/extra/Memory_Obsidian/Scripts/`)

- [ ] **Step 1: Check existing pre-check scripts on server for reference**

```bash
ssh root@159.69.207.195 "ls /workspace/extra/Memory_Obsidian/Scripts/pre-check-*.js"
```

- [ ] **Step 2: Create the pre-check script on server**

```bash
ssh root@159.69.207.195 "cat > /workspace/extra/Memory_Obsidian/Scripts/pre-check-maosnap-review.js << 'SCRIPT'
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
    if (dir === memDir && EXCLUDE.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { scan(full); continue; }
    if (!entry.name.endsWith('.md')) continue;

    const content = fs.readFileSync(full, 'utf-8');
    if (!/type:\s*maosnap/.test(content)) continue;
    if (/ai_image_reviewed:\s*true/.test(content)) continue;

    needsReview.push(entry.name.replace(/\.md$/, ''));
    if (needsReview.length >= 10) return;
  }
}

scan(memDir);

if (needsReview.length > 0) {
  console.log(JSON.stringify({
    run: true,
    reason: needsReview.length + ' unprocessed maosnaps: ' + needsReview.slice(0, 5).join(', ') + (needsReview.length > 5 ? '...' : ''),
  }));
} else {
  console.log(JSON.stringify({ run: false, reason: 'no unprocessed maosnaps' }));
}
SCRIPT"
```

- [ ] **Step 3: Test the pre-check script manually**

```bash
ssh root@159.69.207.195 "node /workspace/extra/Memory_Obsidian/Scripts/pre-check-maosnap-review.js /workspace/extra/Memory_Obsidian"
```

Expected: JSON with `run: true` and list of unprocessed maosnap note names (the 3 existing notes), OR `run: false` if they've all been processed already.

- [ ] **Step 4: Commit**

Pre-check script lives in the Obsidian vault (synced via git on server), not in the NanoClaw repo. No commit needed here.

---

### Task 2: Create the task definition

**Files:**
- Create: `Memory/mao/scheduled-tasks/maosnap-review.md` (on server at `/workspace/extra/Memory_Obsidian/Memory/mao/scheduled-tasks/`)

- [ ] **Step 1: Create the task definition file on server**

```bash
ssh root@159.69.207.195 "cat > /workspace/extra/Memory_Obsidian/Memory/mao/scheduled-tasks/maosnap-review.md << 'TASK'
---
schedule: \"every 2m\"
group: telegram_main
status: active
pre_check: \"Scripts/pre-check-maosnap-review.js\"
---

Ти — Mao. Переглянь нові maosnap нотатки і витягни суть з картинок.

1. Знайди всі .md файли рекурсивно у /workspace/extra/Memory_Obsidian/Memory/ (ВИКЛЮЧИ директорію Memory/mao/)
2. Відфільтруй тільки ті, де є type: maosnap у frontmatter і НЕМАЄ ai_image_reviewed: true
3. Обробляй максимум 5 нотаток за раз

Для кожної нотатки:
a. Знайди ![[filename.png]] або ![[filename.jpg]] у тілі нотатки
b. Якщо картинки немає — постав ai_image_reviewed: true у frontmatter і перейди до наступної
c. Якщо є кілька картинок — переглянь всі, об'єднай у один Summary
d. Знайди файл картинки: спершу у тій самій директорії, потім у attachments/ поруч з ноткою, потім у /workspace/extra/Memory_Obsidian/attachments/, потім у /workspace/extra/Memory_Obsidian/
e. Якщо файл картинки не знайдено — ПРОПУСТИ цю нотатку (НЕ ставь ai_image_reviewed), перейди до наступної
f. Прочитай картинку через Read tool — ти побачиш її вміст (vision)
g. Прочитай текстові пункти під картинкою — це підказки/анотації до неї
h. На основі картинки + тексту напиши короткий ## Summary — СУТЬ того, про що це (НЕ опис картинки типу \"на скріншоті зображено\", а висновок/зміст)
i. Встав ## Summary між frontmatter (---) і картинкою (![[...]])
j. Додай ai_image_reviewed: true у frontmatter (status НЕ змінюй)
k. Якщо нотатка вже має ## Summary — пропусти її

Мова Summary — така ж як мова тексту нотатки (зазвичай українська).

Приклад результату:
---
type: maosnap
date: 2026-03-24T12:04:01
source_app: \"maosnap\"
status: unprocessed
ai_image_reviewed: true
---

## Summary

Налаштування Vite конфігу для SSR з proxy на API. Потрібно додати fallback для dev-режиму, виправити CORS headers та перевірити розмір SSR бандлу.

![[maosnap-2026-03-24-120401.png]]

1. Додати fallback для dev-режиму
2. Виправити CORS headers на proxy
3. Перевірити SSR bundle size

---

Оберни весь свій внутрішній output в <internal> теги. Після обробки всіх нотаток виведи результат ЗА МЕЖАМИ <internal>:
- Якщо оброблено: \"Reviewed N maosnaps: file1, file2, ...\"
- Якщо частково: \"Reviewed N/M maosnaps. Skipped: file3 (image not found)\"
- Якщо нічого: нічого не виводь
TASK"
```

- [ ] **Step 2: Verify the task file was created correctly**

```bash
ssh root@159.69.207.195 "cat /workspace/extra/Memory_Obsidian/Memory/mao/scheduled-tasks/maosnap-review.md"
```

Expected: valid YAML frontmatter with schedule, group, status, pre_check fields, followed by the agent prompt.

- [ ] **Step 3: Wait for task sync to pick up the new task (~60s)**

```bash
ssh root@159.69.207.195 "sleep 5 && journalctl -u nanoclaw --no-pager -n 20 --output cat | grep -i maosnap"
```

Expected: log line showing the task was synced: `obs-maosnap-review` task created or updated.

---

### Task 3: Verify end-to-end execution

- [ ] **Step 1: Watch logs for the first pre-check run**

```bash
ssh root@159.69.207.195 "journalctl -u nanoclaw --no-pager -n 50 --output cat -f"
```

Wait up to 2 minutes. Expected: either `Pre-check passed, launching agent` with reason listing unprocessed maosnaps, or `Task skipped by pre-check` with reason `no unprocessed maosnaps`.

- [ ] **Step 2: If agent launched, verify a maosnap note was updated**

```bash
ssh root@159.69.207.195 "cat '/workspace/extra/Memory_Obsidian/Memory/notes/maosnap-2026-03-24-120401.md'"
```

Expected: note now has `ai_image_reviewed: true` in frontmatter and `## Summary` section between frontmatter and image embed.

- [ ] **Step 3: Verify pre-check gates correctly after processing**

Wait for the next 2-minute cycle. Expected: if all maosnaps are processed, pre-check should return `run: false` with reason `no unprocessed maosnaps`.

- [ ] **Step 4: Commit plan**

```bash
git add docs/superpowers/plans/2026-03-24-maosnap-image-review.md
git commit -m "docs: add maosnap image review implementation plan"
```
