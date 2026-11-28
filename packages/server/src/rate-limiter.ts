/**
 * Token bucket rate limiter (Problem 7: a flood must not crash FlagGuard).
 *
 * Each client has a bucket that holds up to `burst` tokens and refills at `perSecond` tokens
 * per second. Every request takes one token. An empty bucket means "too many requests".
 * A well-behaved SDK sends one report per flag every 5 seconds, so it never runs dry.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    /** Upper bound on tracked clients, so the limiter itself can't use unbounded memory. */
    private readonly maxClients = 10_000,
  ) {}

  take(client: string, now: number): { allowed: boolean; retryAfterSeconds: number } {
    const bucket = this.buckets.get(client) ?? { tokens: this.burst, updatedAt: now };

    // Refill for the time that has passed since this client's last request.
    const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(this.burst, bucket.tokens + elapsedSeconds * this.perSecond);
    bucket.updatedAt = now;

    if (!this.buckets.has(client)) this.makeRoom();
    this.buckets.set(client, bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const retryAfterSeconds = Math.ceil((1 - bucket.tokens) / this.perSecond);
    return { allowed: false, retryAfterSeconds };
  }

  get size(): number {
    return this.buckets.size;
  }

  /** Drop the oldest entry when full. Maps keep insertion order, so the first key is the oldest. */
  private makeRoom(): void {
    if (this.buckets.size < this.maxClients) return;
    const oldest = this.buckets.keys().next().value;
    if (oldest !== undefined) this.buckets.delete(oldest);
  }
}
