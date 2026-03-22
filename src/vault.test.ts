import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { listVaultItems, getVaultItem } from './vault.js';

let testVaultDir: string;

beforeAll(() => {
  testVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
  const researchDir = path.join(testVaultDir, 'onyx/research');
  fs.mkdirSync(researchDir, { recursive: true });

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
`,
  );

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
    const full = items!.find((i) => i.filename === 'test-research.md');
    expect(full).toBeDefined();
    expect(full!.title).toBe('Test Research Title');
    expect(full!.badge).toBe('Done');
    expect(full!.created).toBe('2026-03-20');
  });

  it('handles files with missing title field gracefully', () => {
    const items = listVaultItems('researches', testVaultDir);
    const minimal = items!.find((i) => i.filename === 'minimal.md');
    expect(minimal).toBeDefined();
    expect(minimal!.title).toBe('minimal');
    expect(minimal!.badge).toBe('to Approve');
  });

  it('returns null for unknown type', () => {
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
    expect(item!.content).not.toContain('---');
  });

  it('rejects path traversal', () => {
    expect(getVaultItem('researches', '../../../etc/passwd', testVaultDir)).toBeNull();
  });

  it('rejects non-md files', () => {
    expect(getVaultItem('researches', 'file.txt', testVaultDir)).toBeNull();
  });

  it('returns null for nonexistent file', () => {
    expect(getVaultItem('researches', 'nonexistent.md', testVaultDir)).toBeNull();
  });
});
