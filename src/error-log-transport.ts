import { logError, type LogErrorInput } from './db.js';

const LEVEL_NAMES: Record<number, string> = {
  50: 'error',
  60: 'fatal',
};

export function shouldLogToDb(level: number): boolean {
  return level >= 50;
}

export function extractErrorFields(
  logObj: Record<string, unknown>,
): LogErrorInput {
  const level = LEVEL_NAMES[logObj.level as number] ?? 'error';
  const err = logObj.err as { message?: string; stack?: string } | undefined;

  return {
    level,
    source: logObj.source as string | undefined,
    groupFolder: logObj.groupFolder as string | undefined,
    message: (logObj.msg as string) || err?.message || 'Unknown error',
    stack: err?.stack,
  };
}

export function writeErrorToDb(logObj: Record<string, unknown>): void {
  if (!shouldLogToDb(logObj.level as number)) return;
  const fields = extractErrorFields(logObj);
  logError(fields);
}
