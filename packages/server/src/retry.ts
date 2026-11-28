/**
 * Retry with exponential backoff (Problem 5).
 *
 * Waits 1 s, 2 s, 4 s ... between attempts, so a struggling server gets room to recover.
 * Only errors marked retryable are retried: a wrong key or a missing flag will never
 * fix itself, so retrying those just wastes time.
 */

export class RetryableError extends Error {}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  /** Injected so tests don't really wait. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

export const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { attempts = 4, baseDelayMs = 1_000, sleep = realSleep, onRetry } = options;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const canRetry = error instanceof RetryableError && attempt < attempts;
      if (!canRetry) throw error;
      const delayMs = baseDelayMs * 2 ** (attempt - 1); // 1 s, 2 s, 4 s
      onRetry?.(attempt, delayMs, error);
      await sleep(delayMs);
    }
  }
}
