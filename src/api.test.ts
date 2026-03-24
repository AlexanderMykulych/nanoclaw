import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { _initTestDatabase, logError, logTaskRun, createTask } from './db.js';
import { GroupQueue } from './group-queue.js';

import { startApiServer } from './api.js';
import type { Server } from 'http';

// Bypass auth: mock readEnvFile so TELEGRAM_BOT_TOKEN is never returned,
// making botToken empty and skipping the auth check in api.ts
vi.mock('./env.js', () => ({
  readEnvFile: () => ({}),
}));

let server: Server;
let port: number;

beforeAll(async () => {
  _initTestDatabase();
  logError({ level: 'error', source: 'container', message: 'Test error' });

  // Seed parent task for FK constraint, then task run logs for stats tests
  createTask({
    id: 'obs-test-task',
    group_folder: 'test',
    chat_jid: 'test@test',
    prompt: 'test',
    schedule_type: 'interval',
    schedule_value: '1h',
    next_run: null,
    status: 'active',
    created_at: new Date().toISOString(),
  });
  logTaskRun({
    task_id: 'obs-test-task',
    run_at: new Date().toISOString(),
    duration_ms: 5000,
    status: 'success',
    result: 'ok',
    error: null,
  });
  logTaskRun({
    task_id: 'obs-test-task',
    run_at: new Date().toISOString(),
    duration_ms: 10000,
    status: 'success',
    result: 'ok',
    error: null,
  });
  logTaskRun({
    task_id: 'obs-test-task',
    run_at: new Date().toISOString(),
    duration_ms: 8000,
    status: 'error',
    result: null,
    error: 'timeout',
  });
  logTaskRun({
    task_id: 'obs-test-task',
    run_at: new Date().toISOString(),
    duration_ms: 0,
    status: 'skipped',
    result: null,
    error: null,
  });
  logTaskRun({
    task_id: 'obs-test-task',
    run_at: new Date().toISOString(),
    duration_ms: 7000,
    status: 'error',
    result: null,
    error: 'Failed to authenticate. API Error: Invalid bearer token',
  });

  const queue = new GroupQueue();
  server = await startApiServer(0, { queue, version: '1.0.0-test' });
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server?.close();
});

async function fetchApi(path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`);
}

describe('API endpoints', () => {
  it('GET /api/health returns health data', async () => {
    const res = await fetchApi('/api/health');
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.status).toMatch(/ok|warning|error/);
    expect(data.version).toBe('1.0.0-test');
    expect(typeof data.uptime).toBe('number');
  });

  it('GET /api/errors returns error list', async () => {
    const res = await fetchApi('/api/errors');
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data[0].message).toBe('Test error');
  });

  it('GET /api/tasks returns tasks array', async () => {
    const res = await fetchApi('/api/tasks');
    expect(res.status).toBe(200);
    const data = (await res.json()) as unknown[];
    expect(Array.isArray(data)).toBe(true);
  });

  it('GET /api/groups returns groups array', async () => {
    const res = await fetchApi('/api/groups');
    expect(res.status).toBe(200);
    const data = (await res.json()) as unknown[];
    expect(Array.isArray(data)).toBe(true);
  });

  it('GET /unknown returns 404', async () => {
    const res = await fetchApi('/api/unknown');
    expect(res.status).toBe(404);
  });

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

  it('GET /api/tasks/stats returns correct aggregated data', async () => {
    const res = await fetchApi('/api/tasks/stats');
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(data)).toBe(true);
    const task = data.find((t) => t.task_id === 'obs-test-task');
    expect(task).toBeDefined();
    expect(task!.total_runs).toBe(5);
    expect(task!.success_count).toBe(2);
    expect(task!.error_count).toBe(1); // only real errors, not auth
    expect(task!.skipped_count).toBe(1);
    expect(task!.auth_error_count).toBe(1); // auth error filtered out
    // avg/max/min based on success runs only (5000, 10000)
    expect(task!.avg_duration_ms).toBeCloseTo(7500, -2);
    expect(task!.max_duration_ms).toBe(10000);
    expect(task!.min_duration_ms).toBe(5000);
    // success_rate = 2 / (2 + 1) = 66.7% (auth errors excluded from denominator)
    expect(task!.success_rate).toBeCloseTo(66.7, 0);
    // precheck_saved_pct = 1 skipped / 5 total = 20%
    expect(task!.precheck_saved_pct).toBe(20);
  });

  it('GET /api/tasks/stats clamps days param', async () => {
    const res = await fetchApi('/api/tasks/stats?days=999');
    expect(res.status).toBe(200);
    const data = (await res.json()) as unknown[];
    expect(Array.isArray(data)).toBe(true);
  });

  it('GET /api/tasks/obs-test-task/timeline returns hourly buckets', async () => {
    const res = await fetchApi('/api/tasks/obs-test-task/timeline');
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);
    expect(data[0].status).toBe('error');
    expect(typeof data[0].duration_ms).toBe('number');
  });
});
