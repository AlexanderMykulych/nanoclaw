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

  if (filename.includes('..') || !filename.endsWith('.md')) return null;

  const filePath = path.join(vaultPath, typeConfig.path, filename);
  const resolvedDir = path.resolve(path.join(vaultPath, typeConfig.path));
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(resolvedDir)) return null;

  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf-8');
  return parseFrontmatter(raw);
}
