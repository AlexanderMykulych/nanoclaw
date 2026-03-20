import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  runPreCheck,
  startSchedulerLoop,
} from './task-scheduler.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });
});

describe('runPreCheck', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'precheck-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns run: false when script outputs run: false', async () => {
    const scriptPath = path.join(tmpDir, 'check.sh');
    fs.writeFileSync(
      scriptPath,
      '#!/bin/bash\necho \'{"run": false, "reason": "nothing to do"}\'\n',
    );

    const result = await runPreCheck(scriptPath, tmpDir);

    expect(result.run).toBe(false);
    expect(result.reason).toBe('nothing to do');
  });

  it('returns run: true when script approves', async () => {
    const scriptPath = path.join(tmpDir, 'check.sh');
    fs.writeFileSync(
      scriptPath,
      '#!/bin/bash\necho \'{"run": true, "reason": "3 files found"}\'\n',
    );

    const result = await runPreCheck(scriptPath, tmpDir);

    expect(result.run).toBe(true);
    expect(result.reason).toBe('3 files found');
  });

  it('returns run: false when script does not exist', async () => {
    const result = await runPreCheck('/nonexistent/script.sh', '/tmp');

    expect(result.run).toBe(false);
    expect(result.reason).toMatch(/not found/i);
  });

  it('returns run: false when script exits with error', async () => {
    const scriptPath = path.join(tmpDir, 'fail.sh');
    fs.writeFileSync(scriptPath, '#!/bin/bash\nexit 1\n');

    const result = await runPreCheck(scriptPath, tmpDir);

    expect(result.run).toBe(false);
    expect(result.reason).toMatch(/error/i);
  });

  it('returns run: false when script outputs invalid JSON', async () => {
    const scriptPath = path.join(tmpDir, 'bad.sh');
    fs.writeFileSync(scriptPath, '#!/bin/bash\necho "not json"\n');

    const result = await runPreCheck(scriptPath, tmpDir);

    expect(result.run).toBe(false);
    expect(result.reason).toMatch(/invalid JSON/i);
  });

  it('passes vault root as $1 to the script', async () => {
    const scriptPath = path.join(tmpDir, 'echo-arg.sh');
    fs.writeFileSync(
      scriptPath,
      '#!/bin/bash\necho "{\\\"run\\\": true, \\\"reason\\\": \\\"vault=$1\\\"}"\n',
    );

    const result = await runPreCheck(scriptPath, '/my/vault');

    expect(result.run).toBe(true);
    expect(result.reason).toBe('vault=/my/vault');
  });

  it('runs .js files with node', async () => {
    const scriptPath = path.join(tmpDir, 'check.js');
    fs.writeFileSync(
      scriptPath,
      'console.log(JSON.stringify({ run: true, reason: "node works, vault=" + process.argv[2] }));\n',
    );

    const result = await runPreCheck(scriptPath, '/my/vault');

    expect(result.run).toBe(true);
    expect(result.reason).toBe('node works, vault=/my/vault');
  });
});
