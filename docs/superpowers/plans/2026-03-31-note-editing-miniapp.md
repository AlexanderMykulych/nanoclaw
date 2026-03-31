# Note Editing in Telegram Mini App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable editing of existing notes (body + all frontmatter) from the Telegram mini app.

**Architecture:** New `updateVaultNote()` function in nanoclaw backend + PUT endpoint. New `NoteEditView.vue` component in the mini app frontend (separate repo). Edit button added to existing `VaultItemView.vue`. Two repos: nanoclaw (backend) and Memory_Obsidian (frontend).

**Tech Stack:** Node.js/TypeScript (backend), Vue 3 + Composition API + TypeScript (frontend), Vitest (tests)

---

## File Structure

| File | Repo | Action | Responsibility |
|------|------|--------|----------------|
| `src/vault.ts` | nanoclaw | Modify | Add `updateVaultNote()` function |
| `src/vault.test.ts` | nanoclaw | Modify | Add tests for `updateVaultNote()` |
| `src/api.ts` | nanoclaw | Modify | Add PUT endpoint + CORS for PUT |
| `src/api.test.ts` | nanoclaw | Modify | Add PUT endpoint test |
| `mini-app/src/api.ts` | Memory_Obsidian | Modify | Add `updateNote()` API method |
| `mini-app/src/views/NoteEditView.vue` | Memory_Obsidian | Create | Edit form component |
| `mini-app/src/views/VaultItemView.vue` | Memory_Obsidian | Modify | Add "Редагувати" button |
| `mini-app/src/main.ts` | Memory_Obsidian | Modify | Add edit route |

---

### Task 1: Backend — `updateVaultNote()` with TDD

**Files:**
- Modify: `src/vault.ts` (nanoclaw repo, after `createVaultNote` at line ~235)
- Modify: `src/vault.test.ts` (nanoclaw repo, after `createVaultNote` tests at line ~211)

- [ ] **Step 1: Write failing tests for `updateVaultNote`**

Add to `src/vault.test.ts` after the `createVaultNote` describe block (line 211):

```ts
describe('updateVaultNote', () => {
  let noteVaultDir: string;
  const testFilename = 'test-note.md';

  beforeAll(() => {
    noteVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-update-test-'));
    const notesDir = path.join(noteVaultDir, 'notes');
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(
      path.join(notesDir, testFilename),
      `---
date: 2026-03-31
time: "14:30"
sphere: робота
tags:
  - note
needs_ai_format: true
---

Original note text.
`,
    );
  });

  afterAll(() => {
    fs.rmSync(noteVaultDir, { recursive: true, force: true });
  });

  it('updates body text', () => {
    const result = updateVaultNote(testFilename, { text: 'Updated text.' }, noteVaultDir);
    expect(result.ok).toBe(true);

    const item = getVaultItem('notes', testFilename, noteVaultDir);
    expect(item!.content).toBe('Updated text.');
    expect(item!.frontmatter.date).toBe('2026-03-31');
    expect(item!.frontmatter.sphere).toBe('робота');
  });

  it('updates frontmatter fields while preserving others', () => {
    const result = updateVaultNote(
      testFilename,
      { frontmatter: { sphere: 'дім', tags: ['note', 'edited'] } },
      noteVaultDir,
    );
    expect(result.ok).toBe(true);

    const item = getVaultItem('notes', testFilename, noteVaultDir);
    expect(item!.frontmatter.sphere).toBe('дім');
    expect(item!.frontmatter.tags).toEqual(['note', 'edited']);
    expect(item!.frontmatter.date).toBe('2026-03-31');
    expect(item!.frontmatter.time).toBe('14:30');
    expect(item!.frontmatter.needs_ai_format).toBe(true);
  });

  it('updates both text and frontmatter at once', () => {
    const result = updateVaultNote(
      testFilename,
      { text: 'Both updated.', frontmatter: { sphere: "сім'я" } },
      noteVaultDir,
    );
    expect(result.ok).toBe(true);

    const item = getVaultItem('notes', testFilename, noteVaultDir);
    expect(item!.content).toBe('Both updated.');
    expect(item!.frontmatter.sphere).toBe("сім'я");
  });

  it('rejects invalid sphere', () => {
    const result = updateVaultNote(
      testFilename,
      { frontmatter: { sphere: 'invalid' } },
      noteVaultDir,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Invalid sphere');
  });

  it('rejects path traversal', () => {
    const result = updateVaultNote('../../../etc/passwd', { text: 'hack' }, noteVaultDir);
    expect(result.ok).toBe(false);
  });

  it('rejects non-md files', () => {
    const result = updateVaultNote('file.txt', { text: 'hack' }, noteVaultDir);
    expect(result.ok).toBe(false);
  });

  it('returns error for nonexistent file', () => {
    const result = updateVaultNote('nonexistent.md', { text: 'test' }, noteVaultDir);
    expect(result.ok).toBe(false);
  });
});
```

Also update the import at line 6 of `vault.test.ts` to include `updateVaultNote`:

```ts
import {
  listVaultItems,
  getVaultItem,
  listVaultTasks,
  toggleVaultTask,
  createVaultNote,
  updateVaultNote,
} from './vault.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/alexandermykulych/repo/nanoclaw && npx vitest run src/vault.test.ts`
Expected: FAIL — `updateVaultNote` is not exported from `./vault.js`

- [ ] **Step 3: Implement `updateVaultNote` in `src/vault.ts`**

Add after `createVaultNote` function (after line 235):

```ts
export function updateVaultNote(
  filename: string,
  updates: { text?: string; frontmatter?: Record<string, unknown> },
  vaultPath: string = OBSIDIAN_VAULT_PATH,
): { ok: true } | { ok: false; error: string } {
  if (filename.includes('..') || !filename.endsWith('.md')) {
    return { ok: false, error: 'Invalid filename' };
  }

  const notesDir = path.join(vaultPath, 'notes');
  const filePath = path.join(notesDir, filename);
  const resolvedDir = path.resolve(notesDir);
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(resolvedDir)) {
    return { ok: false, error: 'Invalid filename' };
  }

  if (!fs.existsSync(filePath)) {
    return { ok: false, error: 'Note not found' };
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = parseFrontmatter(raw);

  // Merge frontmatter
  const mergedFrontmatter = { ...parsed.frontmatter };
  if (updates.frontmatter) {
    if (
      updates.frontmatter.sphere !== undefined &&
      !VALID_SPHERES.includes(updates.frontmatter.sphere as NoteSphere)
    ) {
      return { ok: false, error: `Invalid sphere: ${updates.frontmatter.sphere}` };
    }
    Object.assign(mergedFrontmatter, updates.frontmatter);
  }

  const body = updates.text !== undefined ? updates.text.trim() : parsed.content;
  const yamlStr = YAML.stringify(mergedFrontmatter).trimEnd();
  const newContent = `---\n${yamlStr}\n---\n\n${body}\n`;

  fs.writeFileSync(filePath, newContent, 'utf-8');
  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/alexandermykulych/repo/nanoclaw && npx vitest run src/vault.test.ts`
Expected: All tests PASS including the new `updateVaultNote` describe block

- [ ] **Step 5: Commit**

```bash
cd /Users/alexandermykulych/repo/nanoclaw
git add src/vault.ts src/vault.test.ts
git commit -m "feat: add updateVaultNote function with tests"
```

---

### Task 2: Backend — PUT API endpoint

**Files:**
- Modify: `src/api.ts` (nanoclaw repo)
- Modify: `src/api.test.ts` (nanoclaw repo)

- [ ] **Step 1: Write failing test for PUT endpoint**

Add to `src/api.test.ts`, inside the existing `describe('API endpoints', ...)` block, after the last test (line ~232):

```ts
  it('PUT /api/vault/notes/:filename updates a note', async () => {
    // First create a note to edit
    const createRes = await fetch(`http://127.0.0.1:${port}/api/vault/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Original text', sphere: 'робота' }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { ok: boolean; filename: string };
    expect(created.ok).toBe(true);

    // Now update it
    const updateRes = await fetch(
      `http://127.0.0.1:${port}/api/vault/notes/${encodeURIComponent(created.filename)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'Updated text',
          frontmatter: { sphere: 'дім' },
        }),
      },
    );
    expect(updateRes.status).toBe(200);
    const updateData = (await updateRes.json()) as { ok: boolean };
    expect(updateData.ok).toBe(true);

    // Verify via GET
    const getRes = await fetchApi(
      `/api/vault/notes/${encodeURIComponent(created.filename)}`,
    );
    expect(getRes.status).toBe(200);
    const item = (await getRes.json()) as { content: string; frontmatter: Record<string, unknown> };
    expect(item.content).toBe('Updated text');
    expect(item.frontmatter.sphere).toBe('дім');
  });

  it('PUT /api/vault/notes/nonexistent.md returns 404', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/vault/notes/nonexistent.md`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'test' }),
      },
    );
    expect(res.status).toBe(404);
  });
```

Also add `updateVaultNote` to the import from `./vault.js` is not needed in api.test.ts — but we do need to import it in api.ts (next step).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/alexandermykulych/repo/nanoclaw && npx vitest run src/api.test.ts`
Expected: FAIL — PUT requests hit the 404 fallthrough

- [ ] **Step 3: Add PUT endpoint to `src/api.ts`**

First, add `updateVaultNote` to the import from `./vault.js` (line 28):

Change line 22-29 from:
```ts
import {
  listVaultItems,
  getVaultItem,
  listVaultTasks,
  toggleVaultTask,
  updateVaultItemStatus,
  createVaultNote,
} from './vault.js';
```
to:
```ts
import {
  listVaultItems,
  getVaultItem,
  listVaultTasks,
  toggleVaultTask,
  updateVaultItemStatus,
  createVaultNote,
  updateVaultNote,
} from './vault.js';
```

Second, add PUT to CORS preflight (line 61):

Change:
```ts
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
```
to:
```ts
          'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
```

Third, add the PUT endpoint handler. Insert **before** the existing `POST /api/vault/notes` handler (before line 172). This is important because the PUT route pattern `/api/vault/notes/:filename` would also match the generic GET handler `/api/vault/:type/:filename` — so it must come before that:

Insert after line 171 (`sendJson(res, 200, getErrors({ limit, offset }));`):

```ts
        } else if (
          path.match(/^\/api\/vault\/notes\/[^/]+$/) &&
          req.method === 'PUT'
        ) {
          const filename = decodeURIComponent(path.split('/')[4]);
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString()) as {
                text?: string;
                frontmatter?: Record<string, unknown>;
              };
              const result = updateVaultNote(filename, {
                text: body.text,
                frontmatter: body.frontmatter,
              });
              if (result.ok) {
                sendJson(res, 200, { ok: true });
              } else {
                sendJson(res, result.error === 'Note not found' ? 404 : 400, {
                  error: result.error,
                });
              }
            } catch {
              sendJson(res, 400, { error: 'Invalid request body' });
            }
          });
          return;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/alexandermykulych/repo/nanoclaw && npx vitest run src/api.test.ts`
Expected: All tests PASS including the two new PUT tests

- [ ] **Step 5: Run all tests to check nothing is broken**

Run: `cd /Users/alexandermykulych/repo/nanoclaw && npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/alexandermykulych/repo/nanoclaw
git add src/api.ts src/api.test.ts
git commit -m "feat: add PUT /api/vault/notes/:filename endpoint"
```

---

### Task 3: Frontend — API client method

**Files:**
- Modify: `mini-app/src/api.ts` (Memory_Obsidian repo, `/Users/alexandermykulych/repo/Memory_Obsidian/mini-app/src/api.ts`)

- [ ] **Step 1: Add `updateNote` method to the api object**

In `/Users/alexandermykulych/repo/Memory_Obsidian/mini-app/src/api.ts`, add after the `createNote` method (after line 175):

```ts
  updateNote: (filename: string, text: string, frontmatter: Record<string, unknown>) =>
    fetchApi<{ ok: boolean }>(`/api/vault/notes/${encodeURIComponent(filename)}`, {
      method: 'PUT',
      body: JSON.stringify({ text, frontmatter }),
    }),
```

- [ ] **Step 2: Commit**

```bash
cd /Users/alexandermykulych/repo/Memory_Obsidian
git add mini-app/src/api.ts
git commit -m "feat: add updateNote API method for note editing"
```

---

### Task 4: Frontend — `NoteEditView.vue` component

**Files:**
- Create: `mini-app/src/views/NoteEditView.vue` (Memory_Obsidian repo)

- [ ] **Step 1: Create the NoteEditView component**

Create `/Users/alexandermykulych/repo/Memory_Obsidian/mini-app/src/views/NoteEditView.vue`:

```vue
<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";

const route = useRoute();
const router = useRouter();
const filename = decodeURIComponent(route.params.filename as string);

const text = ref("");
const sphere = ref<string>("інше");
const tags = ref("");
const readonlyFields = ref<Array<{ key: string; value: unknown }>>([]);
const loading = ref(true);
const saving = ref(false);
const error = ref("");

const spheres = [
  { value: "робота", label: "Робота", icon: "💼" },
  { value: "дім", label: "Дім", icon: "🏠" },
  { value: "сім\x27я", label: "Сім\x27я", icon: "👨‍👩‍👧" },
  { value: "інше", label: "Інше", icon: "📌" },
];

const editableKeys = new Set(["sphere", "tags"]);

onMounted(async () => {
  try {
    const item = await api.vaultItem("notes", filename);
    text.value = item.content;
    sphere.value = (item.frontmatter.sphere as string) || "інше";
    const rawTags = item.frontmatter.tags as string[] | undefined;
    tags.value = rawTags ? rawTags.join(", ") : "";
    readonlyFields.value = Object.entries(item.frontmatter)
      .filter(([key]) => !editableKeys.has(key))
      .map(([key, value]) => ({ key, value }));
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to load note";
  } finally {
    loading.value = false;
  }
});

async function save() {
  saving.value = true;
  error.value = "";
  try {
    const parsedTags = tags.value
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    await api.updateNote(filename, text.value, {
      sphere: sphere.value,
      tags: parsedTags,
    });
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
    router.back();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to save";
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("error");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div>
    <h2 class="page-title">Edit Note</h2>

    <div v-if="loading" class="loading">Loading...</div>
    <template v-else>
      <div class="sphere-selector">
        <button
          v-for="s in spheres"
          :key="s.value"
          class="sphere-btn"
          :class="{ active: sphere === s.value }"
          @click="sphere = s.value"
        >
          <span class="sphere-icon">{{ s.icon }}</span>
          <span class="sphere-label">{{ s.label }}</span>
        </button>
      </div>

      <label class="field-label">Tags</label>
      <input
        v-model="tags"
        class="tags-input"
        placeholder="note, important, ..."
      />

      <label class="field-label">Content</label>
      <textarea
        v-model="text"
        class="note-input"
        rows="10"
      />

      <div v-if="readonlyFields.length" class="readonly-section">
        <label class="field-label">Other fields</label>
        <div v-for="f in readonlyFields" :key="f.key" class="readonly-field">
          <span class="readonly-key">{{ f.key }}:</span>
          <span class="readonly-value">{{ f.value }}</span>
        </div>
      </div>

      <div v-if="error" class="error-msg">{{ error }}</div>

      <button
        class="save-btn"
        :disabled="saving"
        @click="save"
      >
        {{ saving ? "Зберігаю..." : "Зберегти" }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.page-title {
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 16px;
}

.field-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--hint-color);
  text-transform: uppercase;
  margin-bottom: 6px;
  margin-top: 14px;
}

.sphere-selector {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
}

.sphere-btn {
  flex: 1;
  background: var(--secondary-bg);
  border: 2px solid transparent;
  border-radius: 10px;
  padding: 10px 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  transition: all 0.15s;
  color: var(--hint-color);
}

.sphere-btn.active {
  border-color: var(--button-color);
  color: var(--text-color);
  background: rgba(96, 165, 250, 0.1);
}

.sphere-icon {
  font-size: 20px;
}

.sphere-label {
  font-size: 11px;
  font-weight: 500;
}

.tags-input {
  width: 100%;
  background: var(--secondary-bg);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 12px 14px;
  font-size: 15px;
  color: var(--text-color);
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s;
}

.tags-input:focus {
  border-color: var(--button-color);
}

.tags-input::placeholder {
  color: var(--hint-color);
}

.note-input {
  width: 100%;
  background: var(--secondary-bg);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 14px;
  font-size: 15px;
  line-height: 1.5;
  color: var(--text-color);
  resize: vertical;
  min-height: 150px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s;
}

.note-input:focus {
  border-color: var(--button-color);
}

.readonly-section {
  margin-top: 14px;
  padding: 12px;
  background: var(--secondary-bg);
  border-radius: 12px;
}

.readonly-field {
  display: flex;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
}

.readonly-key {
  color: var(--hint-color);
  font-weight: 500;
}

.readonly-value {
  color: var(--text-color);
}

.save-btn {
  width: 100%;
  margin-top: 14px;
  padding: 14px;
  background: var(--button-color);
  border: none;
  border-radius: 12px;
  font-size: 16px;
  font-weight: 600;
  color: #fff;
  cursor: pointer;
  transition: opacity 0.15s;
}

.save-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.save-btn:not(:disabled):active {
  opacity: 0.8;
}

.loading {
  text-align: center;
  padding: 24px;
  color: var(--hint-color);
}

.error-msg {
  color: #f87171;
  font-size: 13px;
  margin-top: 8px;
  text-align: center;
}
</style>
```

- [ ] **Step 2: Commit**

```bash
cd /Users/alexandermykulych/repo/Memory_Obsidian
git add mini-app/src/views/NoteEditView.vue
git commit -m "feat: add NoteEditView component for note editing"
```

---

### Task 5: Frontend — Edit button + route registration

**Files:**
- Modify: `mini-app/src/views/VaultItemView.vue` (Memory_Obsidian repo)
- Modify: `mini-app/src/main.ts` (Memory_Obsidian repo)

- [ ] **Step 1: Add edit button to VaultItemView**

In `/Users/alexandermykulych/repo/Memory_Obsidian/mini-app/src/views/VaultItemView.vue`:

Add `useRouter` import and route `type` extraction. Change the `<script setup>` block (lines 1-49) to:

```vue
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, type VaultItemDetail } from '../api';
import MarkdownRenderer from '../components/MarkdownRenderer.vue';

const route = useRoute();
const router = useRouter();
const type = route.params.type as string;
const filename = decodeURIComponent(route.params.filename as string);
const item = ref<VaultItemDetail | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const approving = ref(false);

onMounted(async () => {
  try {
    item.value = await api.vaultItem(type, filename);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
});

const title = computed(() => {
  if (!item.value) return '';
  return (
    (item.value.frontmatter.section as string) ||
    (item.value.frontmatter.title as string) ||
    filename.replace(/\.md$/, '')
  );
});

const status = computed(() => (item.value?.frontmatter.status as string) || '');
const needsApproval = computed(() => status.value.toLowerCase().includes('approve'));
const isApproved = computed(() => status.value.toLowerCase() === 'done');
const isNote = computed(() => type === 'notes');

async function approve() {
  if (!item.value) return;
  approving.value = true;
  try {
    await api.updateVaultStatus(type, filename, 'Done');
    item.value.frontmatter.status = 'Done';
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    approving.value = false;
  }
}

function editNote() {
  router.push(`/notes/${encodeURIComponent(filename)}/edit`);
}
</script>
```

Add the edit button in the template. Replace the template block (lines 52-75) with:

```vue
<template>
  <div>
    <div v-if="loading" class="loading">Loading...</div>
    <div v-else-if="error" class="error-msg">{{ error }}</div>
    <template v-else-if="item">
      <div class="header">
        <h2 class="page-title">{{ title }}</h2>
        <span class="badge" :class="{ approved: isApproved, pending: needsApproval }">
          {{ status }}
        </span>
      </div>

      <button
        v-if="needsApproval"
        class="approve-btn"
        :disabled="approving"
        @click="approve"
      >
        {{ approving ? 'Approving...' : '✓ Approve' }}
      </button>

      <button
        v-if="isNote"
        class="edit-btn"
        @click="editNote"
      >
        Редагувати
      </button>

      <MarkdownRenderer :content="item.content" />
    </template>
  </div>
</template>
```

Add the edit button styles. In the `<style scoped>` block, add after the `.approve-btn:disabled` rule (after line 99):

```css
.edit-btn {
  width: 100%;
  padding: 12px;
  border: 1px solid var(--button-color);
  border-radius: 10px;
  background: transparent;
  color: var(--button-color);
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  margin-bottom: 16px;
  transition: opacity 0.15s;
}
.edit-btn:active { opacity: 0.7; }
```

- [ ] **Step 2: Add route in `main.ts`**

In `/Users/alexandermykulych/repo/Memory_Obsidian/mini-app/src/main.ts`, add the edit route after the `/notes/new` route (after line 19):

```ts
    { path: '/notes/:filename/edit', component: () => import('./views/NoteEditView.vue') },
```

- [ ] **Step 3: Verify the build compiles**

Run: `cd /Users/alexandermykulych/repo/Memory_Obsidian/mini-app && npm run build`
Expected: Build succeeds with no TypeScript errors

- [ ] **Step 4: Commit**

```bash
cd /Users/alexandermykulych/repo/Memory_Obsidian
git add mini-app/src/views/VaultItemView.vue mini-app/src/main.ts
git commit -m "feat: add edit button and route for note editing"
```

---

### Task 6: Build and deploy backend

**Files:**
- No new files — build and deploy existing changes from Tasks 1-2

- [ ] **Step 1: Build the nanoclaw backend**

Run: `cd /Users/alexandermykulych/repo/nanoclaw && npm run build`
Expected: TypeScript compilation succeeds

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/alexandermykulych/repo/nanoclaw && npx vitest run`
Expected: All tests pass

- [ ] **Step 3: Commit build if needed, push to remote**

Push nanoclaw backend changes:
```bash
cd /Users/alexandermykulych/repo/nanoclaw && git push
```

Push mini-app frontend changes:
```bash
cd /Users/alexandermykulych/repo/Memory_Obsidian && git push
```
