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
  notes: {
    path: 'notes',
    titleField: '',
    badgeField: 'sphere',
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

function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  content: string;
} {
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
      if (!a.created && !b.created)
        return b.filename.localeCompare(a.filename);
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

  if (filename.includes('..') || !filename.endsWith('.md')) return null;

  const filePath = path.join(vaultPath, typeConfig.path, filename);
  const resolvedDir = path.resolve(path.join(vaultPath, typeConfig.path));
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(resolvedDir)) return null;

  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf-8');
  return parseFrontmatter(raw);
}

export function updateVaultItemStatus(
  type: string,
  filename: string,
  newStatus: string,
  vaultPath: string = OBSIDIAN_VAULT_PATH,
): boolean {
  const typeConfig = VAULT_TYPES[type];
  if (!typeConfig) return false;

  if (filename.includes('..') || !filename.endsWith('.md')) return false;

  const filePath = path.join(vaultPath, typeConfig.path, filename);
  const resolvedDir = path.resolve(path.join(vaultPath, typeConfig.path));
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(resolvedDir)) return false;

  if (!fs.existsSync(filePath)) return false;

  const raw = fs.readFileSync(filePath, 'utf-8');
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return false;

  const updated = raw.replace(
    /^(---\n[\s\S]*?)(status:\s*).+/m,
    `$1$2${newStatus}`,
  );

  if (updated === raw) return false;
  fs.writeFileSync(filePath, updated, 'utf-8');
  return true;
}

export interface VaultTask {
  id: string;
  text: string;
  category: string | null;
  date: string | null;
  done: boolean;
  line: number;
}

export function listVaultTasks(
  vaultPath: string = OBSIDIAN_VAULT_PATH,
): VaultTask[] {
  const filePath = path.join(vaultPath, 'tasks.md');
  if (!fs.existsSync(filePath)) return [];

  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  const tasks: VaultTask[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^- \[([ x])\] (.+)/);
    if (!match) continue;

    const done = match[1] === 'x';
    const content = match[2];

    // Extract block reference as ID
    const idMatch = content.match(/\^([\w-]+)\s*$/);
    const id = idMatch ? idMatch[1] : `line-${i}`;

    // Extract category from _(category)_
    const catMatch = content.match(/_\(([^)]+)\)_/);
    const category = catMatch ? catMatch[1] : null;

    // Extract date after 📅
    const dateMatch = content.match(/📅\s*([\d-]+(?:\s+\d+:\d+)?)/);
    const date = dateMatch ? dateMatch[1].trim() : null;

    // Clean text: remove category, date, source links, block ref
    let text = content
      .replace(/_\([^)]+\)_/, '') // remove category
      .replace(/📅\s*[\d-]+(?:\s+\d+:\d+)?/, '') // remove date
      .replace(/—\s*\[\[[^\]]*\]\](?:,\s*🗓️[^)]*)?/, '') // remove source
      .replace(/—\s*🗓️[^\^]*/, '') // remove calendar ref
      .replace(/\^[\w-]+\s*$/, '') // remove block ref
      .replace(/\s+/g, ' ')
      .trim();

    tasks.push({ id, text, category, date, done, line: i });
  }

  return tasks;
}

const VALID_SPHERES = ['робота', 'дім', "сім'я", 'інше'] as const;
export type NoteSphere = (typeof VALID_SPHERES)[number];

export function createVaultNote(
  text: string,
  sphere: NoteSphere = 'інше',
  vaultPath: string = OBSIDIAN_VAULT_PATH,
): { ok: true; filename: string } | { ok: false; error: string } {
  if (!text.trim()) return { ok: false, error: 'Text is required' };
  if (!VALID_SPHERES.includes(sphere)) {
    return { ok: false, error: `Invalid sphere: ${sphere}` };
  }

  const notesDir = path.join(vaultPath, 'notes');
  if (!fs.existsSync(notesDir)) {
    fs.mkdirSync(notesDir, { recursive: true });
  }

  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const time = `${hours}:${minutes}`;
  const filename = `${date} ${hours}-${minutes}.md`;

  // If file already exists (same minute), append seconds
  let finalFilename = filename;
  if (fs.existsSync(path.join(notesDir, finalFilename))) {
    const seconds = String(now.getSeconds()).padStart(2, '0');
    finalFilename = `${date} ${hours}-${minutes}-${seconds}.md`;
  }

  const content = `---
date: ${date}
time: "${time}"
sphere: ${sphere}
tags:
  - note
needs_ai_format: true
---

${text.trim()}
`;

  fs.writeFileSync(path.join(notesDir, finalFilename), content, 'utf-8');
  return { ok: true, filename: finalFilename };
}

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
      return {
        ok: false,
        error: `Invalid sphere: ${updates.frontmatter.sphere}`,
      };
    }
    Object.assign(mergedFrontmatter, updates.frontmatter);
  }

  const body =
    updates.text !== undefined ? updates.text.trim() : parsed.content.trim();
  const yamlStr = YAML.stringify(mergedFrontmatter).trimEnd();
  const newContent = `---\n${yamlStr}\n---\n\n${body}\n`;

  fs.writeFileSync(filePath, newContent, 'utf-8');
  return { ok: true };
}

export function toggleVaultTask(
  taskId: string,
  done: boolean,
  vaultPath: string = OBSIDIAN_VAULT_PATH,
): boolean {
  const filePath = path.join(vaultPath, 'tasks.md');
  if (!fs.existsSync(filePath)) return false;

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  // Find line with this task ID
  const lineIndex = lines.findIndex((line) => line.includes(`^${taskId}`));
  if (lineIndex === -1) return false;

  const line = lines[lineIndex];
  if (done) {
    lines[lineIndex] = line.replace('- [ ]', '- [x]');
  } else {
    lines[lineIndex] = line.replace('- [x]', '- [ ]');
  }

  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return true;
}
