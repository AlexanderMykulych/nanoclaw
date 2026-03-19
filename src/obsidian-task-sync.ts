/**
 * Obsidian Task Sync
 * Reads scheduled task definitions from Obsidian markdown files
 * and syncs them to the NanoClaw database.
 *
 * Task files live in Memory/mao/scheduled-tasks/*.md with frontmatter:
 *   schedule: "daily 8:00, 20:00" | "weekly mon 9:00" | "every 30m" | cron
 *   group: telegram_main
 *   status: active | paused
 *
 * The body (after frontmatter) is the task prompt.
 * File name (without .md) becomes the task ID prefixed with "obs-".
 */

import fs from 'fs';
import path from 'path';

import {
  createTask,
  deleteTask,
  getAllTasks,
  getTaskById,
  updateTask,
} from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';
import { TIMEZONE } from './config.js';
import { CronExpressionParser } from 'cron-parser';

const OBSIDIAN_TASKS_SUBPATH = 'Memory/mao/scheduled-tasks';
const TASK_ID_PREFIX = 'obs-';

interface ObsidianTask {
  id: string;
  schedule: string;
  group: string;
  status: 'active' | 'paused';
  prompt: string;
  model?: string;
}

/**
 * Parse a human-readable schedule into a cron expression.
 *
 * Supported formats:
 *   daily 8:00              → 0 8 * * *
 *   daily 8:00, 20:00       → 0 8,20 * * *
 *   weekly mon 9:00         → 0 9 * * 1
 *   weekly mon,fri 9:00     → 0 9 * * 1,5
 *   every 30m               → *​/30 * * * *
 *   every 2h                → 0 *​/2 * * *
 *   0 8,20 * * *            → passed through as-is (cron)
 */
export function parseSchedule(schedule: string): {
  type: 'cron' | 'interval';
  value: string;
} {
  const s = schedule.trim();

  // Already a cron expression (5 space-separated fields with * or digits)
  if (/^[\d*\/,\-]+(\s+[\d*\/,\-]+){4}$/.test(s)) {
    return { type: 'cron', value: s };
  }

  // "every 30m" or "every 2h"
  const everyMatch = s.match(/^every\s+(\d+)\s*(m|h)$/i);
  if (everyMatch) {
    const n = parseInt(everyMatch[1], 10);
    const unit = everyMatch[2].toLowerCase();
    if (unit === 'm') {
      return { type: 'cron', value: `*/${n} * * * *` };
    }
    return { type: 'cron', value: `0 */${n} * * *` };
  }

  // "daily 8:00" or "daily 8:00, 20:00"
  const dailyMatch = s.match(/^daily\s+(.+)$/i);
  if (dailyMatch) {
    const times = dailyMatch[1].split(',').map((t) => t.trim());
    const hours: string[] = [];
    const minutes: string[] = [];
    for (const time of times) {
      const [h, m] = time.split(':');
      hours.push(h);
      minutes.push(m || '0');
    }
    // If all minutes are the same, use single minute field
    const uniqueMinutes = [...new Set(minutes)];
    const min = uniqueMinutes.length === 1 ? uniqueMinutes[0] : '0';
    return { type: 'cron', value: `${min} ${hours.join(',')} * * *` };
  }

  // "weekly mon 9:00" or "weekly mon,fri 9:00"
  const weeklyMatch = s.match(/^weekly\s+([\w,]+)\s+(\d{1,2}:\d{2})$/i);
  if (weeklyMatch) {
    const dayMap: Record<string, string> = {
      sun: '0',
      mon: '1',
      tue: '2',
      wed: '3',
      thu: '4',
      fri: '5',
      sat: '6',
    };
    const days = weeklyMatch[1]
      .split(',')
      .map((d) => dayMap[d.trim().toLowerCase()] || d.trim())
      .join(',');
    const [h, m] = weeklyMatch[2].split(':');
    return { type: 'cron', value: `${m || '0'} ${h} * * ${days}` };
  }

  // Fallback: treat as cron
  return { type: 'cron', value: s };
}

/**
 * Parse frontmatter and body from a markdown file.
 */
function parseMarkdownTask(
  filePath: string,
  filename: string,
): ObsidianTask | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!fmMatch) {
      logger.warn({ filePath }, 'Obsidian task: no frontmatter found');
      return null;
    }

    const frontmatter = fmMatch[1];
    const body = fmMatch[2].trim();

    const getValue = (key: string): string | undefined => {
      const match = frontmatter.match(
        new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, 'm'),
      );
      return match?.[1];
    };

    const schedule = getValue('schedule');
    const group = getValue('group');
    const status = getValue('status') as 'active' | 'paused' | undefined;
    const model = getValue('model');

    if (!schedule || !group) {
      logger.warn(
        { filePath },
        'Obsidian task: missing schedule or group in frontmatter',
      );
      return null;
    }

    if (!body) {
      logger.warn({ filePath }, 'Obsidian task: empty prompt body');
      return null;
    }

    const id = TASK_ID_PREFIX + filename.replace(/\.md$/, '');

    return {
      id,
      schedule,
      group,
      status: status || 'active',
      prompt: body,
      model,
    };
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to parse Obsidian task file');
    return null;
  }
}

/**
 * Compute next run time for a cron schedule.
 */
function computeNextRunFromCron(cronExpr: string): string {
  const interval = CronExpressionParser.parse(cronExpr, { tz: TIMEZONE });
  return interval.next().toDate().toISOString();
}

/**
 * Find the Obsidian tasks directory on the host filesystem.
 * Looks for the configured additional mount path that contains Memory_Obsidian.
 */
function findObsidianTasksDir(
  groups: Record<string, RegisteredGroup>,
): string | null {
  for (const group of Object.values(groups)) {
    const mounts = group.containerConfig?.additionalMounts;
    if (!mounts) continue;
    for (const mount of mounts) {
      if (mount.hostPath.includes('Memory_Obsidian')) {
        const tasksDir = path.join(mount.hostPath, OBSIDIAN_TASKS_SUBPATH);
        if (fs.existsSync(tasksDir)) {
          return tasksDir;
        }
        // Try creating the dir if parent exists
        const parentDir = path.join(mount.hostPath, 'Memory/mao');
        if (fs.existsSync(parentDir)) {
          fs.mkdirSync(tasksDir, { recursive: true });
          return tasksDir;
        }
      }
    }
  }
  return null;
}

/**
 * Sync Obsidian task files with the database.
 * - New files → create tasks
 * - Changed files → update tasks
 * - Deleted files → delete tasks
 *
 * Only manages tasks with the "obs-" prefix to avoid touching
 * tasks created through other means (IPC, MCP, etc.)
 */
export function syncObsidianTasks(
  groups: Record<string, RegisteredGroup>,
): void {
  const tasksDir = findObsidianTasksDir(groups);
  if (!tasksDir) {
    return; // Obsidian not mounted or tasks dir doesn't exist
  }

  // Read all .md files from the tasks directory
  let files: string[];
  try {
    files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.md'));
  } catch {
    return;
  }

  // Parse all Obsidian task files
  const obsidianTasks = new Map<string, ObsidianTask>();
  for (const file of files) {
    const task = parseMarkdownTask(path.join(tasksDir, file), file);
    if (task) {
      obsidianTasks.set(task.id, task);
    }
  }

  // Get all existing obs- tasks from DB
  const allDbTasks = getAllTasks();
  const existingObsTasks = allDbTasks.filter((t) =>
    t.id.startsWith(TASK_ID_PREFIX),
  );

  // Build a folder→jid lookup from registered groups
  const folderToJid: Record<string, string> = {};
  for (const [jid, group] of Object.entries(groups)) {
    folderToJid[group.folder] = jid;
  }

  // Sync: create or update
  for (const [id, obsTask] of obsidianTasks) {
    const chatJid = folderToJid[obsTask.group];
    if (!chatJid) {
      logger.warn(
        { taskId: id, group: obsTask.group },
        'Obsidian task: group not registered, skipping',
      );
      continue;
    }

    const parsed = parseSchedule(obsTask.schedule);
    const existingTask = getTaskById(id);

    if (!existingTask) {
      // Create new task
      const nextRun =
        obsTask.status === 'active'
          ? computeNextRunFromCron(parsed.value)
          : null;

      createTask({
        id,
        group_folder: obsTask.group,
        chat_jid: chatJid,
        prompt: obsTask.prompt,
        schedule_type: parsed.type,
        schedule_value: parsed.value,
        context_mode: 'group',
        next_run: nextRun,
        status: obsTask.status,
        created_at: new Date().toISOString(),
        model: obsTask.model,
      });

      logger.info(
        { taskId: id, schedule: obsTask.schedule, group: obsTask.group },
        'Obsidian task created',
      );
    } else {
      // Check if anything changed
      const changes: Record<string, unknown> = {};

      if (existingTask.prompt !== obsTask.prompt) {
        changes.prompt = obsTask.prompt;
      }
      if (existingTask.schedule_value !== parsed.value) {
        changes.schedule_value = parsed.value;
        changes.schedule_type = parsed.type;
        if (obsTask.status === 'active') {
          changes.next_run = computeNextRunFromCron(parsed.value);
        }
      }
      if (existingTask.status !== obsTask.status) {
        changes.status = obsTask.status;
        if (obsTask.status === 'active' && !existingTask.next_run) {
          changes.next_run = computeNextRunFromCron(parsed.value);
        }
      }
      if ((existingTask.model || null) !== (obsTask.model || null)) {
        changes.model = obsTask.model || null;
      }

      if (Object.keys(changes).length > 0) {
        updateTask(id, changes as Parameters<typeof updateTask>[1]);
        logger.info(
          { taskId: id, changes: Object.keys(changes) },
          'Obsidian task updated',
        );
      }
    }
  }

  // Delete tasks that no longer have a corresponding file
  for (const dbTask of existingObsTasks) {
    if (!obsidianTasks.has(dbTask.id)) {
      deleteTask(dbTask.id);
      logger.info(
        { taskId: dbTask.id },
        'Obsidian task deleted (file removed)',
      );
    }
  }
}
