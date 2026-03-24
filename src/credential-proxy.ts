/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

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

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        // Parse metadata prefix from URL and strip it for upstream
        const { meta, cleanPath } = parseMetaPrefix(req.url || '/');

        // Extract model from request body for usage attribution
        let requestModel = 'unknown';
        try {
          const reqData = JSON.parse(body.toString());
          if (reqData.model) requestModel = reqData.model;
        } catch {}

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];
        // Remove accept-encoding so upstream returns uncompressed responses
        // (needed for SSE usage tracking — we parse the plaintext stream)
        delete headers['accept-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
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
            const contentType = (upRes.headers['content-type'] || '') as string;
            const isMessages = cleanPath.includes('/v1/messages');
            const isJson = contentType.includes('application/json');
            const isSse = contentType.includes('text/event-stream');

            logger.info(
              {
                cleanPath,
                contentType,
                status: upRes.statusCode,
                isMessages,
                isJson,
                isSse,
              },
              'Proxy response routing',
            );

            res.writeHead(upRes.statusCode!, upRes.headers);

            if (isMessages && upRes.statusCode === 200 && isJson) {
              // Buffer JSON response, extract usage, then forward
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
              // Stream SSE through, accumulate usage
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
              // Pass through unchanged
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
          },
          'Credential proxy request',
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
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
