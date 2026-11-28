import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GuardEvent } from './guardian.js';

/**
 * The permanent record (Problems 6 and 7): every kill, dry-run decision and failure,
 * one JSON object per line ("JSON Lines"). Alerts can be missed; this file is the history.
 *
 * Windows live in memory and may be lost on restart (60 s of data). This file is not:
 * it's written to disk on every event, so the history survives crashes and restarts.
 */
export class AuditLog {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(event: GuardEvent): void {
    const record = { ...event, at: new Date(event.at).toISOString() };
    // appendFileSync writes the whole line before returning, so one line = one complete record.
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, 'utf8');
  }

  /** The most recent records, newest last. Skips a damaged line instead of failing. */
  recent(limit = 20): unknown[] {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
  }
}
