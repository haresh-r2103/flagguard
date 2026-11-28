/**
 * Reads flags from Flagsmith and keeps them in memory, refreshing every few seconds.
 *
 * Why a cache: checking Flagsmith on every checkout would mean one API call per request,
 * which is slow and would use up the free plan's 50,000 requests a month in minutes under
 * simulated traffic. Polling every 10 s costs 360 calls an hour, whatever the traffic.
 * The trade-off: a change in Flagsmith reaches the shop up to 10 s later.
 */
export class FlagCache {
  private flags = new Map<string, boolean>();
  private timer: ReturnType<typeof setInterval> | undefined;
  lastRefreshOk = false;

  constructor(
    private readonly apiUrl: string,
    private readonly environmentKey: string,
    private readonly log: (message: string) => void = console.log,
  ) {}

  isEnabled(flag: string): boolean {
    // Unknown or not loaded yet: OFF. The old code is the safe default.
    return this.flags.get(flag) ?? false;
  }

  async refresh(): Promise<void> {
    try {
      const response = await fetch(`${this.apiUrl.replace(/\/+$/, '')}/flags/`, {
        headers: { 'X-Environment-Key': this.environmentKey },
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error(`Flagsmith returned ${response.status}`);
      const body = (await response.json()) as { feature: { name: string }; enabled: boolean }[];

      const next = new Map(body.map((f) => [f.feature.name, f.enabled]));
      for (const [name, enabled] of next) {
        if (this.flags.has(name) && this.flags.get(name) !== enabled) {
          this.log(`[flags] ${name} is now ${enabled ? 'ON' : 'OFF'}`);
        }
      }
      this.flags = next;
      this.lastRefreshOk = true;
    } catch (error) {
      // Keep the last known flags. A Flagsmith blip shouldn't flip features on or off.
      this.lastRefreshOk = false;
      this.log(`[flags] refresh failed, keeping last known flags: ${String(error)}`);
    }
  }

  start(intervalMs = 10_000): void {
    this.timer = setInterval(() => void this.refresh(), intervalMs);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }
}
