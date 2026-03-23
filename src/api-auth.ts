import crypto from 'crypto';

const MAX_AUTH_AGE_SECONDS = 300; // 5 minutes

export function validateTelegramInitData(
  initData: string,
  botToken: string,
): boolean {
  if (!initData) return false;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return false;

  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > MAX_AUTH_AGE_SECONDS) {
    return false;
  }

  params.delete('hash');
  const checkString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();
  const computedHash = crypto
    .createHmac('sha256', secret)
    .update(checkString)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(hash, 'hex'),
    Buffer.from(computedHash, 'hex'),
  );
}
