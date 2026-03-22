import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { _initTestDatabase, logError } from './db.js';
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
});
