# Calendar Sync to Obsidian — Design Spec

**Date:** 2026-03-23
**Status:** Approved

## Overview

Sync work Google Calendar (tentens.tech) to Obsidian Memory as daily markdown files. Runs twice daily via a pre-check script — no agent container spawned, zero tokens consumed.

## Source

iCal URL (private feed): `https://calendar.google.com/calendar/ical/oleksandr.mykulych%40tentens.tech/private-307fee5749fd6e151e194495e2f044ca/basic.ics`

Fetched directly via HTTP — no OAuth required.

## Output

One file per day in `Memory/calendar/YYYY-MM-DD.md` covering today + 14 days ahead.

### File format

```markdown
---
date: 2026-03-25
synced: "2026-03-23 13:00"
---

## Зустрічі

- **09:00–10:00** Team Standup <!-- uid: abc123 -->
  підготувати слайди

- **14:00–15:30** Product Review <!-- uid: def456 -->

## Відмінені

- ❌ **11:00–12:00** 1:1 with Manager <!-- uid: ghi789 -->
  нотатки збережено

## Видалені з календаря

- 🗑️ **16:00–17:00** Weekly Sync <!-- uid: xyz000 -->
  нотатки збережено
```

- Meetings sorted by start time
- Notes are indented lines immediately after the meeting line
- UID stored in HTML comment — not visible in Obsidian render, used for merge tracking
- Sections only rendered if non-empty

## Schedule

`daily 7:00, 13:00` (Europe/Kyiv)

## Components

### `Scripts/calendar-sync.js`

Node.js script, no npm dependencies. Runs on server host as pre-check.

**Always returns `{run: false, reason: "..."}` — agent never spawns.**

All file paths in the script are relative to `vaultRoot` passed as `process.argv[2]`.

**Timeout constraint:** `PRE_CHECK_TIMEOUT_MS = 5000ms` (hardcoded in NanoClaw config). The HTTP fetch must use a 3-second `AbortController` timeout to leave room for file I/O. If the fetch times out, the script returns `{ run: false, reason: "Error fetching calendar: timeout" }` and no files are written.

### `Memory/mao/scheduled-tasks/calendar-sync.md`

```yaml
---
schedule: daily 7:00, 13:00
group: telegram_main
status: active
pre_check: Scripts/calendar-sync.js
---
Calendar synced by pre-check.
```

`pre_check` paths in task files are resolved relative to `vaultRoot` by NanoClaw (`path.resolve(vaultRoot, task.pre_check)` in `task-scheduler.ts:216`).

## Sync Algorithm

### Step 1 — Collect existing notes

Read all `calendar/*.md` files. For each file, extract:
- `uid → { notes: string[], status: 'active' | 'cancelled' | 'deleted' }`

Build a global map across all day files so notes survive cross-day moves.

### Step 2 — Fetch and parse iCal

Fetch iCal URL. Parse `VEVENT` blocks, extracting:
- `UID`
- `DTSTART` / `DTEND` — convert to Europe/Kyiv local time
- `SUMMARY` — event title
- `STATUS` — presence of `STATUS:CANCELLED`

Filter: events whose start date falls within today + 14 days.

No external iCal library — parse with regex/string splitting on `BEGIN:VEVENT` / `END:VEVENT` blocks.

### Step 3 — Determine event fate per UID

For each UID in the fresh iCal:
- **Active, same day as before** → update time/title, carry over notes
- **Active, day changed (rescheduled)** → place in new day file with notes; remove from old day file
- **`STATUS:CANCELLED`** → move to "Відмінені" section with ❌, carry over notes

For each UID present in existing files but absent from fresh iCal:
- If the event's last known date is **within** today + 14 days → move to "Видалені з календаря" with 🗑️, carry over notes
- If the event's last known date is **outside** today + 14 days (scrolled out of window) → leave as-is, do not touch that file

### Step 4 — Write files

For each day that has any events (active, cancelled, or deleted):
- Build markdown from scratch using current event state
- Overwrite file (frontmatter `synced` timestamp updated)

Days with no events and no existing file: skip.
Days with no events but existing file (all events removed/deleted): write file with only deleted section.

### Step 5 — Return result

```json
{ "run": false, "reason": "Synced: 12 meetings across 8 days" }
```

## Event time handling

- `DTSTART` with `Z` suffix → UTC, convert to Europe/Kyiv
- `DTSTART` with `TZID=` prefix → use specified timezone
- `DTSTART` without timezone → treat as Europe/Kyiv local
- All-day events (`DTSTART;VALUE=DATE`) → display without time: `- **весь день** Title <!-- uid: abc123 -->`
  The `<!-- uid: ... -->` comment is always present on every meeting line regardless of type.

## Error handling

- Network error fetching iCal → `{ run: false, reason: "Error fetching calendar: <message>" }` — no files written
- iCal parse error on individual event → skip that event, log to stderr, continue
- File write error → log to stderr, continue with other files

## Notes preservation rules

- Notes are all indented lines (starting with 2+ spaces) immediately below a meeting line
- A note block ends at the first non-indented line (section header, next meeting, blank line, or EOF)
- On merge, notes follow the UID — regardless of time, day, or status change
- Notes for deleted events are preserved indefinitely (file stays until user deletes it)
- New events have no notes

## What is NOT in scope

- Recurring event expansion (Google iCal feed already expands these)
- Creating/editing calendar events
- Syncing past days
- Personal calendar (`alexander.mykulych@gmail.com`) — separate MCP already handles it
