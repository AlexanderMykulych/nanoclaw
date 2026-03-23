# Calendar Sync to Obsidian — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `Scripts/calendar-sync.js` on the server that fetches a work Google Calendar iCal feed and syncs it to `Memory/calendar/YYYY-MM-DD.md` files with smart UID-based merge, preserving user notes across reschedules.

**Architecture:** A standalone Node.js CommonJS script that runs as a pre-check (always returns `{run: false}`). Pure functions for parsing and merging are tested in isolation with Vitest. The main function wires fetch → parse → merge → write. No npm dependencies — only Node.js built-ins.

**Tech Stack:** Node.js v22 (native `fetch`, `Intl.DateTimeFormat`), Vitest (existing setup in `Scripts/tests/`), CommonJS modules.

---

## File Map

| Action | Path on server |
|--------|---------------|
| Create | `/workspace/extra/Memory_Obsidian/Scripts/calendar-sync.js` |
| Create | `/workspace/extra/Memory_Obsidian/Scripts/tests/calendar-sync.test.js` |
| Create | `/workspace/extra/Memory_Obsidian/Memory/mao/scheduled-tasks/calendar-sync.md` |
| Create (auto) | `/workspace/extra/Memory_Obsidian/Memory/calendar/YYYY-MM-DD.md` (runtime output) |

All paths in the script are relative to `vaultRoot` = `process.argv[2]` = `/workspace/extra/Memory_Obsidian/`.

---

## Task 1: iCal parsing functions

**Files:**
- Create: `/workspace/extra/Memory_Obsidian/Scripts/calendar-sync.js` (partial — only parsing functions)
- Create: `/workspace/extra/Memory_Obsidian/Scripts/tests/calendar-sync.test.js` (partial)

- [ ] **Step 1: Write failing tests for `parseIcal` and `toKyivDatetime`**

Create `/workspace/extra/Memory_Obsidian/Scripts/tests/calendar-sync.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { parseIcal, toKyivDatetime, parseExistingFile, mergeEvents, buildDayFile } = require('../calendar-sync.js');

const SAMPLE_ICAL = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:event-001@google.com
DTSTART:20260325T070000Z
DTEND:20260325T080000Z
SUMMARY:Team Standup
END:VEVENT
BEGIN:VEVENT
UID:event-002@google.com
DTSTART;VALUE=DATE:20260326
SUMMARY:All Day Meeting
END:VEVENT
BEGIN:VEVENT
UID:event-003@google.com
DTSTART:20260325T120000Z
DTEND:20260325T130000Z
SUMMARY:1:1 with Manager
STATUS:CANCELLED
END:VEVENT
END:VCALENDAR`;

describe('toKyivDatetime', () => {
  it('converts UTC date to Europe/Kyiv', () => {
    // 07:00 UTC = 10:00 Kyiv (UTC+3 in summer)
    const result = toKyivDatetime(new Date('2026-03-25T07:00:00Z'));
    expect(result.time).toMatch(/^\d{2}:\d{2}$/);
    expect(result.date).toBe('2026-03-25');
  });
});

describe('parseIcal', () => {
  it('parses timed event from UTC DTSTART', () => {
    const events = parseIcal(SAMPLE_ICAL);
    const e = events.find(e => e.uid === 'event-001@google.com');
    expect(e).toBeDefined();
    expect(e.summary).toBe('Team Standup');
    expect(e.dtstart.date).toBe('2026-03-25');
    expect(e.dtstart.time).toBeDefined();
    expect(e.cancelled).toBe(false);
  });

  it('parses all-day event', () => {
    const events = parseIcal(SAMPLE_ICAL);
    const e = events.find(e => e.uid === 'event-002@google.com');
    expect(e).toBeDefined();
    expect(e.dtstart.time).toBeNull();
  });

  it('marks cancelled event', () => {
    const events = parseIcal(SAMPLE_ICAL);
    const e = events.find(e => e.uid === 'event-003@google.com');
    expect(e).toBeDefined();
    expect(e.cancelled).toBe(true);
  });

  it('returns empty array for empty calendar', () => {
    expect(parseIcal('BEGIN:VCALENDAR\nEND:VCALENDAR')).toEqual([]);
  });

  it('skips events without UID', () => {
    const ical = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20260325T070000Z\nSUMMARY:No UID\nEND:VEVENT\nEND:VCALENDAR';
    expect(parseIcal(ical)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

`Scripts/tests/` has its own `package.json` with Vitest — run tests from there:

```bash
cd /workspace/extra/Memory_Obsidian/Scripts/tests && npm install && npm test -- --reporter=verbose 2>&1 | head -30
```

Expected: FAIL — `calendar-sync.js` does not exist yet.

Note: `calendar-sync.js` is CommonJS (`module.exports`). The test file is ESM and uses `createRequire` for interop — this is valid in Node.js v22 and Vitest.

- [ ] **Step 3: Create `calendar-sync.js` with parsing functions**

Create `/workspace/extra/Memory_Obsidian/Scripts/calendar-sync.js`.

**Important:** All top-level side-effectful code (reading `process.argv`, fetching, writing files) must be inside `if (require.main === module)` so that `require()`-ing from tests is side-effect-free.

```javascript
#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ICAL_URL = 'https://calendar.google.com/calendar/ical/oleksandr.mykulych%40tentens.tech/private-307fee5749fd6e151e194495e2f044ca/basic.ics';
const FETCH_TIMEOUT_MS = 3000;
const DAYS_AHEAD = 14;
const TIMEZONE = 'Europe/Kyiv';

// ── Timezone ──────────────────────────────────────────────────────────────────

function toKyivDatetime(d) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

// ── iCal parsing ──────────────────────────────────────────────────────────────

function parseDt(block, key) {
  const re = new RegExp(`^${key}([^:\\r\\n]*):([^\\r\\n]*)`, 'm');
  const m = block.match(re);
  if (!m) return null;
  const params = m[1];
  const value = m[2].replace(/\r/g, '').trim();

  if (params.includes('VALUE=DATE') || (value.length === 8 && !value.includes('T'))) {
    return { date: `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`, time: null };
  }

  const year = value.slice(0,4), mo = value.slice(4,6), day = value.slice(6,8);
  const h = value.slice(9,11), min = value.slice(11,13);

  if (value.endsWith('Z')) {
    return toKyivDatetime(new Date(`${year}-${mo}-${day}T${h}:${min}:00Z`));
  }
  return { date: `${year}-${mo}-${day}`, time: `${h}:${min}` };
}

function parseIcal(text) {
  const events = [];
  const blocks = text.split('BEGIN:VEVENT');
  for (const block of blocks.slice(1)) {
    const end = block.indexOf('END:VEVENT');
    if (end === -1) continue;
    const content = block.slice(0, end);

    const get = key => {
      const m = content.match(new RegExp(`^${key}:([^\\r\\n]*)`, 'm'));
      return m ? m[1].replace(/\r/g, '').trim() : null;
    };

    const uid = get('UID');
    if (!uid) continue;
    const dtstart = parseDt(content, 'DTSTART');
    if (!dtstart) continue;
    const dtend = parseDt(content, 'DTEND');
    const summary = get('SUMMARY') || '(без назви)';
    const status = get('STATUS');

    events.push({ uid, summary, dtstart, dtend, cancelled: status === 'CANCELLED' });
  }
  return events;
}

module.exports = { toKyivDatetime, parseIcal };
```

- [ ] **Step 4: Run tests — parsing tests should pass**

```bash
cd /workspace/extra/Memory_Obsidian/Scripts/tests && npm test -- --reporter=verbose 2>&1 | grep -E "✓|✗|PASS|FAIL|parseIcal|toKyiv"
```

Expected: `parseIcal` and `toKyivDatetime` tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /workspace/extra/Memory_Obsidian && git add Scripts/calendar-sync.js Scripts/tests/calendar-sync.test.js && git commit -m "feat: add calendar-sync iCal parser"
```

---

## Task 2: Existing file parser

**Files:**
- Modify: `/workspace/extra/Memory_Obsidian/Scripts/calendar-sync.js` (add `parseExistingFile`)
- Modify: `/workspace/extra/Memory_Obsidian/Scripts/tests/calendar-sync.test.js` (add tests)

- [ ] **Step 1: Add `parseExistingFile` tests**

Append to the `describe` blocks in `calendar-sync.test.js`:

```javascript
describe('parseExistingFile', () => {
  const FILE = `---
date: 2026-03-25
synced: "2026-03-25 07:00"
---

## Зустрічі

- **10:00–11:00** Team Standup <!-- uid: event-001 -->
  підготувати слайди

- **весь день** All Day <!-- uid: event-002 -->

## Відмінені

- ❌ **15:00–16:00** 1:1 <!-- uid: event-003 -->

## Видалені з календаря

- 🗑️ **09:00–10:00** Old Meeting <!-- uid: event-004 -->
  важлива нотатка
`;

  it('extracts notes for active event', () => {
    const result = parseExistingFile(FILE, '2026-03-25');
    expect(result['event-001'].notes).toEqual(['  підготувати слайди']);
    expect(result['event-001'].status).toBe('active');
    expect(result['event-001'].date).toBe('2026-03-25');
  });

  it('extracts all-day event without notes', () => {
    const result = parseExistingFile(FILE, '2026-03-25');
    expect(result['event-002'].notes).toEqual([]);
  });

  it('extracts cancelled event', () => {
    const result = parseExistingFile(FILE, '2026-03-25');
    expect(result['event-003'].status).toBe('cancelled');
  });

  it('extracts deleted event with notes', () => {
    const result = parseExistingFile(FILE, '2026-03-25');
    expect(result['event-004'].status).toBe('deleted');
    expect(result['event-004'].notes).toEqual(['  важлива нотатка']);
  });

  it('stops collecting notes at blank line', () => {
    const content = `## Зустрічі\n\n- **10:00** Meeting <!-- uid: u1 -->\n  note line\n\n- **11:00** Next <!-- uid: u2 -->\n`;
    const result = parseExistingFile(content, '2026-03-25');
    expect(result['u1'].notes).toEqual(['  note line']);
    expect(result['u2'].notes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — new tests should fail**

```bash
cd /workspace/extra/Memory_Obsidian/Scripts/tests && npm test -- --reporter=verbose 2>&1 | grep -E "parseExistingFile|✗|FAIL"
```

Expected: FAIL on `parseExistingFile` tests.

- [ ] **Step 3: Implement `parseExistingFile` in `calendar-sync.js`**

Add after the `parseIcal` function, and update `module.exports`:

```javascript
// ── Existing file parser ──────────────────────────────────────────────────────

function parseExistingFile(content, fileDate) {
  const notesByUid = {};
  const lines = content.split('\n');
  let currentUid = null;
  let section = 'active';

  for (const line of lines) {
    if (line === '## Зустрічі') { section = 'active'; currentUid = null; continue; }
    if (line === '## Відмінені') { section = 'cancelled'; currentUid = null; continue; }
    if (line === '## Видалені з календаря') { section = 'deleted'; currentUid = null; continue; }

    const uidMatch = line.match(/<!--\s*uid:\s*([^\s>]+)\s*-->/);
    if (uidMatch) {
      currentUid = uidMatch[1];
      // Extract summary: text between last ** pair and <!-- uid:
      const summaryMatch = line.match(/\*\*\s+(.+?)\s*<!--/);
      const summary = summaryMatch ? summaryMatch[1].trim() : '?';
      notesByUid[currentUid] = { notes: [], date: fileDate, status: section, summary };
      continue;
    }

    if (currentUid && /^  \S/.test(line)) {
      notesByUid[currentUid].notes.push(line);
    } else if (line.trim() === '' || line.startsWith('#')) {
      currentUid = null;
    }
  }

  return notesByUid;
}
```

Update `module.exports`:
```javascript
module.exports = { toKyivDatetime, parseIcal, parseExistingFile };
```

- [ ] **Step 4: Run — all tests should pass**

```bash
cd /workspace/extra/Memory_Obsidian/Scripts/tests && npm test -- --reporter=verbose 2>&1 | grep -E "✓|✗|PASS|FAIL"
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /workspace/extra/Memory_Obsidian && git add Scripts/calendar-sync.js Scripts/tests/calendar-sync.test.js && git commit -m "feat: add calendar-sync file parser"
```

---

## Task 3: Merge logic

**Files:**
- Modify: `/workspace/extra/Memory_Obsidian/Scripts/calendar-sync.js` (add `mergeEvents`)
- Modify: `/workspace/extra/Memory_Obsidian/Scripts/tests/calendar-sync.test.js` (add tests)

- [ ] **Step 1: Add `mergeEvents` tests**

Append to `calendar-sync.test.js`:

```javascript
describe('mergeEvents', () => {
  const today = '2026-03-25';

  const makeEvent = (uid, date, time = '10:00', cancelled = false) => ({
    uid, summary: `Meeting ${uid}`, cancelled,
    dtstart: { date, time }, dtend: { date, time: '11:00' },
  });

  it('places active event on correct day', () => {
    const events = [makeEvent('u1', '2026-03-25')];
    const result = mergeEvents(events, {}, today);
    expect(result['2026-03-25']).toHaveLength(1);
    expect(result['2026-03-25'][0].section).toBe('active');
  });

  it('carries over notes from existing file', () => {
    const events = [makeEvent('u1', '2026-03-25')];
    const existing = { 'u1': { notes: ['  my note'], date: '2026-03-25', status: 'active', summary: 'Meeting u1' } };
    const result = mergeEvents(events, existing, today);
    expect(result['2026-03-25'][0].notes).toEqual(['  my note']);
  });

  it('moves notes when event is rescheduled to different day', () => {
    const events = [makeEvent('u1', '2026-03-26')]; // moved from 25 to 26
    const existing = { 'u1': { notes: ['  note'], date: '2026-03-25', status: 'active', summary: 'Meeting u1' } };
    const result = mergeEvents(events, existing, today);
    expect(result['2026-03-26'][0].notes).toEqual(['  note']);
    expect(result['2026-03-25']).toBeUndefined();
  });

  it('marks cancelled event', () => {
    const events = [makeEvent('u1', '2026-03-25', '10:00', true)];
    const result = mergeEvents(events, {}, today);
    expect(result['2026-03-25'][0].section).toBe('cancelled');
  });

  it('marks event as deleted when it disappears from iCal within window', () => {
    const existing = { 'u1': { notes: ['  note'], date: '2026-03-25', status: 'active', summary: 'Old Meeting' } };
    const result = mergeEvents([], existing, today);
    expect(result['2026-03-25'][0].section).toBe('deleted');
    expect(result['2026-03-25'][0].notes).toEqual(['  note']);
  });

  it('does not touch event outside 14-day window', () => {
    const pastDate = '2026-03-10'; // outside window
    const existing = { 'u1': { notes: [], date: pastDate, status: 'active', summary: 'Past' } };
    const result = mergeEvents([], existing, today);
    expect(result[pastDate]).toBeUndefined();
  });

  it('skips fresh events outside 14-day window', () => {
    const farFuture = '2026-04-20';
    const events = [makeEvent('u1', farFuture)];
    const result = mergeEvents(events, {}, today);
    expect(result[farFuture]).toBeUndefined();
  });

  it('preserves already-deleted events', () => {
    const existing = { 'u1': { notes: ['  note'], date: '2026-03-25', status: 'deleted', summary: 'Gone' } };
    const result = mergeEvents([], existing, today);
    expect(result['2026-03-25'][0].section).toBe('deleted');
  });
});
```

- [ ] **Step 2: Run — new tests should fail**

```bash
cd /workspace/extra/Memory_Obsidian/Scripts/tests && npm test -- --reporter=verbose 2>&1 | grep -E "mergeEvents|✗|FAIL"
```

- [ ] **Step 3: Implement `mergeEvents` in `calendar-sync.js`**

Add after `parseExistingFile`, update `module.exports`:

```javascript
// ── Merge logic ───────────────────────────────────────────────────────────────

function getWindowDates(today) {
  const dates = new Set();
  const base = new Date(today + 'T00:00:00');
  for (let i = 0; i <= DAYS_AHEAD; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    dates.add(d.toISOString().slice(0, 10));
  }
  return dates;
}

function mergeEvents(freshEvents, existingNotesByUid, today) {
  const window = getWindowDates(today);
  const dayMap = {};
  const freshUids = new Set(freshEvents.map(e => e.uid));

  // Fresh events
  for (const event of freshEvents) {
    const date = event.dtstart.date;
    if (!window.has(date)) continue;
    if (!dayMap[date]) dayMap[date] = [];
    const existing = existingNotesByUid[event.uid];
    dayMap[date].push({
      ...event,
      notes: existing ? existing.notes : [],
      section: event.cancelled ? 'cancelled' : 'active',
    });
  }

  // Gone from iCal
  for (const [uid, info] of Object.entries(existingNotesByUid)) {
    if (freshUids.has(uid)) continue;
    const date = info.date;
    if (!window.has(date)) continue; // outside window — leave file untouched
    if (!dayMap[date]) dayMap[date] = [];
    dayMap[date].push({
      uid,
      summary: info.summary || '?',
      dtstart: { date, time: null },
      dtend: null,
      notes: info.notes,
      section: 'deleted',
    });
  }

  return dayMap;
}
```

Update `module.exports`:
```javascript
module.exports = { toKyivDatetime, parseIcal, parseExistingFile, mergeEvents };
```

- [ ] **Step 4: Run — all tests should pass**

```bash
cd /workspace/extra/Memory_Obsidian/Scripts/tests && npm test -- --reporter=verbose 2>&1 | tail -10
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /workspace/extra/Memory_Obsidian && git add Scripts/calendar-sync.js Scripts/tests/calendar-sync.test.js && git commit -m "feat: add calendar-sync merge logic"
```

---

## Task 4: File builder

**Files:**
- Modify: `/workspace/extra/Memory_Obsidian/Scripts/calendar-sync.js` (add `buildDayFile`)
- Modify: `/workspace/extra/Memory_Obsidian/Scripts/tests/calendar-sync.test.js` (add tests)

- [ ] **Step 1: Add `buildDayFile` tests**

Append to `calendar-sync.test.js`:

```javascript
describe('buildDayFile', () => {
  it('renders active meetings sorted by time', () => {
    const events = [
      { uid: 'u1', summary: 'Standup', dtstart: { date: '2026-03-25', time: '10:00' }, dtend: { date: '2026-03-25', time: '10:30' }, notes: [], section: 'active' },
      { uid: 'u2', summary: 'Review', dtstart: { date: '2026-03-25', time: '09:00' }, dtend: { date: '2026-03-25', time: '10:00' }, notes: [], section: 'active' },
    ];
    const content = buildDayFile('2026-03-25', events, '2026-03-25 07:00');
    const lines = content.split('\n');
    const meetingLines = lines.filter(l => l.startsWith('- **'));
    expect(meetingLines[0]).toContain('09:00');
    expect(meetingLines[1]).toContain('10:00');
  });

  it('renders notes indented under meeting', () => {
    const events = [
      { uid: 'u1', summary: 'Standup', dtstart: { date: '2026-03-25', time: '10:00' }, dtend: null, notes: ['  my note'], section: 'active' },
    ];
    const content = buildDayFile('2026-03-25', events, '2026-03-25 07:00');
    expect(content).toContain('  my note');
  });

  it('renders cancelled with ❌ prefix', () => {
    const events = [
      { uid: 'u1', summary: 'Meeting', dtstart: { date: '2026-03-25', time: '10:00' }, dtend: null, notes: [], section: 'cancelled' },
    ];
    const content = buildDayFile('2026-03-25', events, '2026-03-25 07:00');
    expect(content).toContain('## Відмінені');
    expect(content).toContain('❌');
  });

  it('renders deleted with 🗑️ prefix', () => {
    const events = [
      { uid: 'u1', summary: 'Gone', dtstart: { date: '2026-03-25', time: null }, dtend: null, notes: [], section: 'deleted' },
    ];
    const content = buildDayFile('2026-03-25', events, '2026-03-25 07:00');
    expect(content).toContain('## Видалені з календаря');
    expect(content).toContain('🗑️');
  });

  it('renders all-day event with весь день', () => {
    const events = [
      { uid: 'u1', summary: 'Holiday', dtstart: { date: '2026-03-25', time: null }, dtend: null, notes: [], section: 'active' },
    ];
    const content = buildDayFile('2026-03-25', events, '2026-03-25 07:00');
    expect(content).toContain('**весь день**');
  });

  it('omits empty sections', () => {
    const events = [
      { uid: 'u1', summary: 'S', dtstart: { date: '2026-03-25', time: '10:00' }, dtend: null, notes: [], section: 'active' },
    ];
    const content = buildDayFile('2026-03-25', events, '2026-03-25 07:00');
    expect(content).not.toContain('## Відмінені');
    expect(content).not.toContain('## Видалені');
  });

  it('includes uid comment on every meeting line', () => {
    const events = [
      { uid: 'my-uid', summary: 'S', dtstart: { date: '2026-03-25', time: '10:00' }, dtend: null, notes: [], section: 'active' },
    ];
    const content = buildDayFile('2026-03-25', events, '2026-03-25 07:00');
    expect(content).toContain('<!-- uid: my-uid -->');
  });
});
```

- [ ] **Step 2: Run — new tests should fail**

```bash
cd /workspace/extra/Memory_Obsidian/Scripts/tests && npm test -- --reporter=verbose 2>&1 | grep -E "buildDayFile|✗|FAIL"
```

- [ ] **Step 3: Implement `buildDayFile` in `calendar-sync.js`**

Add after `mergeEvents`, update `module.exports`:

```javascript
// ── File builder ──────────────────────────────────────────────────────────────

function formatTimeRange(dtstart, dtend) {
  if (!dtstart.time) return '**весь день**';
  const end = dtend && dtend.time ? `\u2013${dtend.time}` : '';
  return `**${dtstart.time}${end}**`;
}

function buildDayFile(date, events, synced) {
  const bySection = section =>
    events
      .filter(e => e.section === section)
      .sort((a, b) => (a.dtstart.time || '').localeCompare(b.dtstart.time || ''));

  const active = bySection('active');
  const cancelled = bySection('cancelled');
  const deleted = bySection('deleted');

  const lines = ['---', `date: ${date}`, `synced: "${synced}"`, '---', ''];

  const renderEvent = (event, prefix) => {
    const time = formatTimeRange(event.dtstart, event.dtend);
    lines.push(`- ${prefix}${time} ${event.summary} <!-- uid: ${event.uid} -->`);
    for (const note of event.notes) lines.push(note);
  };

  if (active.length > 0) {
    lines.push('## Зустрічі', '');
    active.forEach(e => renderEvent(e, ''));
    lines.push('');
  }
  if (cancelled.length > 0) {
    lines.push('## Відмінені', '');
    cancelled.forEach(e => renderEvent(e, '❌ '));
    lines.push('');
  }
  if (deleted.length > 0) {
    lines.push('## Видалені з календаря', '');
    deleted.forEach(e => renderEvent(e, '🗑️ '));
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}
```

Update `module.exports`:
```javascript
module.exports = { toKyivDatetime, parseIcal, parseExistingFile, mergeEvents, buildDayFile };
```

- [ ] **Step 4: Run — all tests should pass**

```bash
cd /workspace/extra/Memory_Obsidian/Scripts/tests && npm test -- --reporter=verbose 2>&1 | tail -5
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /workspace/extra/Memory_Obsidian && git add Scripts/calendar-sync.js Scripts/tests/calendar-sync.test.js && git commit -m "feat: add calendar-sync file builder"
```

---

## Task 5: Main sync function

**Files:**
- Modify: `/workspace/extra/Memory_Obsidian/Scripts/calendar-sync.js` (add `sync` + entry point)

- [ ] **Step 1: Append `sync` function and entry point to `calendar-sync.js`**

Add at the end of the file, after `module.exports`:

```javascript
// ── Main ──────────────────────────────────────────────────────────────────────

async function sync(vaultRoot) {
  const calendarDir = path.join(vaultRoot, 'Memory', 'calendar');
  fs.mkdirSync(calendarDir, { recursive: true });

  // Step 1: collect existing notes from all calendar files
  const existingNotesByUid = {};
  for (const f of fs.readdirSync(calendarDir).filter(f => f.endsWith('.md'))) {
    const fileDate = f.replace('.md', '');
    const content = fs.readFileSync(path.join(calendarDir, f), 'utf-8');
    Object.assign(existingNotesByUid, parseExistingFile(content, fileDate));
  }

  // Step 2: fetch iCal with timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let icalText;
  try {
    const resp = await fetch(ICAL_URL, { signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    icalText = await resp.text();
  } catch (err) {
    console.log(JSON.stringify({ run: false, reason: `Error fetching calendar: ${err.message}` }));
    return;
  } finally {
    clearTimeout(timer);
  }

  // Step 3: parse → merge
  const freshEvents = parseIcal(icalText);
  const today = toKyivDatetime(new Date()).date;
  const dayMap = mergeEvents(freshEvents, existingNotesByUid, today);

  // Step 4: write files
  const synced = (() => { const k = toKyivDatetime(new Date()); return `${k.date} ${k.time}`; })();
  let meetingCount = 0;
  for (const [date, events] of Object.entries(dayMap)) {
    fs.writeFileSync(path.join(calendarDir, `${date}.md`), buildDayFile(date, events, synced), 'utf-8');
    meetingCount += events.filter(e => e.section === 'active').length;
  }

  console.log(JSON.stringify({
    run: false,
    reason: `Synced: ${meetingCount} meetings across ${Object.keys(dayMap).length} days`,
  }));
}

// ── Entry ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const vaultRoot = process.argv[2];
  if (!vaultRoot) {
    console.log(JSON.stringify({ run: false, reason: 'no vault path provided' }));
    process.exit(0);
  }
  sync(vaultRoot).catch(err => {
    process.stderr.write(`calendar-sync error: ${err.stack}\n`);
    console.log(JSON.stringify({ run: false, reason: `Error: ${err.message}` }));
  });
}
```

- [ ] **Step 2: Run manual smoke test**

```bash
node /workspace/extra/Memory_Obsidian/Scripts/calendar-sync.js /workspace/extra/Memory_Obsidian
```

Expected output: `{"run":false,"reason":"Synced: X meetings across Y days"}`

- [ ] **Step 3: Verify files were created**

```bash
ls /workspace/extra/Memory_Obsidian/Memory/calendar/ && echo "---" && cat /workspace/extra/Memory_Obsidian/Memory/calendar/$(ls /workspace/extra/Memory_Obsidian/Memory/calendar/ | head -1)
```

Expected: several `YYYY-MM-DD.md` files with correct meeting content.

- [ ] **Step 4: Run all tests — make sure nothing broke**

```bash
cd /workspace/extra/Memory_Obsidian/Scripts/tests && npm test 2>&1 | tail -5
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /workspace/extra/Memory_Obsidian && git add Scripts/calendar-sync.js && git commit -m "feat: add calendar-sync main sync function"
```

---

## Task 6: Activate scheduled task

**Files:**
- Create: `/workspace/extra/Memory_Obsidian/Memory/mao/scheduled-tasks/calendar-sync.md`

- [ ] **Step 1: Create task definition file**

`group` and non-empty prompt are required by `parseMarkdownTask` in `obsidian-task-sync.ts` — both must be present or the task is silently ignored.

```bash
cat > /workspace/extra/Memory_Obsidian/Memory/mao/scheduled-tasks/calendar-sync.md << 'EOF'
---
schedule: "daily 7:00, 13:00"
group: telegram_main
status: active
pre_check: Scripts/calendar-sync.js
---
Calendar synced by pre-check. This prompt never runs — the pre-check always returns run: false.
EOF
```

- [ ] **Step 2: Verify NanoClaw picks it up (wait up to 5 minutes for sync)**

```bash
journalctl -u nanoclaw --no-pager -n 5 --output cat 2>&1 | grep -E "calendar-sync|obs-calendar"
```

If the task isn't visible yet, force sync:
```bash
systemctl restart nanoclaw
sleep 5
journalctl -u nanoclaw --no-pager -n 20 --output cat 2>&1 | grep -E "calendar-sync|Synced.*meetings"
```

- [ ] **Step 3: Confirm task is in DB**

```bash
sqlite3 /workspace/project/store/messages.db "SELECT id, schedule_value, status, pre_check FROM scheduled_tasks WHERE id LIKE '%calendar%';"
```

Expected: `obs-calendar-sync|0 7,13 * * *|active|Scripts/calendar-sync.js`

- [ ] **Step 4: Verify output files on next scheduled run or trigger manually**

```bash
node /workspace/extra/Memory_Obsidian/Scripts/calendar-sync.js /workspace/extra/Memory_Obsidian && ls /workspace/extra/Memory_Obsidian/Memory/calendar/
```

- [ ] **Step 5: Commit task definition**

```bash
cd /workspace/extra/Memory_Obsidian && git add Memory/mao/scheduled-tasks/calendar-sync.md && git commit -m "feat: activate calendar-sync scheduled task"
```
