import { BreachTracker, evaluate, type Evaluation, type WindowStore } from '@flagguard/core';
import type { ServerConfig } from './config.js';
import type { FlagController } from './flagsmith.js';
import { withRetry, type RetryOptions } from './retry.js';

/** What happened to a flag on a check. Phase 5 turns these into alerts and audit records. */
export interface GuardEvent {
  type: 'would_kill' | 'killed' | 'kill_failed';
  environment: string;
  flag: string;
  at: number;
  evaluation: Evaluation;
  requestsOn: number;
  requestsOff: number;
  error?: string;
}

export interface GuardianDeps {
  config: ServerConfig;
  store: WindowStore;
  controller: FlagController;
  tracker?: BreachTracker;
  now?: () => number;
  onEvent?: (event: GuardEvent) => void | Promise<void>;
  retry?: RetryOptions;
  log?: (message: string) => void;
}

/**
 * The check loop. Every interval it visits each guarded flag and runs the core:
 *   window.totals(now) -> evaluate() -> tracker.record() -> act if 'kill'.
 */
export class Guardian {
  private readonly tracker: BreachTracker;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly deps: GuardianDeps) {
    this.tracker = deps.tracker ?? new BreachTracker();
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? console.log;
  }

  /** One pass over every guarded flag. Returns the events it produced. */
  async checkOnce(): Promise<GuardEvent[]> {
    const { config, store } = this.deps;
    const events: GuardEvent[] = [];
    const now = this.now();

    for (const { environment, flag, rule } of config.guardedFlags()) {
      const totals = store.get(environment, flag).totals(now);
      const evaluation = evaluate(totals, rule);
      const key = `${environment}/${flag}`;
      const { action, streak } = this.tracker.record(key, evaluation, rule.consecutiveBreaches);

      if (evaluation.verdict === 'breach' && action === 'none') {
        this.log(
          `[check] ${key} breach ${streak}/${rule.consecutiveBreaches} (${describe(evaluation)})`,
        );
      }
      if (action !== 'kill') continue;

      const base = {
        environment,
        flag,
        at: now,
        evaluation,
        requestsOn: totals.on.requests,
        requestsOff: totals.off.requests,
      };

      if (config.dryRun) {
        this.log(`[dry run] would disable ${key} (${describe(evaluation)})`);
        events.push({ ...base, type: 'would_kill' });
        continue;
      }

      try {
        await withRetry(() => this.deps.controller.disable(environment, flag), {
          ...this.deps.retry,
          onRetry: (attempt, delayMs, error) =>
            this.log(
              `[act] ${key} attempt ${attempt} failed (${String(error)}); retrying in ${delayMs} ms`,
            ),
        });
        this.log(`[act] disabled ${key} in Flagsmith (${describe(evaluation)})`);
        events.push({ ...base, type: 'killed' });
      } catch (error) {
        // The flag is probably still ON. Forget the kill so later checks try again,
        // and raise an urgent event so a human can switch it off by hand.
        this.tracker.reset(key);
        this.log(`[act] FAILED to disable ${key}: ${String(error)}`);
        events.push({ ...base, type: 'kill_failed', error: String(error) });
      }
    }

    for (const event of events) await this.deps.onEvent?.(event);
    return events;
  }

  /** Run checkOnce every `intervalMs`. A slow check (retries) never overlaps the next one. */
  start(intervalMs = 5_000): void {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.checkOnce()
        .catch((error: unknown) => this.log(`[check] error: ${String(error)}`))
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  /** Call when a human re-enables a flag, so it is guarded again from a clean slate. */
  reset(environment: string, flag: string): void {
    this.tracker.reset(`${environment}/${flag}`);
  }
}

function describe(e: Evaluation): string {
  const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
  return `on ${pct(e.onRate)} vs off ${pct(e.offRate)}`;
}
