import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { logger } from './logger.js';
import { validateTelegramInitData } from './api-auth.js';
import {
  getRegisteredGroupsList,
  getScheduledTasks,
  getTaskRunLogs,
  getErrors,
  getErrorCountSince,
} from './db.js';
import type { GroupQueue } from './group-queue.js';
import { readEnvFile } from './env.js';

interface ApiDeps {
  queue: GroupQueue;
  version: string;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Telegram-Web-App-Init-Data',
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
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Telegram-Web-App-Init-Data',
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
        } else if (path.match(/^\/api\/tasks\/[^/]+\/logs$/)) {
          const taskId = path.split('/')[3];
          sendJson(res, 200, getTaskRunLogs(taskId));
        } else if (path === '/api/errors') {
          const limit = parseInt(params.get('limit') || '50', 10);
          const offset = parseInt(params.get('offset') || '0', 10);
          sendJson(res, 200, getErrors({ limit, offset }));
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
