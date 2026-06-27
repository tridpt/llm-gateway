import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Structured JSON logger. Writes one JSON object per line (JSONL) which is
 * trivial to grep, tail, or ship to a log aggregator.
 */
class Logger {
  constructor() {
    this.stream = null;
    if (config.logging.toFile) {
      const dir = path.isAbsolute(config.logging.dir)
        ? config.logging.dir
        : path.join(config.rootDir, config.logging.dir);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'gateway.log');
      this.stream = fs.createWriteStream(file, { flags: 'a' });
    }
  }

  _write(level, message, meta = {}) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      message,
      ...meta,
    };
    const line = JSON.stringify(entry);

    const consoleFn = level === 'error' ? console.error : console.log;
    consoleFn(`[${entry.ts}] ${level.toUpperCase()} ${message}`, meta.requestId ? `(${meta.requestId})` : '');

    if (this.stream) this.stream.write(line + '\n');
  }

  info(message, meta) {
    this._write('info', message, meta);
  }

  warn(message, meta) {
    this._write('warn', message, meta);
  }

  error(message, meta) {
    this._write('error', message, meta);
  }
}

export const logger = new Logger();
