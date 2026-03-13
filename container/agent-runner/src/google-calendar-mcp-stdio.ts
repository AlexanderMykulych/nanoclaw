/**
 * Google Calendar MCP Server for NanoClaw
 * Standalone stdio MCP server — uses native fetch, no extra dependencies.
 * Reads OAuth credentials from environment variables.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const clientId = process.env.GOOGLE_CLIENT_ID!;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
const refreshToken = process.env.GOOGLE_REFRESH_TOKEN!;
const timezone = process.env.GOOGLE_CALENDAR_TIMEZONE || 'Europe/Kyiv';

let cachedAccessToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
    error?: string;
  };

  if (data.error) {
    throw new Error(`Token refresh failed: ${data.error}`);
  }

  cachedAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedAccessToken;
}

async function calendarApi(
  endpoint: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  const token = await getAccessToken();
  const url = new URL(`https://www.googleapis.com/calendar/v3/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Calendar API error ${res.status}: ${text}`);
  }

  return res.json();
}

const server = new McpServer({
  name: 'google_calendar',
  version: '1.0.0',
});

server.tool(
  'list_calendars',
  'List all calendars the user has access to.',
  {},
  async () => {
    const data = (await calendarApi('users/me/calendarList')) as {
      items: Array<{ id: string; summary: string; primary?: boolean }>;
    };

    const calendars = data.items.map((c) => ({
      id: c.id,
      name: c.summary,
      primary: c.primary || false,
    }));

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(calendars, null, 2) }],
    };
  },
);

server.tool(
  'get_events',
  'Get calendar events for a date range. Returns event title, time, location, and description.',
  {
    calendar_id: z
      .string()
      .default('primary')
      .describe('Calendar ID (use "primary" for the main calendar)'),
    date_from: z
      .string()
      .describe('Start date in YYYY-MM-DD format'),
    date_to: z
      .string()
      .describe('End date in YYYY-MM-DD format (inclusive)'),
    max_results: z
      .number()
      .default(50)
      .describe('Maximum number of events to return'),
  },
  async (args) => {
    const timeMin = new Date(`${args.date_from}T00:00:00`).toISOString();
    const timeMax = new Date(`${args.date_to}T23:59:59`).toISOString();

    const data = (await calendarApi(
      `calendars/${encodeURIComponent(args.calendar_id)}/events`,
      {
        timeMin,
        timeMax,
        maxResults: String(args.max_results),
        singleEvents: 'true',
        orderBy: 'startTime',
        timeZone: timezone,
      },
    )) as {
      items: Array<{
        id: string;
        summary?: string;
        description?: string;
        location?: string;
        start: { dateTime?: string; date?: string };
        end: { dateTime?: string; date?: string };
        status?: string;
      }>;
    };

    const events = (data.items || []).map((e) => ({
      id: e.id,
      title: e.summary || '(no title)',
      start: e.start.dateTime || e.start.date,
      end: e.end.dateTime || e.end.date,
      location: e.location || null,
      description: e.description || null,
      status: e.status,
    }));

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(events, null, 2) }],
    };
  },
);

server.tool(
  'get_today_events',
  "Get today's calendar events. Shortcut for get_events with today's date.",
  {
    calendar_id: z
      .string()
      .default('primary')
      .describe('Calendar ID (use "primary" for the main calendar)'),
  },
  async (args) => {
    const today = new Date()
      .toLocaleDateString('sv-SE', { timeZone: timezone });

    const timeMin = new Date(`${today}T00:00:00`).toISOString();
    const timeMax = new Date(`${today}T23:59:59`).toISOString();

    const data = (await calendarApi(
      `calendars/${encodeURIComponent(args.calendar_id)}/events`,
      {
        timeMin,
        timeMax,
        singleEvents: 'true',
        orderBy: 'startTime',
        timeZone: timezone,
      },
    )) as {
      items: Array<{
        id: string;
        summary?: string;
        start: { dateTime?: string; date?: string };
        end: { dateTime?: string; date?: string };
        location?: string;
      }>;
    };

    const events = (data.items || []).map((e) => ({
      title: e.summary || '(no title)',
      start: e.start.dateTime || e.start.date,
      end: e.end.dateTime || e.end.date,
      location: e.location || null,
    }));

    if (events.length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'No events today.' }],
      };
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(events, null, 2) }],
    };
  },
);

server.tool(
  'search_events',
  'Search calendar events by text query.',
  {
    query: z.string().describe('Search text (matches title, description, location)'),
    calendar_id: z
      .string()
      .default('primary')
      .describe('Calendar ID'),
    date_from: z
      .string()
      .optional()
      .describe('Start date (YYYY-MM-DD). Defaults to today.'),
    date_to: z
      .string()
      .optional()
      .describe('End date (YYYY-MM-DD). Defaults to 30 days from now.'),
  },
  async (args) => {
    const today = new Date()
      .toLocaleDateString('sv-SE', { timeZone: timezone });
    const from = args.date_from || today;
    const to =
      args.date_to ||
      new Date(Date.now() + 30 * 86400000)
        .toLocaleDateString('sv-SE', { timeZone: timezone });

    const timeMin = new Date(`${from}T00:00:00`).toISOString();
    const timeMax = new Date(`${to}T23:59:59`).toISOString();

    const data = (await calendarApi(
      `calendars/${encodeURIComponent(args.calendar_id)}/events`,
      {
        q: args.query,
        timeMin,
        timeMax,
        singleEvents: 'true',
        orderBy: 'startTime',
        timeZone: timezone,
      },
    )) as {
      items: Array<{
        id: string;
        summary?: string;
        start: { dateTime?: string; date?: string };
        end: { dateTime?: string; date?: string };
        location?: string;
        description?: string;
      }>;
    };

    const events = (data.items || []).map((e) => ({
      title: e.summary || '(no title)',
      start: e.start.dateTime || e.start.date,
      end: e.end.dateTime || e.end.date,
      location: e.location || null,
      description: e.description || null,
    }));

    return {
      content: [
        {
          type: 'text' as const,
          text:
            events.length > 0
              ? JSON.stringify(events, null, 2)
              : `No events found for "${args.query}".`,
        },
      ],
    };
  },
);

async function main() {
  if (!clientId || !clientSecret || !refreshToken) {
    console.error(
      'Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REFRESH_TOKEN',
    );
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Google Calendar MCP server failed:', err);
  process.exit(1);
});
