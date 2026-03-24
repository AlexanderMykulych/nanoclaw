import { insertTokenUsage } from './db.js';
import { logger } from './logger.js';

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
  'claude-haiku-3-5-20241022': { input: 0.8, output: 4 },
};

const DEFAULT_PRICING = { input: 3, output: 15 };

function getPricing(model: string): { input: number; output: number } {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key.split('-').slice(0, -1).join('-'))) return pricing;
  }
  return DEFAULT_PRICING;
}

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = getPricing(model);
  return (
    (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
  );
}

export interface RequestMeta {
  group: string | null;
  taskId: string | null;
}

export function parseMetaPrefix(url: string): {
  meta: RequestMeta;
  cleanPath: string;
} {
  const match = url.match(/^\/meta\/([^/]+)\/([^/]+)(\/.*)/);
  if (match) {
    return {
      meta: {
        group: decodeURIComponent(match[1]),
        taskId: match[2] === '_msg' ? null : decodeURIComponent(match[2]),
      },
      cleanPath: match[3],
    };
  }
  return { meta: { group: null, taskId: null }, cleanPath: url };
}

export function extractUsageFromJson(body: string): {
  model: string;
  inputTokens: number;
  outputTokens: number;
} | null {
  try {
    const data = JSON.parse(body);
    if (!data.usage) return null;
    return {
      model: data.model || 'unknown',
      inputTokens: data.usage.input_tokens || 0,
      outputTokens: data.usage.output_tokens || 0,
    };
  } catch {
    return null;
  }
}

export class SseUsageAccumulator {
  private buffer = '';
  private inputTokens = 0;
  private outputTokens = 0;
  private model = 'unknown';

  private chunkCount = 0;

  processChunk(chunk: string): void {
    this.chunkCount++;
    if (this.chunkCount <= 2) {
      logger.info({ chunkLen: chunk.length, first200: chunk.slice(0, 200) }, 'SSE raw chunk');
    }
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6).trim();
      if (jsonStr === '[DONE]') continue;
      try {
        const data = JSON.parse(jsonStr);
        if (data.type === 'message_start') {
          logger.info(
            { hasUsage: !!data.message?.usage, model: data.message?.model },
            'SSE message_start',
          );
          if (data.message?.usage) {
            this.inputTokens = data.message.usage.input_tokens || 0;
            this.model = data.message.model || this.model;
          }
        }
        if (data.type === 'message_delta') {
          logger.info(
            { hasUsage: !!data.usage, outputTokens: data.usage?.output_tokens },
            'SSE message_delta',
          );
          if (data.usage) {
            this.outputTokens = data.usage.output_tokens || 0;
          }
        }
      } catch {
        // Skip unparseable SSE lines
      }
    }
  }

  getResult(): {
    model: string;
    inputTokens: number;
    outputTokens: number;
  } | null {
    if (this.inputTokens === 0 && this.outputTokens === 0) return null;
    return {
      model: this.model,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    };
  }
}

export function logUsage(
  meta: RequestMeta,
  model: string,
  inputTokens: number,
  outputTokens: number,
): void {
  try {
    const cost = calculateCost(model, inputTokens, outputTokens);
    insertTokenUsage({
      group_folder: meta.group,
      task_id: meta.taskId,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: cost,
    });
    logger.info(
      { model, inputTokens, outputTokens, cost, ...meta },
      'Token usage logged',
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to log token usage');
  }
}
