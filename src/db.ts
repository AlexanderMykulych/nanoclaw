import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS error_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      level TEXT NOT NULL,
      source TEXT,
      group_folder TEXT,
      message TEXT NOT NULL,
      stack TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_error_log_timestamp ON error_log(timestamp);

    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      cpu_percent REAL,
      mem_total_mb INTEGER,
      mem_used_mb INTEGER,
      mem_percent REAL,
      disk_total_gb REAL,
      disk_used_gb REAL,
      disk_percent REAL,
      load_avg_1 REAL,
      load_avg_5 REAL,
      load_avg_15 REAL,
      containers_active INTEGER,
      containers_queued INTEGER,
      uptime_seconds REAL
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp);

    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      group_folder TEXT,
      task_id TEXT,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp);
    CREATE INDEX IF NOT EXISTS idx_token_usage_task ON token_usage(task_id, timestamp);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add model column to scheduled_tasks if it doesn't exist
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN model TEXT`);
  } catch {
    /* column already exists */
  }

  // Add pre_check column to scheduled_tasks if it doesn't exist
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN pre_check TEXT`);
  } catch {
    /* column already exists */
  }

  // Add quarantine columns to scheduled_tasks
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN quarantined_at TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN quarantine_reason TEXT`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at, model, pre_check)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
    task.model || null,
    task.pre_check || null,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
      | 'model'
      | 'pre_check'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.model !== undefined) {
    fields.push('model = ?');
    values.push(updates.model);
  }
  if (updates.pre_check !== undefined) {
    fields.push('pre_check = ?');
    values.push(updates.pre_check);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND quarantined_at IS NULL
      AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function quarantineTask(id: string, reason: string): void {
  db.prepare(
    `UPDATE scheduled_tasks SET quarantined_at = ?, quarantine_reason = ? WHERE id = ?`,
  ).run(new Date().toISOString(), reason, id);
}

export function unquarantineTask(id: string): void {
  db.prepare(
    `UPDATE scheduled_tasks SET quarantined_at = NULL, quarantine_reason = NULL WHERE id = ?`,
  ).run(id);
}

export function getQuarantinedTasks(): ScheduledTask[] {
  return db
    .prepare(
      `SELECT * FROM scheduled_tasks WHERE quarantined_at IS NOT NULL ORDER BY quarantined_at DESC`,
    )
    .all() as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 0 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- error_log ---

export interface ErrorLogEntry {
  id: number;
  timestamp: string;
  level: string;
  source: string | null;
  group_folder: string | null;
  message: string;
  stack: string | null;
}

export interface LogErrorInput {
  level: string;
  source?: string;
  groupFolder?: string;
  message: string;
  stack?: string;
}

export function logError(input: LogErrorInput): void {
  db.prepare(
    `INSERT INTO error_log (level, source, group_folder, message, stack)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    input.level,
    input.source ?? null,
    input.groupFolder ?? null,
    input.message,
    input.stack ?? null,
  );
}

export function getErrors(opts: {
  limit: number;
  offset: number;
}): ErrorLogEntry[] {
  return db
    .prepare('SELECT * FROM error_log ORDER BY timestamp DESC LIMIT ? OFFSET ?')
    .all(opts.limit, opts.offset) as ErrorLogEntry[];
}

export function getErrorCountSince(minutes: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM error_log
       WHERE timestamp > datetime('now', '-' || ? || ' minutes')`,
    )
    .get(minutes) as { count: number };
  return row.count;
}

export function cleanupErrors(days: number): void {
  db.prepare(
    `DELETE FROM error_log WHERE timestamp < datetime('now', '-' || ? || ' days')`,
  ).run(days);
}

/** @internal - for tests only. Backdates all error_log entries by N days. */
export function _backdateErrors(days: number): void {
  db.prepare(
    `UPDATE error_log SET timestamp = datetime('now', '-' || ? || ' days')`,
  ).run(days);
}

// --- API query helpers ---

export function getRegisteredGroupsList(): Array<{
  jid: string;
  name: string;
  folder: string;
  last_message_time: string | null;
}> {
  return db
    .prepare(
      `SELECT g.jid, g.name, g.folder, c.last_message_time
       FROM registered_groups g
       LEFT JOIN chats c ON g.jid = c.jid
       ORDER BY c.last_message_time DESC`,
    )
    .all() as Array<{
    jid: string;
    name: string;
    folder: string;
    last_message_time: string | null;
  }>;
}

export function getScheduledTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY next_run ASC')
    .all() as ScheduledTask[];
}

export function getTaskRunLogs(taskId: string): Array<{
  run_at: string;
  duration_ms: number;
  status: string;
  result: string | null;
  error: string | null;
}> {
  return db
    .prepare(
      'SELECT run_at, duration_ms, status, result, error FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT 50',
    )
    .all(taskId) as Array<{
    run_at: string;
    duration_ms: number;
    status: string;
    result: string | null;
    error: string | null;
  }>;
}

// Auth/rate-limit errors to exclude from stats — these are infra issues, not task failures
const AUTH_ERROR_FILTER = `
  AND NOT (status = 'error' AND (
    error LIKE '%hit your limit%'
    OR error LIKE '%authenticate%'
    OR error LIKE '%bearer token%'
    OR error LIKE '%Credit bal%'
    OR error LIKE '%new token%'
  ))`;

export interface TaskStatsRow {
  task_id: string;
  total_runs: number;
  success_count: number;
  error_count: number;
  skipped_count: number;
  auth_error_count: number;
  avg_duration_ms: number;
  max_duration_ms: number;
  min_duration_ms: number;
  last_run: string | null;
  success_rate: number;
  precheck_saved_pct: number;
}

export function getTaskStats(days: number): TaskStatsRow[] {
  return db
    .prepare(
      `SELECT
        task_id,
        COUNT(*) as total_runs,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN status = 'error' AND NOT (
          error LIKE '%hit your limit%' OR error LIKE '%authenticate%'
          OR error LIKE '%bearer token%' OR error LIKE '%Credit bal%'
          OR error LIKE '%new token%'
        ) THEN 1 ELSE 0 END) as error_count,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped_count,
        SUM(CASE WHEN status = 'error' AND (
          error LIKE '%hit your limit%' OR error LIKE '%authenticate%'
          OR error LIKE '%bearer token%' OR error LIKE '%Credit bal%'
          OR error LIKE '%new token%'
        ) THEN 1 ELSE 0 END) as auth_error_count,
        COALESCE(ROUND(AVG(CASE WHEN status = 'success' THEN duration_ms END)), 0) as avg_duration_ms,
        COALESCE(MAX(CASE WHEN status = 'success' THEN duration_ms END), 0) as max_duration_ms,
        COALESCE(MIN(CASE WHEN status = 'success' THEN duration_ms END), 0) as min_duration_ms,
        MAX(CASE WHEN status != 'skipped' THEN run_at END) as last_run,
        COALESCE(ROUND(100.0 * SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) /
          NULLIF(
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) +
            SUM(CASE WHEN status = 'error' AND NOT (
              error LIKE '%hit your limit%' OR error LIKE '%authenticate%'
              OR error LIKE '%bearer token%' OR error LIKE '%Credit bal%'
              OR error LIKE '%new token%'
            ) THEN 1 ELSE 0 END),
          0), 1), 100.0) as success_rate,
        COALESCE(ROUND(100.0 * SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) /
          NULLIF(COUNT(*), 0), 1), 0) as precheck_saved_pct
      FROM task_run_logs
      WHERE run_at > datetime('now', '-' || ? || ' days')
      GROUP BY task_id
      ORDER BY success_rate ASC, total_runs DESC`,
    )
    .all(days) as TaskStatsRow[];
}

export interface TimelinePoint {
  run_at: string;
  duration_ms: number;
  status: string;
}

export function getTaskTimeline(taskId: string, days: number): TimelinePoint[] {
  return db
    .prepare(
      `SELECT
        strftime('%Y-%m-%dT%H:00', run_at) as run_at,
        ROUND(AVG(duration_ms)) as duration_ms,
        CASE WHEN SUM(CASE WHEN status = 'error' AND NOT (
          error LIKE '%hit your limit%' OR error LIKE '%authenticate%'
          OR error LIKE '%bearer token%' OR error LIKE '%Credit bal%'
          OR error LIKE '%new token%'
        ) THEN 1 ELSE 0 END) > 0 THEN 'error' ELSE 'success' END as status
      FROM task_run_logs
      WHERE task_id = ? AND status != 'skipped'
        ${AUTH_ERROR_FILTER}
        AND run_at > datetime('now', '-' || ? || ' days')
      GROUP BY strftime('%Y-%m-%dT%H:00', run_at)
      ORDER BY run_at ASC`,
    )
    .all(taskId, days) as TimelinePoint[];
}

// --- token usage ---

export interface TokenUsageRecord {
  group_folder: string | null;
  task_id: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export function insertTokenUsage(record: TokenUsageRecord): void {
  db.prepare(
    `INSERT INTO token_usage (group_folder, task_id, model, input_tokens, output_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    record.group_folder,
    record.task_id,
    record.model,
    record.input_tokens,
    record.output_tokens,
    record.cost_usd,
  );
}

export interface UsageSummaryRow {
  date: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  request_count: number;
}

export function getTokenUsageSummary(days: number): UsageSummaryRow[] {
  return db
    .prepare(
      `SELECT
        date(timestamp) as date,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        ROUND(SUM(cost_usd), 4) as cost_usd,
        COUNT(*) as request_count
      FROM token_usage
      WHERE timestamp > datetime('now', '-' || ? || ' days')
      GROUP BY date(timestamp)
      ORDER BY date ASC`,
    )
    .all(days) as UsageSummaryRow[];
}

export interface UsageByTaskRow {
  task_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  request_count: number;
}

export function getTokenUsageByTask(days: number): UsageByTaskRow[] {
  return db
    .prepare(
      `SELECT
        COALESCE(task_id, '(messages)') as task_id,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        ROUND(SUM(cost_usd), 4) as cost_usd,
        COUNT(*) as request_count
      FROM token_usage
      WHERE timestamp > datetime('now', '-' || ? || ' days')
      GROUP BY task_id
      ORDER BY cost_usd DESC`,
    )
    .all(days) as UsageByTaskRow[];
}

export function cleanupTokenUsage(days: number): void {
  db.prepare(
    `DELETE FROM token_usage WHERE timestamp < datetime('now', '-' || ? || ' days')`,
  ).run(days);
}

// --- metrics ---

export interface MetricRow {
  id: number;
  timestamp: string;
  cpu_percent: number;
  mem_total_mb: number;
  mem_used_mb: number;
  mem_percent: number;
  disk_total_gb: number;
  disk_used_gb: number;
  disk_percent: number;
  load_avg_1: number;
  load_avg_5: number;
  load_avg_15: number;
  containers_active: number;
  containers_queued: number;
  uptime_seconds: number;
}

export function insertMetric(
  metric: Omit<MetricRow, 'id' | 'timestamp'>,
): void {
  db.prepare(
    `
    INSERT INTO metrics (cpu_percent, mem_total_mb, mem_used_mb, mem_percent, disk_total_gb, disk_used_gb, disk_percent, load_avg_1, load_avg_5, load_avg_15, containers_active, containers_queued, uptime_seconds)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    metric.cpu_percent,
    metric.mem_total_mb,
    metric.mem_used_mb,
    metric.mem_percent,
    metric.disk_total_gb,
    metric.disk_used_gb,
    metric.disk_percent,
    metric.load_avg_1,
    metric.load_avg_5,
    metric.load_avg_15,
    metric.containers_active,
    metric.containers_queued,
    metric.uptime_seconds,
  );
}

export function getMetrics(hours: number): MetricRow[] {
  return db
    .prepare(
      `SELECT * FROM metrics WHERE timestamp > datetime('now', '-' || ? || ' hours') ORDER BY timestamp ASC`,
    )
    .all(hours) as MetricRow[];
}

export function cleanupMetrics(days: number): void {
  db.prepare(
    `DELETE FROM metrics WHERE timestamp < datetime('now', '-' || ? || ' days')`,
  ).run(days);
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
