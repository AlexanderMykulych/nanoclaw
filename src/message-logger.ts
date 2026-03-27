/**
 * Logs all bot conversations (incoming + outgoing) to Obsidian vault.
 * Format: Memory/mao/bot-messages/YYYY-MM-DD/<group>.md
 * Each line: [HH:MM] Sender: text
 */
import fs from 'fs';
import path from 'path';
import { OBSIDIAN_VAULT_PATH, TIMEZONE } from './config.js';
import { logger } from './logger.js';

function getLocalDate(): { dateFolder: string; time: string } {
  const now = new Date();
  const local = new Date(
    now.toLocaleString('en-US', { timeZone: TIMEZONE }),
  );
  const yyyy = local.getFullYear();
  const mm = String(local.getMonth() + 1).padStart(2, '0');
  const dd = String(local.getDate()).padStart(2, '0');
  const hh = String(local.getHours()).padStart(2, '0');
  const min = String(local.getMinutes()).padStart(2, '0');
  return { dateFolder: `${yyyy}-${mm}-${dd}`, time: `${hh}:${min}` };
}

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
}

function appendToLog(
  groupName: string,
  sender: string,
  text: string,
): void {
  try {
    const { dateFolder, time } = getLocalDate();
    const dir = path.join(OBSIDIAN_VAULT_PATH, 'mao', 'bot-messages', dateFolder);
    fs.mkdirSync(dir, { recursive: true });

    const filename = sanitizeFilename(groupName) + '.md';
    const filePath = path.join(dir, filename);
    const line = `[${time}] ${sender}: ${text.replace(/\n/g, ' ')}\n`;

    fs.appendFileSync(filePath, line);
  } catch (err) {
    logger.warn({ err, groupName }, 'Failed to log message to Obsidian');
  }
}

export function logIncomingMessage(
  groupName: string,
  senderName: string,
  text: string,
): void {
  appendToLog(groupName, senderName, text);
}

export function logOutgoingMessage(
  groupName: string,
  text: string,
): void {
  appendToLog(groupName, 'Mao', text);
}
