# Vault Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Obsidian research notes browsing to the Telegram Mini App — list view with title/status badges and full note rendering with `vtable` Vue component support.

**Architecture:** Backend adds two endpoints to NanoClaw's API server for listing and reading vault files. Frontend migrates from NanoClaw to the Obsidian repo, gains `markdown-it` rendering with a custom plugin for `vtable` code blocks, and imports vtable Vue components via `file:` dependency.

**Tech Stack:** Node.js `node:fs`, `yaml` (YAML parsing), `markdown-it`, Vue 3, vtable Vue components

**Spec:** `docs/superpowers/specs/2026-03-22-vault-viewer-design.md`

---

## File Map

### NanoClaw repo — Backend

| File | Action | Responsibility |
|------|--------|----------------|
| `src/vault.ts` | Create | Vault type config, listVaultItems(), getVaultItem(), frontmatter parsing |
| `src/vault.test.ts` | Create | Tests for vault functions |
| `src/api.ts` | Modify | Add `/api/vault/:type` and `/api/vault/:type/:filename` routes |
| `src/config.ts` | Modify | Add `OBSIDIAN_VAULT_PATH` |

### Obsidian repo — vtable plugin

| File | Action | Responsibility |
|------|--------|----------------|
| `Memory/.obsidian/plugins/vtable/src/components/index.ts` | Create | Barrel export for VTable, DataTable, BarChart |
| `Memory/.obsidian/plugins/vtable/package.json` | Modify | Add `exports` field for components |

### Obsidian repo — Mini App (after migration)

| File | Action | Responsibility |
|------|--------|----------------|
| `mini-app/` | Move | Entire directory from NanoClaw to Obsidian repo |
| `mini-app/package.json` | Modify | Add `obsidian-vtable`, `markdown-it` deps |
| `mini-app/src/api.ts` | Modify | Add VaultItem types and api methods |
| `mini-app/src/main.ts` | Modify | Add vault routes |
| `mini-app/src/views/HomeView.vue` | Modify | Add Researches DrillCard |
| `mini-app/src/views/VaultListView.vue` | Create | List view with title + badge |
| `mini-app/src/views/VaultItemView.vue` | Create | Note rendering with MarkdownRenderer |
| `mini-app/src/components/MarkdownRenderer.vue` | Create | markdown-it + vtable plugin rendering |

---

## Task 1: Migrate mini-app to Obsidian repo

**Files:**
- Move: `nanoclaw/mini-app/` → `Memory_Obsidian/mini-app/`
- Remove: `nanoclaw/mini-app/`

- [ ] **Step 1: Copy mini-app to Obsidian repo**

```bash
cp -r /Users/alexandermykulych/repo/nanoclaw/mini-app /Users/alexandermykulych/repo/Memory_Obsidian/mini-app
```

- [ ] **Step 2: Verify build works from new location**

```bash
cd /Users/alexandermykulych/repo/Memory_Obsidian/mini-app && npm install && npm run build
```

Expected: Build succeeds

- [ ] **Step 3: Remove mini-app from NanoClaw**

```bash
cd /Users/alexandermykulych/repo/nanoclaw
rm -rf mini-app/
```

- [ ] **Step 4: Commit in both repos**

```bash
# Obsidian repo
cd /Users/alexandermykulych/repo/Memory_Obsidian
git add mini-app/
git commit -m "feat: migrate Telegram Mini App from NanoClaw"

# NanoClaw repo
cd /Users/alexandermykulych/repo/nanoclaw
git add -A
git commit -m "chore: remove mini-app (moved to Obsidian repo)"
```

---

## Task 2: vtable components export

**Files:**
- Create: `Memory/.obsidian/plugins/vtable/src/components/index.ts`
- Modify: `Memory/.obsidian/plugins/vtable/package.json`

- [ ] **Step 1: Create barrel export**

Create `Memory_Obsidian/Memory/.obsidian/plugins/vtable/src/components/index.ts`:

```typescript
export { default as VTable } from './VTable.vue';
export { default as DataTable } from './DataTable.vue';
export { default as BarChart } from './BarChart.vue';
```

- [ ] **Step 2: Add exports field to vtable package.json**

In `Memory_Obsidian/Memory/.obsidian/plugins/vtable/package.json`, add the `exports` field:

```json
{
  "name": "obsidian-vtable",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/main.ts",
    "./components": "./src/components/index.ts",
    "./yaml-parser": "./src/yaml-parser.ts",
    "./types": "./src/types.ts"
  },
  ...rest stays the same...
}
```

Also export `yaml-parser` and `types` — the MarkdownRenderer will need the YAML parser to parse vtable code blocks.

- [ ] **Step 3: Commit**

```bash
cd /Users/alexandermykulych/repo/Memory_Obsidian
git add Memory/.obsidian/plugins/vtable/
git commit -m "feat: add components barrel export for vtable plugin"
```

---

## Task 3: Wire vtable + markdown-it into mini-app

**Files:**
- Modify: `Memory_Obsidian/mini-app/package.json`

- [ ] **Step 1: Add dependencies**

In `Memory_Obsidian/mini-app/package.json`, add to `dependencies`:

```json
{
  "dependencies": {
    "vue": "^3.5.0",
    "vue-router": "^4.5.0",
    "markdown-it": "^14.0.0",
    "obsidian-vtable": "file:../Memory/.obsidian/plugins/vtable"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.2.0",
    "@types/markdown-it": "^14.0.0",
    "typescript": "^5.7.0",
    "vite": "^6.1.0",
    "vue-tsc": "^2.2.0"
  }
}
```

- [ ] **Step 2: Install and verify**

```bash
cd /Users/alexandermykulych/repo/Memory_Obsidian/mini-app
npm install
npm run build
```

Expected: Build succeeds (no new code using these deps yet, just verifying resolution)

- [ ] **Step 3: Commit**

```bash
cd /Users/alexandermykulych/repo/Memory_Obsidian
git add mini-app/package.json mini-app/package-lock.json
git commit -m "feat: add markdown-it and obsidian-vtable dependencies"
```

---

## Task 4: Backend — vault.ts + config

**Files:**
- Create: `src/vault.ts`
- Create: `src/vault.test.ts`
- Modify: `src/config.ts`

- [ ] **Step 1: Add OBSIDIAN_VAULT_PATH to config**

In `src/config.ts`, add:

```typescript
export const OBSIDIAN_VAULT_PATH =
  process.env.OBSIDIAN_VAULT_PATH || '/workspace/extra/Memory_Obsidian/Memory';
```

- [ ] **Step 2: Write failing tests**

Create `src/vault.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { listVaultItems, getVaultItem, VAULT_TYPES } from './vault.js';

let testVaultDir: string;

beforeAll(() => {
  // Create temp vault structure
  testVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
  const researchDir = path.join(testVaultDir, 'onyx/research');
  fs.mkdirSync(researchDir, { recursive: true });

  // File with full frontmatter
  fs.writeFileSync(
    path.join(researchDir, 'test-research.md'),
    `---
status: Done
section: "Test Research Title"
created: "2026-03-20"
tags:
  - research
---

# Test Research

Some content here.

\`\`\`vtable
columns:
  - field: name
    label: Name
data:
  - name: Alice
\`\`\`
`,
  );

  // File with minimal frontmatter
  fs.writeFileSync(
    path.join(researchDir, 'minimal.md'),
    `---
status: to Approve
---

# Minimal note
`,
  );
});

afterAll(() => {
  fs.rmSync(testVaultDir, { recursive: true, force: true });
});

describe('listVaultItems', () => {
  it('lists research files with parsed frontmatter', () => {
    const items = listVaultItems('researches', testVaultDir);
    expect(items).toHaveLength(2);

    const full = items.find((i) => i.filename === 'test-research.md');
    expect(full).toBeDefined();
    expect(full!.title).toBe('Test Research Title');
    expect(full!.badge).toBe('Done');
    expect(full!.created).toBe('2026-03-20');
  });

  it('handles files with missing title field gracefully', () => {
    const items = listVaultItems('researches', testVaultDir);
    const minimal = items.find((i) => i.filename === 'minimal.md');
    expect(minimal).toBeDefined();
    expect(minimal!.title).toBe('minimal'); // fallback to filename without extension
    expect(minimal!.badge).toBe('to Approve');
  });

  it('returns 404-style null for unknown type', () => {
    const items = listVaultItems('unknown', testVaultDir);
    expect(items).toBeNull();
  });
});

describe('getVaultItem', () => {
  it('returns frontmatter and content separately', () => {
    const item = getVaultItem('researches', 'test-research.md', testVaultDir);
    expect(item).not.toBeNull();
    expect(item!.frontmatter.status).toBe('Done');
    expect(item!.frontmatter.section).toBe('Test Research Title');
    expect(item!.content).toContain('# Test Research');
    expect(item!.content).toContain('```vtable');
    expect(item!.content).not.toContain('---'); // frontmatter stripped
  });

  it('rejects path traversal', () => {
    const item = getVaultItem('researches', '../../../etc/passwd', testVaultDir);
    expect(item).toBeNull();
  });

  it('rejects non-md files', () => {
    const item = getVaultItem('researches', 'file.txt', testVaultDir);
    expect(item).toBeNull();
  });

  it('returns null for nonexistent file', () => {
    const item = getVaultItem('researches', 'nonexistent.md', testVaultDir);
    expect(item).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- --run src/vault.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement vault.ts**

Create `src/vault.ts`:

```typescript
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { OBSIDIAN_VAULT_PATH } from './config.js';

export interface VaultTypeConfig {
  path: string;
  titleField: string;
  badgeField: string;
}

export const VAULT_TYPES: Record<string, VaultTypeConfig> = {
  researches: {
    path: 'onyx/research',
    titleField: 'section',
    badgeField: 'status',
  },
};

export interface VaultListItem {
  filename: string;
  title: string;
  badge: string | null;
  created: string | null;
}

export interface VaultItemDetail {
  frontmatter: Record<string, unknown>;
  content: string;
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; content: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, content: raw };
  try {
    const frontmatter = YAML.parse(match[1]) as Record<string, unknown>;
    return { frontmatter, content: match[2].trimStart() };
  } catch {
    return { frontmatter: {}, content: raw };
  }
}

export function listVaultItems(
  type: string,
  vaultPath: string = OBSIDIAN_VAULT_PATH,
): VaultListItem[] | null {
  const typeConfig = VAULT_TYPES[type];
  if (!typeConfig) return null;

  const dirPath = path.join(vaultPath, typeConfig.path);
  if (!fs.existsSync(dirPath)) return [];

  const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md'));

  return files
    .map((filename) => {
      const raw = fs.readFileSync(path.join(dirPath, filename), 'utf-8');
      const { frontmatter } = parseFrontmatter(raw);

      const title =
        (frontmatter[typeConfig.titleField] as string) ||
        filename.replace(/\.md$/, '');
      const badge = (frontmatter[typeConfig.badgeField] as string) || null;
      const created = (frontmatter.created as string) || null;

      return { filename, title, badge, created };
    })
    .sort((a, b) => {
      if (!a.created && !b.created) return 0;
      if (!a.created) return 1;
      if (!b.created) return -1;
      return b.created.localeCompare(a.created);
    });
}

export function getVaultItem(
  type: string,
  filename: string,
  vaultPath: string = OBSIDIAN_VAULT_PATH,
): VaultItemDetail | null {
  const typeConfig = VAULT_TYPES[type];
  if (!typeConfig) return null;

  // Security: reject path traversal and non-md files
  if (filename.includes('..') || !filename.endsWith('.md')) return null;

  const filePath = path.join(vaultPath, typeConfig.path, filename);

  // Verify resolved path is within expected directory
  const resolvedDir = path.resolve(path.join(vaultPath, typeConfig.path));
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(resolvedDir)) return null;

  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf-8');
  return parseFrontmatter(raw);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- --run src/vault.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/vault.ts src/vault.test.ts src/config.ts
git commit -m "feat: add vault file reader with type-based config"
```

---

## Task 5: Backend — API endpoints

**Files:**
- Modify: `src/api.ts`

- [ ] **Step 1: Add vault endpoints to api.ts**

Import vault functions at the top of `src/api.ts`:

```typescript
import { listVaultItems, getVaultItem } from './vault.js';
```

Add two new route blocks inside the request handler, before the `else { sendJson(res, 404, ...); }` block:

```typescript
        } else if (path.match(/^\/api\/vault\/[^/]+$/) && !path.endsWith('/')) {
          const type = path.split('/')[3];
          const items = listVaultItems(type);
          if (items === null) {
            sendJson(res, 404, { error: `Unknown vault type: ${type}` });
          } else {
            sendJson(res, 200, items);
          }
        } else if (path.match(/^\/api\/vault\/[^/]+\/[^/]+$/)) {
          const parts = path.split('/');
          const type = parts[3];
          const filename = decodeURIComponent(parts[4]);
          const item = getVaultItem(type, filename);
          if (item === null) {
            sendJson(res, 404, { error: 'Not found' });
          } else {
            sendJson(res, 200, item);
          }
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Add to API integration test**

In `src/api.test.ts`, add these tests inside the `describe('API endpoints', ...)` block:

```typescript
  it('GET /api/vault/researches returns array', async () => {
    const res = await fetchApi('/api/vault/researches');
    expect(res.status).toBe(200);
    const data = (await res.json()) as unknown[];
    expect(Array.isArray(data)).toBe(true);
  });

  it('GET /api/vault/unknown returns 404', async () => {
    const res = await fetchApi('/api/vault/unknown');
    expect(res.status).toBe(404);
  });
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --run src/api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/api.ts src/api.test.ts
git commit -m "feat: add /api/vault/:type endpoints for vault content"
```

---

## Task 6: Frontend — API client + routes

**Files (in Obsidian repo):**
- Modify: `mini-app/src/api.ts`
- Modify: `mini-app/src/main.ts`

- [ ] **Step 1: Add vault types and methods to api.ts**

In `mini-app/src/api.ts`, add interfaces:

```typescript
export interface VaultItem {
  filename: string;
  title: string;
  badge: string | null;
  created: string | null;
}

export interface VaultItemDetail {
  frontmatter: Record<string, unknown>;
  content: string;
}
```

Add to the `api` object:

```typescript
  vaultList: (type: string) => fetchApi<VaultItem[]>(`/api/vault/${type}`),
  vaultItem: (type: string, filename: string) =>
    fetchApi<VaultItemDetail>(`/api/vault/${type}/${encodeURIComponent(filename)}`),
```

- [ ] **Step 2: Add routes in main.ts**

In `mini-app/src/main.ts`, add to the routes array:

```typescript
    { path: '/vault/:type', component: () => import('./views/VaultListView.vue') },
    { path: '/vault/:type/:filename', component: () => import('./views/VaultItemView.vue') },
```

- [ ] **Step 3: Commit**

```bash
cd /Users/alexandermykulych/repo/Memory_Obsidian
git add mini-app/src/api.ts mini-app/src/main.ts
git commit -m "feat: add vault API client and routes"
```

---

## Task 7: Frontend — VaultListView

**Files (in Obsidian repo):**
- Create: `mini-app/src/views/VaultListView.vue`

- [ ] **Step 1: Create VaultListView**

Create `mini-app/src/views/VaultListView.vue`:

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, type VaultItem } from '../api';

const route = useRoute();
const router = useRouter();
const type = route.params.type as string;
const items = ref<VaultItem[]>([]);
const loading = ref(true);

onMounted(async () => {
  try {
    items.value = await api.vaultList(type);
  } finally {
    loading.value = false;
  }
});

const badgeClass = (badge: string | null) => {
  if (!badge) return 'gray';
  const lower = badge.toLowerCase();
  if (lower === 'done') return 'green';
  if (lower.includes('approve')) return 'yellow';
  return 'gray';
};

const typeTitle = type.charAt(0).toUpperCase() + type.slice(1);
</script>

<template>
  <div>
    <h2 class="page-title">{{ typeTitle }}</h2>
    <div v-if="loading" class="loading">Loading...</div>
    <div v-else class="list">
      <div
        v-for="item in items"
        :key="item.filename"
        class="list-item"
        @click="router.push(`/vault/${type}/${encodeURIComponent(item.filename)}`)"
      >
        <div class="item-content">
          <div class="item-title">{{ item.title }}</div>
          <div v-if="item.created" class="item-date">{{ item.created }}</div>
        </div>
        <span v-if="item.badge" class="badge" :class="badgeClass(item.badge)">
          {{ item.badge }}
        </span>
      </div>
      <div v-if="items.length === 0" class="empty">No items</div>
    </div>
  </div>
</template>

<style scoped>
.page-title { font-size: 20px; font-weight: 700; margin-bottom: 16px; }
.list { display: flex; flex-direction: column; gap: 8px; }
.list-item {
  background: var(--secondary-bg);
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  transition: opacity 0.15s;
}
.list-item:active { opacity: 0.7; }
.item-content { flex: 1; min-width: 0; }
.item-title { font-weight: 500; font-size: 14px; }
.item-date { font-size: 11px; color: var(--hint-color); margin-top: 2px; }
.badge { font-size: 10px; padding: 2px 8px; border-radius: 8px; font-weight: 600; flex-shrink: 0; margin-left: 8px; }
.badge.green { background: #4ade8033; color: #4ade80; }
.badge.yellow { background: #fbbf2433; color: #fbbf24; }
.badge.gray { background: rgba(255,255,255,0.1); color: var(--hint-color); }
.loading, .empty { text-align: center; padding: 24px; color: var(--hint-color); }
</style>
```

- [ ] **Step 2: Commit**

```bash
cd /Users/alexandermykulych/repo/Memory_Obsidian
git add mini-app/src/views/VaultListView.vue
git commit -m "feat: add VaultListView with title and status badges"
```

---

## Task 8: Frontend — MarkdownRenderer component

**Files (in Obsidian repo):**
- Create: `mini-app/src/components/MarkdownRenderer.vue`

- [ ] **Step 1: Create MarkdownRenderer**

This component renders markdown with support for `vtable` code blocks as Vue components. It uses a two-pass approach: markdown-it renders to HTML, then we find vtable placeholders and render them as dynamic Vue components.

Create `mini-app/src/components/MarkdownRenderer.vue`:

```vue
<script setup lang="ts">
import { computed, h, defineComponent } from 'vue';
import MarkdownIt from 'markdown-it';
import { VTable } from 'obsidian-vtable/components';
import { parseVTableConfig } from 'obsidian-vtable/yaml-parser';

const props = defineProps<{ content: string }>();

const VTABLE_PLACEHOLDER = '<!--vtable:';
const VTABLE_END = ':vtable-->';

// Custom markdown-it plugin: replaces ```vtable blocks with placeholders
const vtablePlugin = (md: MarkdownIt) => {
  const defaultFence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token.info.trim() === 'vtable') {
      const encoded = encodeURIComponent(token.content);
      return `${VTABLE_PLACEHOLDER}${encoded}${VTABLE_END}`;
    }
    return defaultFence(tokens, idx, options, env, self);
  };
};

// Custom plugin for Obsidian callout blocks: > [!type] content
const calloutPlugin = (md: MarkdownIt) => {
  md.core.ruler.after('block', 'callout', (state) => {
    for (let i = 0; i < state.tokens.length; i++) {
      const token = state.tokens[i];
      if (token.type === 'blockquote_open') {
        // Look at the inline content of the first paragraph
        const nextInline = state.tokens[i + 2];
        if (nextInline?.type === 'inline' && nextInline.content) {
          const match = nextInline.content.match(/^\[!(\w+)\]\+?\s*(.*)/);
          if (match) {
            token.attrSet('class', `callout callout-${match[1]}`);
            nextInline.content = match[2] || '';
          }
        }
      }
    }
  });
};

const md = new MarkdownIt({ html: false, linkify: true, typographer: true });
md.use(vtablePlugin);
md.use(calloutPlugin);

// Dynamic component that renders HTML + vtable blocks
const RenderedContent = computed(() => {
  const html = md.render(props.content);

  // Split HTML by vtable placeholders
  const parts = html.split(new RegExp(`${VTABLE_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(.*?)${VTABLE_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'));

  if (parts.length === 1) {
    // No vtable blocks — simple HTML render
    return defineComponent({
      render() {
        return h('div', { innerHTML: html, class: 'markdown-body' });
      },
    });
  }

  // Build render tree: alternate HTML chunks and VTable components
  return defineComponent({
    setup() {
      const children: ReturnType<typeof h>[] = [];

      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0) {
          // HTML chunk
          if (parts[i].trim()) {
            children.push(h('div', { innerHTML: parts[i], class: 'markdown-body' }));
          }
        } else {
          // vtable YAML content
          try {
            const yamlContent = decodeURIComponent(parts[i]);
            const config = parseVTableConfig(yamlContent);
            children.push(
              h(VTable, { config, data: config.data || [] }),
            );
          } catch (err) {
            children.push(
              h('pre', { class: 'vtable-error' }, `vtable error: ${(err as Error).message}`),
            );
          }
        }
      }

      return () => h('div', { class: 'rendered-content' }, children);
    },
  });
});
</script>

<template>
  <component :is="RenderedContent" />
</template>

<style>
.markdown-body h1 { font-size: 22px; font-weight: 700; margin: 20px 0 12px; }
.markdown-body h2 { font-size: 18px; font-weight: 700; margin: 18px 0 10px; }
.markdown-body h3 { font-size: 15px; font-weight: 600; margin: 14px 0 8px; }
.markdown-body p { margin: 8px 0; line-height: 1.6; font-size: 14px; }
.markdown-body ul, .markdown-body ol { padding-left: 20px; margin: 8px 0; }
.markdown-body li { margin: 4px 0; font-size: 14px; line-height: 1.5; }
.markdown-body code { background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 4px; font-size: 13px; }
.markdown-body pre { background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px; overflow-x: auto; margin: 10px 0; }
.markdown-body pre code { background: none; padding: 0; }
.markdown-body a { color: var(--button-color); text-decoration: none; }
.markdown-body strong { font-weight: 600; }
.markdown-body hr { border: none; border-top: 1px solid rgba(255,255,255,0.1); margin: 16px 0; }
.markdown-body table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 13px; }
.markdown-body th, .markdown-body td { padding: 8px 10px; border: 1px solid rgba(255,255,255,0.1); text-align: left; }
.markdown-body th { background: rgba(255,255,255,0.05); font-weight: 600; }
.markdown-body blockquote { border-left: 3px solid var(--button-color); padding: 8px 12px; margin: 10px 0; opacity: 0.85; }
.callout { border-radius: 8px; padding: 10px 14px; margin: 10px 0; }
.callout-info { background: rgba(96, 165, 250, 0.1); border-left-color: #60a5fa; }
.callout-mao { background: rgba(74, 222, 128, 0.1); border-left-color: #4ade80; }
.vtable-error { color: #f87171; font-size: 12px; }
</style>
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/alexandermykulych/repo/Memory_Obsidian/mini-app && npm run build
```

Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
cd /Users/alexandermykulych/repo/Memory_Obsidian
git add mini-app/src/components/MarkdownRenderer.vue
git commit -m "feat: add MarkdownRenderer with markdown-it and vtable support"
```

---

## Task 9: Frontend — VaultItemView

**Files (in Obsidian repo):**
- Create: `mini-app/src/views/VaultItemView.vue`

- [ ] **Step 1: Create VaultItemView**

Create `mini-app/src/views/VaultItemView.vue`:

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { api, type VaultItemDetail } from '../api';
import MarkdownRenderer from '../components/MarkdownRenderer.vue';

const route = useRoute();
const type = route.params.type as string;
const filename = decodeURIComponent(route.params.filename as string);
const item = ref<VaultItemDetail | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    item.value = await api.vaultItem(type, filename);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
});

const title = ref('');
onMounted(() => {
  // Title will be set after item loads
});

import { watch } from 'vue';
watch(item, (val) => {
  if (val) {
    title.value =
      (val.frontmatter.section as string) ||
      (val.frontmatter.title as string) ||
      filename.replace(/\.md$/, '');
  }
});
</script>

<template>
  <div>
    <div v-if="loading" class="loading">Loading...</div>
    <div v-else-if="error" class="error-msg">{{ error }}</div>
    <template v-else-if="item">
      <div class="header">
        <h2 class="page-title">{{ title }}</h2>
        <span v-if="item.frontmatter.status" class="badge">
          {{ item.frontmatter.status }}
        </span>
      </div>
      <MarkdownRenderer :content="item.content" />
    </template>
  </div>
</template>

<style scoped>
.header { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 16px; }
.page-title { font-size: 20px; font-weight: 700; margin: 0; }
.badge { font-size: 10px; padding: 2px 8px; border-radius: 8px; font-weight: 600; background: rgba(255,255,255,0.1); color: var(--hint-color); flex-shrink: 0; margin-top: 4px; }
.loading, .error-msg { text-align: center; padding: 24px; color: var(--hint-color); }
.error-msg { color: #f87171; }
</style>
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/alexandermykulych/repo/Memory_Obsidian/mini-app && npm run build
```

Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
cd /Users/alexandermykulych/repo/Memory_Obsidian
git add mini-app/src/views/VaultItemView.vue
git commit -m "feat: add VaultItemView with markdown + vtable rendering"
```

---

## Task 10: Frontend — Researches DrillCard on HomeView

**Files (in Obsidian repo):**
- Modify: `mini-app/src/views/HomeView.vue`

- [ ] **Step 1: Add Researches DrillCard**

In `mini-app/src/views/HomeView.vue`, add a new DrillCard after "Scheduled Tasks" and before "Errors":

```vue
        <DrillCard
          icon="🔬"
          title="Researches"
          subtitle="Browse research notes"
          @tap="router.push('/vault/researches')"
        />
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/alexandermykulych/repo/Memory_Obsidian/mini-app && npm run build
```

Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
cd /Users/alexandermykulych/repo/Memory_Obsidian
git add mini-app/src/views/HomeView.vue
git commit -m "feat: add Researches DrillCard to HomeView"
```

---

## Task 11: Deploy and verify

- [ ] **Step 1: Push both repos**

```bash
# NanoClaw
cd /Users/alexandermykulych/repo/nanoclaw
git push

# Obsidian
cd /Users/alexandermykulych/repo/Memory_Obsidian
git push
```

- [ ] **Step 2: Deploy on server**

```bash
ssh root@159.69.207.195

# Pull NanoClaw backend
cd /workspace/project && git pull && npm run build
rm -rf data/sessions/*/agent-runner-src
systemctl restart nanoclaw

# Pull Obsidian repo and build mini-app
cd /workspace/extra/Memory_Obsidian && git pull
cd mini-app && npm install && npm run build
cp -r dist/* /var/www/mini-app/
```

- [ ] **Step 3: Verify API**

```bash
ssh root@159.69.207.195 "curl -s http://localhost:3847/api/vault/researches | head -200"
```

Expected: JSON array with research items (auth bypassed for localhost... actually it won't be bypassed since bot token is set). Test through Caddy or verify in the Mini App directly.

- [ ] **Step 4: Verify in Telegram**

Open Mini App → tap "Researches" → see list of research notes → tap one → see rendered content with vtable tables.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A && git commit -m "fix: address issues found during deployment"
```
