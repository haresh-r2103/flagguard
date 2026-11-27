import type { Evaluation } from './kill-rule.js';

export type Action =
  | 'none' // nothing to do
  | 'kill' // switch the flag off now (sent once per incident)
  | 'already_killed'; // killed earlier; waiting for a human to re-enable

export interface TrackerResult {
  action: Action;
  /** How many checks in a row have breached so far. */
  streak: number;
}

/**
 * Remembers, per flag, how many checks in a row have breached.
 *
 * - A breach adds 1 to the streak; any other verdict resets it to 0
 *   (Problem 4: one bad 5-second burst must not kill a feature).
 * - When the streak reaches `consecutiveBreaches`, it returns 'kill' exactly once.
 *   After that the flag is marked killed and further checks return 'already_killed',
 *   so the server never sends repeat kills or repeat alerts (Problem 6: deduplication).
 * - `reset()` is called when a human turns the flag back on.
 */
export class BreachTracker {
  private readonly streaks = new Map<string, number>();
  private readonly killed = new Set<string>();

  record(key: string, evaluation: Evaluation, consecutiveBreaches: number): TrackerResult {
    if (this.killed.has(key)) {
      return { action: 'already_killed', streak: this.streaks.get(key) ?? 0 };
    }

    const streak = evaluation.verdict === 'breach' ? (this.streaks.get(key) ?? 0) + 1 : 0;
    this.streaks.set(key, streak);

    if (streak >= consecutiveBreaches) {
      this.killed.add(key);
      return { action: 'kill', streak };
    }
    return { action: 'none', streak };
  }

  isKilled(key: string): boolean {
    return this.killed.has(key);
  }

  /** Forget the kill and the streak, e.g. after the flag is re-enabled. */
  reset(key: string): void {
    this.killed.delete(key);
    this.streaks.delete(key);
  }
}
