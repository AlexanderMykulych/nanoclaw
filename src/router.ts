import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

/**
 * Format conversation history (including bot messages) as XML context.
 * Used when a session is reset so the agent has context about the recent conversation.
 */
export function formatConversationHistory(
  messages: NewMessage[],
  timezone: string,
  assistantName: string,
): string {
  if (messages.length === 0) return '';

  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const role = m.is_bot_message ? 'assistant' : 'user';
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}" role="${role}">${escapeXml(m.content)}</message>`;
  });

  return `<conversation_history note="Recent conversation for context. Your previous session was reset, so this history is provided to maintain continuity. You are ${escapeXml(assistantName)}.">\n${lines.join('\n')}\n</conversation_history>\n\n`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
