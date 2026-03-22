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

  if (filename.includes('..') || !filename.endsWith('.md')) return null;

  const filePath = path.join(vaultPath, typeConfig.path, filename);
  const resolvedDir = path.resolve(path.join(vaultPath, typeConfig.path));
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(resolvedDir)) return null;

  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf-8');
  return parseFrontmatter(raw);
}

export interface VaultTask {
  id: string;
  text: string;
  category: string | null;
  date: string | null;
  done: boolean;
  line: number;
}

export function listVaultTasks(vaultPath: string = OBSIDIAN_VAULT_PATH): VaultTask[] {
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
      .replace(/_\([^)]+\)_/, '')        // remove category
      .replace(/📅\s*[\d-]+(?:\s+\d+:\d+)?/, '')  // remove date
      .replace(/—\s*\[\[[^\]]*\]\](?:,\s*🗓️[^)]*)?/, '')  // remove source
      .replace(/—\s*🗓️[^\^]*/, '')       // remove calendar ref
      .replace(/\^[\w-]+\s*$/, '')        // remove block ref
      .replace(/\s+/g, ' ')
      .trim();

    tasks.push({ id, text, category, date, done, line: i });
  }

  return tasks;
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
