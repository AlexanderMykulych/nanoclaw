/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Proxy injects Bearer token. On 401 (expired),
 *             automatically refreshes via platform.claude.com
 *             and retries the request.
 */
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import * as fs from 'fs';
import * as path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  parseMetaPrefix,
  extractUsageFromJson,
  SseUsageAccumulator,
  logUsage,
} from './usage-tracker.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

/** Latest rate limit info captured from Anthropic API response headers. */
export interface RateLimitInfo {
  requestsLimit: number | null;
  requestsRemaining: number | null;
  requestsReset: string | null;
  tokensLimit: number | null;
  tokensRemaining: number | null;
  tokensReset: string | null;
  updatedAt: string;
}

let latestRateLimits: RateLimitInfo | null = null;

function captureRateLimitHeaders(headers: Record<string, string | string[] | undefined>): void {
  const get = (name: string): string | null => {
    const v = headers[name];
    return typeof v === 'string' ? v : null;
  };

  const hasAny = get('x-ratelimit-limit-requests') || get('x-ratelimit-limit-tokens');
  if (!hasAny) return;

  latestRateLimits = {
    requestsLimit: parseInt(get('x-ratelimit-limit-requests') || '', 10) || null,
    requestsRemaining: parseInt(get('x-ratelimit-remaining-requests') || '', 10) || null,
    requestsReset: get('x-ratelimit-reset-requests'),
    tokensLimit: parseInt(get('x-ratelimit-limit-tokens') || '', 10) || null,
    tokensRemaining: parseInt(get('x-ratelimit-remaining-tokens') || '', 10) || null,
    tokensReset: get('x-ratelimit-reset-tokens'),
    updatedAt: new Date().toISOString(),
  };
}

export function getLatestRateLimits(): RateLimitInfo | null {
  return latestRateLimits;
}

const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** Mutable token state — updated in-place on refresh. */
interface TokenState {
  accessToken: string;
  refreshToken: string;
  refreshing: Promise<boolean> | null;
}

async function refreshOAuthToken(state: TokenState): Promise<boolean> {
  // Deduplicate concurrent refresh attempts
  if (state.refreshing) return state.refreshing;

  state.refreshing = (async () => {
    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: state.refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }).toString();

      const data = await new Promise<string>((resolve, reject) => {
        const req = httpsRequest(
          OAUTH_TOKEN_URL,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': Buffer.byteLength(body),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString()));
          },
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      const resp = JSON.parse(data);
      if (!resp.access_token) {
        logger.error(
          { response: data.slice(0, 300) },
          'OAuth refresh failed: no access_token',
        );
        return false;
      }

      const newAccess = resp.access_token as string;
      const newRefresh = (resp.refresh_token as string) || state.refreshToken;

      // Update in-memory state
      state.accessToken = newAccess;
      state.refreshToken = newRefresh;

      // Persist to .env
      try {
        const envPath = path.join(process.cwd(), '.env');
        let envContent = fs.readFileSync(envPath, 'utf-8');
        envContent = envContent.replace(
          /^CLAUDE_CODE_OAUTH_TOKEN=.*/m,
          `CLAUDE_CODE_OAUTH_TOKEN=${newAccess}`,
        );
        if (envContent.includes('CLAUDE_CODE_REFRESH_TOKEN=')) {
          envContent = envContent.replace(
            /^CLAUDE_CODE_REFRESH_TOKEN=.*/m,
            `CLAUDE_CODE_REFRESH_TOKEN=${newRefresh}`,
          );
        }
        fs.writeFileSync(envPath, envContent);
      } catch (err) {
        logger.warn({ err }, 'Failed to update .env with refreshed token');
      }

      // Persist to all session .credentials.json files
      try {
        const sessionsDir = path.resolve('data/sessions');
        if (fs.existsSync(sessionsDir)) {
          for (const dir of fs.readdirSync(sessionsDir)) {
            const credPath = path.join(
              sessionsDir,
              dir,
              '.claude',
              '.credentials.json',
            );
            if (fs.existsSync(credPath)) {
              const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
              if (creds.claudeAiOauth) {
                creds.claudeAiOauth.accessToken = newAccess;
                creds.claudeAiOauth.refreshToken = newRefresh;
                creds.claudeAiOauth.expiresAt =
                  Date.now() + (resp.expires_in || 3600) * 1000;
                fs.writeFileSync(credPath, JSON.stringify(creds));
              }
            }
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to update .credentials.json files');
      }

      logger.info('OAuth token refreshed successfully');
      return true;
    } catch (err) {
      logger.error({ err }, 'OAuth refresh request failed');
      return false;
    }
  })();

  try {
    return await state.refreshing;
  } finally {
    state.refreshing = null;
  }
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_REFRESH_TOKEN',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';

  const tokenState: TokenState = {
    accessToken:
      secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN || '',
    refreshToken: secrets.CLAUDE_CODE_REFRESH_TOKEN || '',
    refreshing: null,
  };

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  function forwardRequest(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
    cleanPath: string,
    meta: ReturnType<typeof parseMetaPrefix>['meta'],
    requestModel: string,
    isRetry: boolean,
  ): void {
    const headers: Record<string, string | number | string[] | undefined> = {
      ...(req.headers as Record<string, string>),
      host: upstreamUrl.host,
      'content-length': body.length,
    };

    delete headers['connection'];
    delete headers['keep-alive'];
    delete headers['transfer-encoding'];
    delete headers['accept-encoding'];

    if (authMode === 'api-key') {
      delete headers['x-api-key'];
      headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
    } else {
      if (headers['authorization']) {
        delete headers['authorization'];
        if (tokenState.accessToken) {
          headers['authorization'] = `Bearer ${tokenState.accessToken}`;
        }
      }
    }

    const upstream = makeRequest(
      {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (isHttps ? 443 : 80),
        path: cleanPath,
        method: req.method,
        headers,
      } as RequestOptions,
      (upRes) => {
        // Auto-refresh on 401 in OAuth mode (once per request)
        if (
          upRes.statusCode === 401 &&
          authMode === 'oauth' &&
          tokenState.refreshToken &&
          !isRetry
        ) {
          // Consume the error response before retrying
          const errChunks: Buffer[] = [];
          upRes.on('data', (c: Buffer) => errChunks.push(c));
          upRes.on('end', () => {
            const errBody = Buffer.concat(errChunks).toString();
            logger.info(
              { status: 401, body: errBody.slice(0, 200) },
              'Got 401, attempting token refresh',
            );
            refreshOAuthToken(tokenState).then((ok) => {
              if (ok) {
                forwardRequest(
                  req,
                  res,
                  body,
                  cleanPath,
                  meta,
                  requestModel,
                  true,
                );
              } else {
                // Refresh failed — forward original 401
                if (!res.headersSent) {
                  res.writeHead(401, { 'content-type': 'application/json' });
                }
                res.end(errBody);
              }
            });
          });
          return;
        }

        const contentType = (upRes.headers['content-type'] || '') as string;
        const isMessages = cleanPath.includes('/v1/messages');
        const isJson = contentType.includes('application/json');
        const isSse = contentType.includes('text/event-stream');

        captureRateLimitHeaders(upRes.headers as Record<string, string | string[] | undefined>);

        res.writeHead(upRes.statusCode!, upRes.headers);

        if (isMessages && upRes.statusCode === 200 && isJson) {
          const resChunks: Buffer[] = [];
          upRes.on('data', (c: Buffer) => resChunks.push(c));
          upRes.on('end', () => {
            const resBody = Buffer.concat(resChunks);
            res.end(resBody);
            const usage = extractUsageFromJson(resBody.toString());
            if (usage) {
              logUsage(
                meta,
                usage.model || requestModel,
                usage.inputTokens,
                usage.outputTokens,
              );
            }
          });
        } else if (isMessages && upRes.statusCode === 200 && isSse) {
          const acc = new SseUsageAccumulator();
          upRes.on('data', (chunk: Buffer) => {
            res.write(chunk);
            acc.processChunk(chunk.toString());
          });
          upRes.on('end', () => {
            res.end();
            const usage = acc.getResult();
            logger.info({ usage, hasResult: !!usage }, 'SSE stream ended');
            if (usage) {
              logUsage(
                meta,
                usage.model || requestModel,
                usage.inputTokens,
                usage.outputTokens,
              );
            }
          });
        } else {
          upRes.pipe(res);
        }
      },
    );

    logger.info(
      {
        method: req.method,
        url: cleanPath,
        hasAuth: !!headers['authorization'],
        hasApiKey: !!headers['x-api-key'],
        isRetry,
      },
      'Credential proxy request',
    );

    upstream.on('error', (err) => {
      logger.error({ err, url: req.url }, 'Credential proxy upstream error');
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('Bad Gateway');
      }
    });

    upstream.write(body);
    upstream.end();
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const { meta, cleanPath } = parseMetaPrefix(req.url || '/');

        let requestModel = 'unknown';
        try {
          const reqData = JSON.parse(body.toString());
          if (reqData.model) requestModel = reqData.model;
        } catch {}

        forwardRequest(req, res, body, cleanPath, meta, requestModel, false);
      });
    });

    server.listen(port, host, () => {
      logger.info(
        { port, host, authMode, hasRefreshToken: !!tokenState.refreshToken },
        'Credential proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
