# Note Editing in Telegram Mini App

## Summary

Add the ability to edit existing notes (body text + all frontmatter fields) from the Telegram mini app. Currently notes can only be created and viewed — this feature closes the loop by enabling full editing.

## Scope

- Edit **only** `notes` vault type (not researches or other types)
- Edit body text, sphere, tags, and other frontmatter fields
- No delete functionality
- Simple textarea editor (no WYSIWYG, no markdown preview)

## Architecture

### Backend

#### 1. New function: `updateVaultNote` in `src/vault.ts`

```ts
updateVaultNote(
  filename: string,
  updates: { text?: string; frontmatter?: Record<string, unknown> },
  vaultPath?: string
): { ok: true } | { ok: false; error: string }
```

- Reads existing file, merges updated frontmatter fields over existing ones (preserves `date`, `time`, `needs_ai_format` etc. if not explicitly passed)
- Overwrites body text if `text` is provided
- Validates: sphere must be from `VALID_SPHERES`, filename without `..`, only `.md` files
- Path traversal protection (same as existing `getVaultItem`)
- Hardcoded to `notes/` directory — not a generic vault update

#### 2. New API endpoint in `src/api.ts`

`PUT /api/vault/notes/:filename`

- Auth: Telegram initData (same as all vault endpoints)
- Request body:
  ```json
  {
    "text": "updated note text",
    "frontmatter": {
      "sphere": "робота",
      "tags": ["note", "important"]
    }
  }
  ```
- Response: `{ "ok": true }` (200) or `{ "error": "..." }` (400/404)
- Placed next to existing `POST /api/vault/notes` for creation

### Frontend

All frontend changes are in `/Users/alexandermykulych/repo/Memory_Obsidian/mini-app/`.

#### 3. New API method in `src/api.ts`

```ts
updateNote: (filename: string, text: string, frontmatter: Record<string, unknown>) =>
  fetchApi<{ ok: boolean }>(`/api/vault/notes/${encodeURIComponent(filename)}`, {
    method: 'PUT',
    body: JSON.stringify({ text, frontmatter }),
  }),
```

#### 4. New component: `NoteEditView.vue`

- Route: `/notes/:filename/edit`
- On mount: loads note via `api.vaultItem('notes', filename)`, populates form
- Form fields:
  - Sphere selector (4 buttons, same style as `NoteCreateView`)
  - Tags text input (comma-separated)
  - Textarea for body text
  - Other frontmatter fields displayed as readonly key:value list
- Save button: calls `api.updateNote()` → haptic feedback → `router.back()`

#### 5. Edit button on `VaultItemView.vue`

- "Редагувати" button added to `VaultItemView`
- Navigates to `/notes/${filename}/edit`
- Only shown when `type === 'notes'`

#### 6. Route in `main.ts`

```ts
{ path: '/notes/:filename/edit', component: () => import('./views/NoteEditView.vue') }
```

Telegram BackButton already handles nested routes — no additional changes needed.

## User Flow

1. Notes list → tap note → VaultItemView (read-only)
2. "Редагувати" button → NoteEditView (form pre-filled with current data)
3. Edit fields → "Зберегти" → PUT request → back to VaultItemView

## Files Changed

| File | Repo | Change |
|------|------|--------|
| `src/vault.ts` | nanoclaw | Add `updateVaultNote()` |
| `src/api.ts` | nanoclaw | Add `PUT /api/vault/notes/:filename` endpoint |
| `mini-app/src/api.ts` | Memory_Obsidian | Add `updateNote()` method |
| `mini-app/src/views/NoteEditView.vue` | Memory_Obsidian | New component |
| `mini-app/src/views/VaultItemView.vue` | Memory_Obsidian | Add edit button (notes only) |
| `mini-app/src/main.ts` | Memory_Obsidian | Add edit route |
