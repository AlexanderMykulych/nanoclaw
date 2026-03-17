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

async function calendarApiWrite(
  endpoint: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: Record<string, unknown>,
): Promise<unknown> {
  const token = await getAccessToken();
  const url = `https://www.googleapis.com/calendar/v3/${endpoint}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Calendar API error ${res.status}: ${text}`);
  }

  if (method === 'DELETE') return { deleted: true };
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

server.tool(
  'create_event',
  'Create a new calendar event.',
  {
    summary: z.string().describe('Event title'),
    start_time: z
      .string()
      .describe('Start time in ISO 8601 format (e.g. 2026-03-17T10:00:00+02:00) or YYYY-MM-DD for all-day'),
    end_time: z
      .string()
      .describe('End time in ISO 8601 format or YYYY-MM-DD for all-day'),
    description: z.string().optional().describe('Event description'),
    location: z.string().optional().describe('Event location'),
    calendar_id: z
      .string()
      .default('primary')
      .describe('Calendar ID (use "primary" for the main calendar)'),
  },
  async (args) => {
    const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(args.start_time);

    const event: Record<string, unknown> = {
      summary: args.summary,
      start: isAllDay
        ? { date: args.start_time }
        : { dateTime: args.start_time, timeZone: timezone },
      end: isAllDay
        ? { date: args.end_time }
        : { dateTime: args.end_time, timeZone: timezone },
    };

    if (args.description) event.description = args.description;
    if (args.location) event.location = args.location;

    const created = (await calendarApiWrite(
      `calendars/${encodeURIComponent(args.calendar_id)}/events`,
      'POST',
      event,
    )) as { id: string; htmlLink: string; summary: string };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { id: created.id, link: created.htmlLink, summary: created.summary },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  'update_event',
  'Update an existing calendar event. Only provided fields will be changed.',
  {
    event_id: z.string().describe('Event ID to update'),
    summary: z.string().optional().describe('New event title'),
    start_time: z
      .string()
      .optional()
      .describe('New start time (ISO 8601 or YYYY-MM-DD)'),
    end_time: z
      .string()
      .optional()
      .describe('New end time (ISO 8601 or YYYY-MM-DD)'),
    description: z.string().optional().describe('New description'),
    location: z.string().optional().describe('New location'),
    calendar_id: z
      .string()
      .default('primary')
      .describe('Calendar ID'),
  },
  async (args) => {
    const patch: Record<string, unknown> = {};

    if (args.summary) patch.summary = args.summary;
    if (args.description !== undefined) patch.description = args.description;
    if (args.location !== undefined) patch.location = args.location;

    if (args.start_time) {
      const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(args.start_time);
      patch.start = isAllDay
        ? { date: args.start_time }
        : { dateTime: args.start_time, timeZone: timezone };
    }

    if (args.end_time) {
      const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(args.end_time);
      patch.end = isAllDay
        ? { date: args.end_time }
        : { dateTime: args.end_time, timeZone: timezone };
    }

    const updated = (await calendarApiWrite(
      `calendars/${encodeURIComponent(args.calendar_id)}/events/${encodeURIComponent(args.event_id)}`,
      'PATCH',
      patch,
    )) as { id: string; htmlLink: string; summary: string };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { id: updated.id, link: updated.htmlLink, summary: updated.summary },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  'delete_event',
  'Delete a calendar event.',
  {
    event_id: z.string().describe('Event ID to delete'),
    calendar_id: z
      .string()
      .default('primary')
      .describe('Calendar ID'),
  },
  async (args) => {
    await calendarApiWrite(
      `calendars/${encodeURIComponent(args.calendar_id)}/events/${encodeURIComponent(args.event_id)}`,
      'DELETE',
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: `Event ${args.event_id} deleted successfully.`,
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
