import crypto from 'crypto';

export function validateTelegramInitData(
  initData: string,
  botToken: string,
): boolean {
  if (!initData) return false;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return false;

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
