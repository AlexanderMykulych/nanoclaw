/**
 * Perplexity Research MCP Server for NanoClaw
 * Provides research tools powered by Perplexity Sonar API with built-in web search.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const apiKey = process.env.PERPLEXITY_API_KEY!;
const defaultModel = process.env.PERPLEXITY_MODEL || 'sonar-pro';

interface PerplexityResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  citations?: string[];
}

async function callPerplexity(
  messages: Array<{ role: string; content: string }>,
  model: string,
): Promise<string> {
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Perplexity API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as PerplexityResponse;

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('No response from Perplexity');
  }

  let result = content;

  // Append citations if available
  if (data.citations && data.citations.length > 0) {
    result += '\n\n---\nSources:\n';
    for (const url of data.citations) {
      result += `- ${url}\n`;
    }
  }

  return result;
}

const server = new McpServer({
  name: 'perplexity',
  version: '1.0.0',
});

server.tool(
  'perplexity_research',
  'Deep research using Perplexity Sonar with built-in web search. Returns comprehensive answers with citations. Use this as the PRIMARY tool for any research, fact-checking, or questions requiring up-to-date information.',
  {
    query: z
      .string()
      .describe('Research question or topic to investigate'),
    context: z
      .string()
      .optional()
      .describe('Additional context or background for the research'),
    model: z
      .string()
      .optional()
      .describe(
        `Perplexity model (default: ${defaultModel}). Options: sonar (fast), sonar-pro (thorough), sonar-reasoning (with chain-of-thought)`,
      ),
  },
  async (args) => {
    console.error(`[perplexity-mcp] perplexity_research called: model=${args.model || defaultModel}, query="${args.query.slice(0, 100)}"`);
    const messages: Array<{ role: string; content: string }> = [];

    if (args.context) {
      messages.push({
        role: 'system',
        content: `Context: ${args.context}`,
      });
    }

    messages.push({
      role: 'user',
      content: args.query,
    });

    const model = args.model || defaultModel;
    const result = await callPerplexity(messages, model);

    console.error(`[perplexity-mcp] response received: ${result.length} chars`);

    return {
      content: [{ type: 'text' as const, text: result }],
    };
  },
);

async function main() {
  if (!apiKey) {
    console.error('Missing PERPLEXITY_API_KEY');
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Perplexity MCP server failed:', err);
  process.exit(1);
});
