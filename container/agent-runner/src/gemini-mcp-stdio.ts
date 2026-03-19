/**
 * Gemini Research MCP Server for NanoClaw
 * Provides a gemini_research tool that sends queries to Gemini API
 * with optional Google Search grounding for real-time information.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const apiKey = process.env.GEMINI_API_KEY!;
const defaultModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

async function callGemini(
  prompt: string,
  model: string,
  useGrounding: boolean,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body: Record<string, unknown> = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: 16384,
      temperature: 0.7,
    },
  };

  if (useGrounding) {
    body.tools = [{ google_search: {} }];
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      groundingMetadata?: {
        searchEntryPoint?: { renderedContent?: string };
        groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
      };
    }>;
  };

  const candidate = data.candidates?.[0];
  if (!candidate?.content?.parts) {
    throw new Error('No response from Gemini');
  }

  let result = candidate.content.parts
    .map((p) => p.text || '')
    .join('');

  // Append grounding sources if available
  const chunks = candidate.groundingMetadata?.groundingChunks;
  if (chunks && chunks.length > 0) {
    result += '\n\n---\nSources:\n';
    for (const chunk of chunks) {
      if (chunk.web) {
        result += `- ${chunk.web.title || chunk.web.uri}: ${chunk.web.uri}\n`;
      }
    }
  }

  return result;
}

const server = new McpServer({
  name: 'gemini',
  version: '1.0.0',
});

server.tool(
  'gemini_research',
  'Deep research using Google Gemini AI with optional Google Search grounding. Use this for complex research questions that benefit from web search and large context analysis.',
  {
    query: z
      .string()
      .describe('Research question or topic to investigate in detail'),
    context: z
      .string()
      .optional()
      .describe('Additional context or background information for the research'),
    use_search: z
      .boolean()
      .default(true)
      .describe('Enable Google Search grounding for real-time web data (default: true)'),
    model: z
      .string()
      .optional()
      .describe(`Gemini model to use (default: ${defaultModel}). Options: gemini-2.5-pro, gemini-2.5-flash`),
  },
  async (args) => {
    const prompt = args.context
      ? `Context:\n${args.context}\n\nResearch question:\n${args.query}\n\nProvide a thorough, well-structured analysis. Include specific facts, numbers, and sources where possible.`
      : `Research question:\n${args.query}\n\nProvide a thorough, well-structured analysis. Include specific facts, numbers, and sources where possible.`;

    const model = args.model || defaultModel;
    const result = await callGemini(prompt, model, args.use_search);

    return {
      content: [{ type: 'text' as const, text: result }],
    };
  },
);

server.tool(
  'gemini_analyze',
  'Analyze a document or text using Gemini. Good for summarization, extraction, translation, or any text analysis that benefits from a different AI perspective.',
  {
    text: z
      .string()
      .describe('Text content to analyze'),
    instruction: z
      .string()
      .describe('What to do with the text (e.g., "summarize", "extract key points", "translate to English")'),
    model: z
      .string()
      .optional()
      .describe(`Gemini model to use (default: ${defaultModel})`),
  },
  async (args) => {
    const prompt = `${args.instruction}\n\n---\n\n${args.text}`;
    const model = args.model || defaultModel;
    const result = await callGemini(prompt, model, false);

    return {
      content: [{ type: 'text' as const, text: result }],
    };
  },
);

async function main() {
  if (!apiKey) {
    console.error('Missing GEMINI_API_KEY');
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Gemini MCP server failed:', err);
  process.exit(1);
});
