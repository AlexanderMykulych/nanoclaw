import { describe, it, expect, beforeEach, vi } from 'vitest';
import { shouldLogToDb, extractErrorFields } from './error-log-transport.js';

describe('error-log-transport', () => {
  it('filters by log level — only error and fatal', () => {
    expect(shouldLogToDb(50)).toBe(true);  // error
    expect(shouldLogToDb(60)).toBe(true);  // fatal
    expect(shouldLogToDb(30)).toBe(false); // info
    expect(shouldLogToDb(40)).toBe(false); // warn
  });

  it('extracts structured fields from pino log object', () => {
    const logObj = {
      level: 50,
      msg: 'Container spawn failed',
      source: 'container',
      groupFolder: 'main-chat',
      err: { message: 'ENOENT', stack: 'Error: ENOENT\n  at ...' },
    };
    const fields = extractErrorFields(logObj);
    expect(fields).toEqual({
      level: 'error',
      source: 'container',
      groupFolder: 'main-chat',
      message: 'Container spawn failed',
      stack: 'Error: ENOENT\n  at ...',
    });
  });

  it('handles log objects without structured fields', () => {
    const logObj = { level: 50, msg: 'Something failed' };
    const fields = extractErrorFields(logObj);
    expect(fields).toEqual({
      level: 'error',
      source: undefined,
      groupFolder: undefined,
      message: 'Something failed',
      stack: undefined,
    });
  });
});
