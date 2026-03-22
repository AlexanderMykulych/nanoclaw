# NanoClaw Observability — Telegram Mini App

**Date:** 2026-03-22
**Status:** Draft

## Problem

NanoClaw errors (token expiry, container failures, exceptions) are only visible in server logs via `journalctl`. No way to check system health without SSH access. No proactive error notifications.

## Solution

Telegram Mini App with health-first UI showing system status, groups, scheduled tasks, and error log. Opens via `/check` command and Bot Menu Button.

## Architecture

```
┌─────────────────┐     HTTPS      ┌────────┐     HTTP        ┌──────────────────┐
│  Telegram       │ ──────────────→│ Caddy  │──────────────→  │  NanoClaw        │
│  Mini App (Vue) │   domain.xyz   │ :443   │  localhost:3847 │                  │
└─────────────────┘                └────────┘                 │  /api/health     │
                                                              │  /api/groups     │
                                                              │  /api/tasks      │
                                                              │  /api/tasks/:id  │
                                                              │  /api/errors     │
                                                              └──────────────────┘
```

- **Caddy** — reverse proxy with automatic HTTPS via Let's Encrypt. Serves Vue SPA static files, proxies `/api/*` to NanoClaw.
- **NanoClaw HTTP API** (`src/api.ts`) — new HTTP server starting alongside main process on port 3847. Reads from SQLite and runtime state.
- **Vue Mini App** (`mini-app/`) — separate Vue 3 SPA, built with Vite, deployed as static files.

Nothing changes in the existing message loop, container runner, IPC, or channel code.

## UI Design

**Health-first with drill-down.** Main screen shows:

1. Large circular health indicator: **OK** (green) / **WARNING** (yellow) / **ERROR** (red)
2. Summary line: uptime, version, counts
3. Drill-down cards tapping into detail views:
   - **Groups** — registered groups, last message, active container status
   - **Scheduled Tasks** — task list with next_run, last_result, run history
   - **Errors** — paginated error log
   - **Containers** — active containers, queue status

**Health logic:**
- **OK** — process alive, 0 errors in last hour
- **WARNING** — errors in last hour, process running
- **ERROR** — critical failures (container spawn, channel disconnect)

**Theme:** Uses Telegram `themeParams` (bg_color, text_color, hint_color, button_color) as CSS variables — auto-matches user's dark/light theme.

**Navigation:** Vue Router. Home → tap card → detail view. Telegram BackButton API for back navigation.

**Polling:** HomeView polls `/api/health` every 30 seconds. No WebSocket — single user, not worth the complexity.

## API

### Authentication

All endpoints validate `Telegram-Web-App-Init-Data` header — HMAC signature verification using bot token. Invalid requests → 401.

### Endpoints

| Endpoint | Response | Source |
|---|---|---|
| `GET /api/health` | `{ status, uptime, version, groups_count, tasks_count, errors_last_hour }` | `process.uptime()` + SQL counts |
| `GET /api/groups` | `[{ jid, name, folder, last_message_time, has_active_container }]` | `registered_groups` + `messages` + GroupQueue runtime |
| `GET /api/tasks` | `[{ id, group_folder, prompt, schedule_type, schedule_value, status, next_run, last_run, last_result }]` | `scheduled_tasks` table |
| `GET /api/tasks/:id/logs` | `[{ run_at, duration_ms, status, result, error }]` | `task_run_logs` table |
| `GET /api/errors?limit=50&offset=0` | `[{ id, timestamp, level, source, group_folder, message, stack }]` | `error_log` table |

### HTTP server

Standard `node:http` module. No framework — endpoints are few and simple. Starts in `src/index.ts` alongside existing services.

## Error Collection

### New table: `error_log`

```sql
CREATE TABLE IF NOT EXISTS error_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    level TEXT NOT NULL,
    source TEXT,
    group_folder TEXT,
    message TEXT NOT NULL,
    stack TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
```

### Pino transport

Custom Pino transport that writes error+ level log entries to `error_log` table. Structured fields (`source`, `groupFolder`) passed via Pino child loggers or extra fields in `logger.error({ source, groupFolder }, message)`.

Existing stdout logging unchanged — transport is additive.

### Retention

Cleanup on process start: `DELETE FROM error_log WHERE timestamp < datetime('now', '-5 days')`.

## Frontend

### Stack

Vue 3 + Vue Router + Vite. No Pinia (state is simple — composables suffice). No UI library — Telegram theme provides styling.

### Structure

```
mini-app/
├── src/
│   ├── App.vue
│   ├── main.ts                  # Init Telegram WebApp SDK + router
│   ├── api.ts                   # fetch wrapper with initData auth header
│   ├── composables/
│   │   └── useHealth.ts         # Polls /api/health every 30s
│   ├── views/
│   │   ├── HomeView.vue         # Health circle + drill-down cards
│   │   ├── GroupsView.vue       # Group list with details
│   │   ├── TasksView.vue        # Scheduled tasks + run logs
│   │   └── ErrorsView.vue       # Paginated error log
│   └── components/
│       ├── HealthIndicator.vue  # OK/WARNING/ERROR circle
│       └── DrillCard.vue        # Reusable navigation card
├── index.html
├── vite.config.ts
└── package.json                 # Separate from main NanoClaw
```

## Infrastructure

### Domain + Caddy

Cheap domain (~$2-10/yr). Caddy on server with Caddyfile:

```
nanoclaw.domain.xyz {
    root * /var/www/mini-app
    try_files {path} /index.html
    file_server

    handle /api/* {
        reverse_proxy localhost:3847
    }
}
```

Caddy auto-provisions Let's Encrypt certificate. Port 3847 closed externally via firewall.

### Telegram Bot Setup

- `bot.setMyMenuButton({ type: 'web_app', text: 'Dashboard', url: 'https://nanoclaw.domain.xyz' })` — persistent menu button
- `/check` command → responds with InlineKeyboard containing `web_app` button

### Deploy

Mini App build output deployed to `/var/www/mini-app/` on server. Can be integrated into existing deploy flow (git pull → build → copy).

## Domain Setup Guide

Steps to get a domain pointing to the Hetzner VPS (159.69.207.195):

### 1. Buy a domain

Cheap registrars: Namecheap, Porkbun, Cloudflare Registrar. Look for `.xyz`, `.site`, or `.dev` — typically $2-10/year.

Example: `mynanoclaw.xyz`

### 2. Configure DNS

In the registrar's DNS panel, add an **A record**:

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | `@` (or subdomain like `app`) | `159.69.207.195` | 300 |

If using a subdomain (e.g. `app.mynanoclaw.xyz`), set Name to `app` instead of `@`.

DNS propagation takes 5-60 minutes. Verify with: `dig +short app.mynanoclaw.xyz`

### 3. Install Caddy on server

```bash
ssh root@159.69.207.195

# Debian/Ubuntu (ARM)
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install caddy
```

### 4. Configure Caddy

Write `/etc/caddy/Caddyfile` with the domain (replace `app.mynanoclaw.xyz` with your actual domain):

```
app.mynanoclaw.xyz {
    root * /var/www/mini-app
    try_files {path} /index.html
    file_server

    handle /api/* {
        reverse_proxy localhost:3847
    }
}
```

Then: `systemctl reload caddy`

Caddy will automatically obtain a Let's Encrypt HTTPS certificate. Make sure ports 80 and 443 are open in the firewall:

```bash
ufw allow 80
ufw allow 443
```

### 5. Verify

Open `https://app.mynanoclaw.xyz` in a browser — should see the Caddy default page (until Mini App is deployed) with a valid HTTPS certificate.

## Future (out of scope)

- **Proactive error alerts** — bot sends message to main chat when error occurs. Builds on `error_log` table (flag `notified`).
- **Actions from Mini App** — restart containers, pause/resume tasks.
- **Metrics/charts** — task success rate over time, response latency.
