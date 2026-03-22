# Vault Viewer — Obsidian Researches in Mini App

**Date:** 2026-03-22
**Status:** Draft

## Problem

Obsidian research notes are only accessible via Obsidian app or SSH. No way to quickly browse and read them from Telegram.

## Solution

Add a "Researches" section to the Telegram Mini App. List view shows all researches with title and status badge. Tapping an item opens the full note rendered as rich HTML with support for custom `vtable` code blocks.

## Architecture

### What changes where

**NanoClaw repo (backend):**
- New `src/vault.ts` — vault file reading logic with type-based config
- Modified `src/api.ts` — two new endpoints
- Modified `src/config.ts` — `OBSIDIAN_VAULT_PATH`

**Obsidian repo (frontend):**
- `mini-app/` directory moves here from NanoClaw
- `mini-app/package.json` references vtable via `"obsidian-vtable": "file:../Memory/.obsidian/plugins/vtable"`
- New views: `VaultListView.vue`, `VaultItemView.vue`
- New markdown rendering with `markdown-it` + custom vtable plugin

### Repo structure after migration

```
Memory_Obsidian/
├── Memory/                              # Obsidian vault root
│   ├── .obsidian/plugins/vtable/        # Vue components (VTable, DataTable, BarChart)
│   │   ├── src/components/
│   │   │   ├── VTable.vue
│   │   │   ├── DataTable.vue
│   │   │   └── BarChart.vue
│   │   └── package.json
│   ├── onyx/research/                   # Research markdown files
│   └── ...
├── mini-app/                            # Telegram Mini App (outside vault)
│   ├── package.json                     # deps include "obsidian-vtable": "file:..."
│   ├── src/
│   │   ├── views/
│   │   │   ├── VaultListView.vue        # NEW
│   │   │   └── VaultItemView.vue        # NEW
│   │   ├── components/
│   │   │   └── MarkdownRenderer.vue     # NEW — markdown-it + vtable plugin
│   │   └── ...existing files...
│   └── ...
└── Scripts/
```

## Backend

### Vault type config (`src/vault.ts`)

```typescript
interface VaultTypeConfig {
  path: string;         // relative to OBSIDIAN_VAULT_PATH
  titleField: string;   // frontmatter field used as display title
  badgeField: string;   // frontmatter field used as status badge
}

const vaultTypes: Record<string, VaultTypeConfig> = {
  researches: {
    path: 'onyx/research',
    titleField: 'section',
    badgeField: 'status',
  },
  // extensible: add new types here later
};
```

### Functions

- `listVaultItems(type: string)` — reads directory, parses YAML frontmatter from each `.md` file, returns `Array<{ filename, title, badge, created }>` sorted by `created` descending
- `getVaultItem(type: string, filename: string)` — validates filename (no `..`, must end `.md`, must exist in type's directory), reads file, splits frontmatter from content, returns `{ frontmatter: Record<string, unknown>, content: string }`

### API endpoints (added to `src/api.ts`)

| Endpoint | Response | Source |
|---|---|---|
| `GET /api/vault/:type` | `[{ filename, title, badge, created }]` | `listVaultItems(type)` |
| `GET /api/vault/:type/:filename` | `{ frontmatter, content }` | `getVaultItem(type, filename)` |

Unknown type → 404. Invalid filename → 400.

### Config

`OBSIDIAN_VAULT_PATH` in `src/config.ts`, default `/workspace/extra/Memory_Obsidian/Memory`.

### Frontmatter parsing

Simple regex split on `---` delimiters + `js-yaml` for YAML parsing. No new dependency — use the `yaml` package already in NanoClaw's dependencies.

## Frontend

### vtable integration

In `mini-app/package.json`:
```json
{
  "dependencies": {
    "obsidian-vtable": "file:../Memory/.obsidian/plugins/vtable"
  }
}
```

The vtable plugin needs a components export. Add to vtable's `package.json`:
```json
{
  "exports": {
    ".": "./src/main.ts",
    "./components": "./src/components/index.ts"
  }
}
```

Create `Memory/.obsidian/plugins/vtable/src/components/index.ts`:
```typescript
export { default as VTable } from './VTable.vue';
export { default as DataTable } from './DataTable.vue';
export { default as BarChart } from './BarChart.vue';
```

Then in mini-app:
```typescript
import { VTable, DataTable, BarChart } from 'obsidian-vtable/components';
```

### Markdown rendering

**Library:** `markdown-it` — lightweight, extensible, well-maintained.

**Custom plugin** for `vtable` code blocks:
- Intercepts fenced code blocks with language `vtable`
- Parses YAML content (columns + data)
- Renders `<VTable>` Vue component instead of `<pre><code>`

**MarkdownRenderer.vue** component:
- Takes raw markdown string as prop
- Renders via `markdown-it` to HTML
- Post-processes `vtable` blocks into dynamic Vue components using `<component :is="...">`
- Also handles Obsidian callout syntax (`> [!info]`, `> [!mao]`) as styled blockquotes

### New views

**VaultListView.vue** (`/vault/:type`):
- Fetches `GET /api/vault/:type`
- Shows list of items with title (from `titleField`) and badge (from `badgeField`)
- Badge colors: `Done` → green, `to Approve` → yellow, others → gray
- Sorted by created date, newest first
- Tapping item navigates to `/vault/:type/:filename`

**VaultItemView.vue** (`/vault/:type/:filename`):
- Fetches `GET /api/vault/:type/:filename`
- Shows title from frontmatter at top
- Renders `content` through `MarkdownRenderer`
- Telegram BackButton to go back to list

### HomeView changes

Add DrillCard between "Scheduled Tasks" and "Errors":
```vue
<DrillCard
  icon="🔬"
  title="Researches"
  :subtitle="`${researchCount} items`"
  @tap="router.push('/vault/researches')"
/>
```

Research count fetched from `/api/vault/researches` (array length).

### New API types (`mini-app/src/api.ts`)

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

New api methods:
```typescript
vaultList: (type: string) => fetchApi<VaultItem[]>(`/api/vault/${type}`),
vaultItem: (type: string, filename: string) => fetchApi<VaultItemDetail>(`/api/vault/${type}/${filename}`),
```

## Migration

### Steps

1. Move `nanoclaw/mini-app/` → `Memory_Obsidian/mini-app/`
2. Remove `mini-app/` from NanoClaw repo
3. Add vtable components export (`index.ts`)
4. Update `mini-app/package.json` — add `obsidian-vtable` file dependency, add `markdown-it`
5. Update deploy — build mini-app from Obsidian repo instead of NanoClaw

### Deploy flow (updated)

```bash
# On server after git pull of both repos:
# 1. NanoClaw backend
cd /workspace/project && git pull && npm run build && systemctl restart nanoclaw

# 2. Mini App frontend (now from Obsidian repo)
cd /workspace/extra/Memory_Obsidian/mini-app && npm install && npm run build
cp -r dist/* /var/www/mini-app/
```

## Security

- Filename validation: reject `..`, path traversal, non-`.md` files
- Only configured vault types are accessible (unknown type → 404)
- Files read only from `OBSIDIAN_VAULT_PATH + type.path` — no access outside vault
- All endpoints behind existing Telegram initData auth

## Future (out of scope)

- More vault types (notes, ideas, interviews)
- Search across vault items
- Edit notes from Mini App
- Inline vault links (`[[note]]`) rendered as tappable navigation
