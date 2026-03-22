import pino from 'pino';
import { Writable } from 'stream';
import pretty from 'pino-pretty';

let dbWriter: ((logObj: Record<string, unknown>) => void) | null = null;

export function setErrorDbWriter(fn: (logObj: Record<string, unknown>) => void): void {
  dbWriter = fn;
}

const dbStream = new Writable({
  write(chunk, _encoding, callback) {
    if (dbWriter) {
      try {
        const obj = JSON.parse(chunk.toString());
        if (obj.level >= 50) dbWriter(obj);
      } catch {
        // ignore parse errors
      }
    }
    callback();
  },
});

const prettyStream = pretty({ colorize: true });

export const logger = pino(
  { level: process.env.LOG_LEVEL || 'info' },
  pino.multistream([
    { stream: prettyStream },
    { level: 'error', stream: dbStream },
  ]),
);

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
