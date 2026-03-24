import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { logger } from './logger.js';
import { validateTelegramInitData } from './api-auth.js';
import {
  getRegisteredGroupsList,
  getScheduledTasks,
  getTaskRunLogs,
  getTaskStats,
  getTaskTimeline,
  getErrors,
  getErrorCountSince,
  getMetrics,
} from './db.js';
import type { GroupQueue } from './group-queue.js';
import { readEnvFile } from './env.js';
import {
  listVaultItems,
  getVaultItem,
  listVaultTasks,
  toggleVaultTask,
  updateVaultItemStatus,
  createVaultNote,
} from './vault.js';
import type { NoteSphere } from './vault.js';

interface ApiDeps {
  queue: GroupQueue;
  version: string;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Telegram-Web-App-Init-Data, Content-Type',
  });
  res.end(JSON.stringify(data));
}

function parseUrl(url: string): { path: string; params: URLSearchParams } {
  const parsed = new URL(url, 'http://localhost');
  return { path: parsed.pathname, params: parsed.searchParams };
}

export function startApiServer(port: number, deps: ApiDeps): Promise<Server> {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const botToken =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';

  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers':
            'Telegram-Web-App-Init-Data, Content-Type',
        });
        res.end();
        return;
      }

      const { path, params } = parseUrl(req.url || '/');

      // Auth check — accept from query param or header
      const initData =
        params.get('_auth') ||
        (req.headers['telegram-web-app-init-data'] as string) ||
        '';
      if (botToken && !validateTelegramInitData(initData, botToken)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }

      try {
        if (path === '/api/health') {
          const queueStatus = deps.queue.getStatus();
          const errorsLastHour = getErrorCountSince(60);
          let status: 'ok' | 'warning' | 'error' = 'ok';
          if (errorsLastHour > 0) status = 'warning';
          const recentErrors = getErrors({ limit: 10, offset: 0 });
          const hasCritical = recentErrors.some(
            (e) =>
              e.source === 'container' &&
              e.timestamp > new Date(Date.now() - 3600000).toISOString(),
          );
          if (hasCritical) status = 'error';

          sendJson(res, 200, {
            status,
            uptime: process.uptime(),
            version: deps.version,
            groups_count: getRegisteredGroupsList().length,
            tasks_count: getScheduledTasks().length,
            errors_last_hour: errorsLastHour,
            active_containers: queueStatus.activeCount,
            queued_containers: queueStatus.queuedCount,
          });
        } else if (path === '/api/groups') {
          const groups = getRegisteredGroupsList();
          const queueStatus = deps.queue.getStatus();
          const activeJids = new Set(queueStatus.containers.map((c) => c.jid));
          const result = groups.map((g) => ({
            jid: g.jid,
            name: g.name,
            folder: g.folder,
            last_message_time: g.last_message_time,
            has_active_container: activeJids.has(g.jid),
          }));
          sendJson(res, 200, result);
        } else if (path === '/api/tasks') {
          sendJson(res, 200, getScheduledTasks());
        } else if (path === '/api/tasks/stats') {
          const days = Math.max(1, Math.min(30, parseInt(params.get('days') || '7', 10) || 7));
          sendJson(res, 200, getTaskStats(days));
        } else if (path.match(/^\/api\/tasks\/[^/]+\/timeline$/)) {
          const taskId = path.split('/')[3];
          const days = Math.max(1, Math.min(30, parseInt(params.get('days') || '7', 10) || 7));
          sendJson(res, 200, getTaskTimeline(taskId, days));
        } else if (path.match(/^\/api\/tasks\/[^/]+\/logs$/)) {
          const taskId = path.split('/')[3];
          sendJson(res, 200, getTaskRunLogs(taskId));
        } else if (path === '/api/containers') {
          const queueStatus = deps.queue.getStatus();
          sendJson(res, 200, queueStatus);
        } else if (path === '/api/metrics') {
          const hours = parseInt(params.get('hours') || '24', 10);
          sendJson(res, 200, getMetrics(Math.min(hours, 72)));
        } else if (path === '/api/errors') {
          const limit = parseInt(params.get('limit') || '50', 10);
          const offset = parseInt(params.get('offset') || '0', 10);
          sendJson(res, 200, getErrors({ limit, offset }));
        } else if (path === '/api/vault/notes' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString()) as {
                text: string;
                sphere?: NoteSphere;
              };
              const result = createVaultNote(body.text, body.sphere);
              if (result.ok) {
                sendJson(res, 201, result);
              } else {
                sendJson(res, 400, { error: result.error });
              }
            } catch {
              sendJson(res, 400, { error: 'Invalid request body' });
            }
          });
          return;
        } else if (path === '/api/vault/tasks') {
          sendJson(res, 200, listVaultTasks());
        } else if (
          path.match(/^\/api\/vault\/tasks\/[^/]+\/toggle$/) &&
          req.method === 'POST'
        ) {
          const taskId = path.split('/')[4];
          // Read POST body
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString()) as {
                done: boolean;
              };
              const success = toggleVaultTask(taskId, body.done);
              if (success) {
                sendJson(res, 200, { ok: true });
              } else {
                sendJson(res, 404, { error: 'Task not found' });
              }
            } catch {
              sendJson(res, 400, { error: 'Invalid request body' });
            }
          });
          return; // Don't fall through — we're handling async
        } else if (
          path.match(/^\/api\/vault\/[^/]+\/[^/]+\/status$/) &&
          req.method === 'POST'
        ) {
          const parts = path.split('/');
          const type = parts[3];
          const filename = decodeURIComponent(parts[4]);
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString()) as {
                status: string;
              };
              const success = updateVaultItemStatus(
                type,
                filename,
                body.status,
              );
              if (success) {
                sendJson(res, 200, { ok: true });
              } else {
                sendJson(res, 404, { error: 'Not found' });
              }
            } catch {
              sendJson(res, 400, { error: 'Invalid request body' });
            }
          });
          return;
        } else if (path.match(/^\/api\/vault\/[^/]+$/) && !path.endsWith('/')) {
          const type = path.split('/')[3];
          const items = listVaultItems(type);
          if (items === null) {
            sendJson(res, 404, { error: `Unknown vault type: ${type}` });
          } else {
            sendJson(res, 200, items);
          }
        } else if (path.match(/^\/api\/vault\/[^/]+\/[^/]+$/)) {
          const parts = path.split('/');
          const type = parts[3];
          const filename = decodeURIComponent(parts[4]);
          const item = getVaultItem(type, filename);
          if (item === null) {
            sendJson(res, 404, { error: 'Not found' });
          } else {
            sendJson(res, 200, item);
          }
        } else {
          sendJson(res, 404, { error: 'Not found' });
        }
      } catch (err) {
        logger.error({ err, path }, 'API request error');
        sendJson(res, 500, { error: 'Internal server error' });
      }
    });

    server.listen(port, '127.0.0.1', () => {
      logger.info({ port }, 'API server started');
      resolve(server);
    });

    server.on('error', reject);
  });
}
