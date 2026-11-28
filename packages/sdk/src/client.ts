/**
 * The FlagGuard SDK: what an app installs.
 *
 *   const fg = new FlagGuardClient({ url, ingestKey, environment: 'production' });
 *   const isOn = flags.isFeatureEnabled('new_checkout');      // from the Flagsmith SDK
 *   await fg.guard('new_checkout', isOn, () => (isOn ? newCheckout() : oldCheckout()));
 *
 * Design (Problems 1 and 2):
 * - guard() only adds to counters in memory. It never waits on the network.
 * - Every 5 s, one report per flag is sent in the background, with a short timeout.
 * - Any reporting problem is swallowed (fail-open): FlagGuard being down must never break the app.
 * - Both paths are counted: ON is the new code, OFF is the baseline.
 */

interface PathCounts {
  requests: number;
  errors: number;
}

interface Batch {
  windowStart: number;
  on: PathCounts;
  off: PathCounts;
}

export interface FlagGuardClientOptions {
  /** FlagGuard server, e.g. http://localhost:4000 */
  url: string;
  /** Can only send reports. Never the Flagsmith admin key. */
  ingestKey: string;
  /** Must match an environment listed for the flag in flagguard.yml. */
  environment: string;
  flushIntervalMs?: number;
  timeoutMs?: number;
  /** Upper bound on flags counted at once, so a bug can't grow memory without limit. */
  maxFlags?: number;
  /** Called when a report fails. Default: nothing (fail silently). */
  onError?: (error: unknown) => void;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export class FlagGuardClient {
  private batches = new Map<string, Batch>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> | undefined;
  private readonly opts: Required<Omit<FlagGuardClientOptions, 'onError'>> &
    Pick<FlagGuardClientOptions, 'onError'>;

  constructor(options: FlagGuardClientOptions) {
    this.opts = {
      flushIntervalMs: 5_000,
      timeoutMs: 500,
      maxFlags: 1_000,
      fetchFn: fetch,
      now: Date.now,
      ...options,
      url: options.url.replace(/\/+$/, ''),
    };
    if (this.opts.flushIntervalMs > 0) {
      this.timer = setInterval(() => void this.flush(), this.opts.flushIntervalMs);
      // Don't keep a short-lived script alive just for this timer.
      this.timer.unref?.();
    }
  }

  /**
   * Run `fn` and count it against `flag`: as ON if `isOn`, else as OFF (the baseline).
   * If `fn` throws, the error is counted and then re-thrown unchanged, so the app's own
   * error handling (a fallback, an error page) works exactly as before.
   */
  async guard<T>(flag: string, isOn: boolean, fn: () => T | Promise<T>): Promise<T> {
    try {
      const result = await fn();
      this.record(flag, isOn, true);
      return result;
    } catch (error) {
      this.record(flag, isOn, false);
      throw error;
    }
  }

  /** Count one outcome by hand, for code that doesn't fit in a function (e.g. a callback). */
  record(flag: string, isOn: boolean, ok: boolean): void {
    let batch = this.batches.get(flag);
    if (batch === undefined) {
      if (this.batches.size >= this.opts.maxFlags) return; // bounded memory: drop, don't grow
      batch = {
        windowStart: this.opts.now(),
        on: { requests: 0, errors: 0 },
        off: { requests: 0, errors: 0 },
      };
      this.batches.set(flag, batch);
    }
    const path = isOn ? batch.on : batch.off;
    path.requests += 1;
    if (!ok) path.errors += 1;
  }

  /**
   * Send everything counted so far: one report per flag, all in parallel.
   * Swap in fresh counters first, so counting carries on while the reports are in flight.
   * Never throws. If a flush is already running, waits for it instead of starting another.
   */
  flush(): Promise<void> {
    if (this.flushing !== undefined) return this.flushing;
    const batches = this.batches;
    this.batches = new Map();
    if (batches.size === 0) return Promise.resolve();

    this.flushing = Promise.allSettled(
      [...batches].map(([flag, batch]) => this.send(flag, batch)),
    ).then((results) => {
      this.flushing = undefined;
      for (const r of results) if (r.status === 'rejected') this.opts.onError?.(r.reason);
    });
    return this.flushing;
  }

  /** Stop the timer and send what's left. Call on shutdown. */
  async close(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.flushing;
    await this.flush();
  }

  private async send(flag: string, batch: Batch): Promise<void> {
    const response = await this.opts.fetchFn(`${this.opts.url}/v1/report`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.ingestKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        flag,
        environment: this.opts.environment,
        window_start: new Date(batch.windowStart).toISOString(),
        on: batch.on,
        off: batch.off,
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    // Dropped, not retried: by the next flush there's newer data, and a 4xx won't fix itself.
    if (!response.ok) throw new Error(`FlagGuard report for ${flag} returned ${response.status}`);
  }
}
