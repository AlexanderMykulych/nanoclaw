import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { listVaultItems, getVaultItem, listVaultTasks, toggleVaultTask } from './vault.js';

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
    expect(
      getVaultItem('researches', '../../../etc/passwd', testVaultDir),
    ).toBeNull();
  });

  it('rejects non-md files', () => {
    expect(getVaultItem('researches', 'file.txt', testVaultDir)).toBeNull();
  });

  it('returns null for nonexistent file', () => {
    expect(
      getVaultItem('researches', 'nonexistent.md', testVaultDir),
    ).toBeNull();
  });
});

describe('vault tasks', () => {
  let taskVaultDir: string;

  beforeAll(() => {
    taskVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-task-test-'));
    fs.writeFileSync(
      path.join(taskVaultDir, 'tasks.md'),
      `---
updated: 2026-03-14
---

## Задачі

- [x] Completed task _(work)_ 📅 2026-03-16 — [[source]] ^task-001
- [ ] Open task _(home)_ 📅 2026-03-20 — [[source]] ^task-002
- [ ] No category task ^task-003
`,
    );
  });

  afterAll(() => {
    fs.rmSync(taskVaultDir, { recursive: true, force: true });
  });

  it('lists tasks with parsed fields', () => {
    const tasks = listVaultTasks(taskVaultDir);
    expect(tasks).toHaveLength(3);

    expect(tasks[0].id).toBe('task-001');
    expect(tasks[0].done).toBe(true);
    expect(tasks[0].category).toBe('work');
    expect(tasks[0].date).toBe('2026-03-16');

    expect(tasks[1].id).toBe('task-002');
    expect(tasks[1].done).toBe(false);
    expect(tasks[1].category).toBe('home');
  });

  it('toggles task status', () => {
    const result = toggleVaultTask('task-002', true, taskVaultDir);
    expect(result).toBe(true);

    const tasks = listVaultTasks(taskVaultDir);
    const task = tasks.find((t) => t.id === 'task-002');
    expect(task!.done).toBe(true);

    // Toggle back
    toggleVaultTask('task-002', false, taskVaultDir);
    const tasks2 = listVaultTasks(taskVaultDir);
    expect(tasks2.find((t) => t.id === 'task-002')!.done).toBe(false);
  });

  it('returns false for nonexistent task', () => {
    expect(toggleVaultTask('nonexistent', true, taskVaultDir)).toBe(false);
  });
});
