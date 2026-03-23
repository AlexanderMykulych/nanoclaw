import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { validateTelegramInitData } from './api-auth.js';

const BOT_TOKEN = 'test:fake-bot-token';

function buildInitData(params: Record<string, string>, token: string): string {
  const secret = crypto
    .createHmac('sha256', 'WebAppData')
    .update(token)
    .digest();
  const checkEntries = Object.entries(params)
    .filter(([k]) => k !== 'hash')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const hash = crypto
    .createHmac('sha256', secret)
    .update(checkEntries)
    .digest('hex');
  return new URLSearchParams({ ...params, hash }).toString();
}

describe('validateTelegramInitData', () => {
  it('accepts valid initData', () => {
    const authDate = Math.floor(Date.now() / 1000).toString();
    const initData = buildInitData(
      { auth_date: authDate, user: '{"id":123}', query_id: 'test' },
      BOT_TOKEN,
    );
    expect(validateTelegramInitData(initData, BOT_TOKEN)).toBe(true);
  });

  it('rejects tampered initData', () => {
    const authDate = Math.floor(Date.now() / 1000).toString();
    const initData = buildInitData(
      { auth_date: authDate, user: '{"id":123}' },
      BOT_TOKEN,
    );
    const tampered = initData.replace('123', '456');
    expect(validateTelegramInitData(tampered, BOT_TOKEN)).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateTelegramInitData('', BOT_TOKEN)).toBe(false);
  });

  it('rejects missing hash', () => {
    expect(validateTelegramInitData('auth_date=123&user=test', BOT_TOKEN)).toBe(
      false,
    );
  });

  it('rejects expired initData (older than 24 hours)', () => {
    const expiredDate = (Math.floor(Date.now() / 1000) - 90000).toString();
    const initData = buildInitData(
      { auth_date: expiredDate, user: '{"id":123}', query_id: 'test' },
      BOT_TOKEN,
    );
    expect(validateTelegramInitData(initData, BOT_TOKEN)).toBe(false);
  });
});
