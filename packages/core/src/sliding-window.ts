import { emptyCounts, type FlagCounts } from './types.js';

export interface SlidingWindowOptions {
  /** Width of one bucket in milliseconds. Matches the SDK's 5 s batch interval. */
  bucketMs?: number;
  /** Number of buckets. 12 x 5 s = a 60 s window. */
  bucketCount?: number;
}

/**
 * One slot of the ring buffer. `index` records which time slice the counts belong to,
 * so a slot left over from an earlier lap round the ring can be recognised as stale.
 */
interface Slot {
  index: number;
  counts: FlagCounts;
}

/**
 * A sliding window of request and error counts for one flag, stored as a ring buffer.
 *
 * Time is cut into fixed slices of `bucketMs`. Slice number = floor(timestamp / bucketMs).
 * Slice n lives in slot n % bucketCount, so memory stays at `bucketCount` slots forever,
 * however much traffic arrives. A slot is reused when time comes back round to it.
 *
 * Every method takes `now` as an argument instead of reading the clock itself.
 * That makes the window deterministic: tests can replay any timeline instantly.
 */
export class SlidingWindow {
  readonly bucketMs: number;
  readonly bucketCount: number;
  private readonly slots: (Slot | undefined)[];

  constructor(options: SlidingWindowOptions = {}) {
    this.bucketMs = options.bucketMs ?? 5_000;
    this.bucketCount = options.bucketCount ?? 12;
    if (this.bucketMs <= 0 || this.bucketCount <= 0) {
      throw new Error('bucketMs and bucketCount must be positive');
    }
    this.slots = new Array<Slot | undefined>(this.bucketCount).fill(undefined);
  }

  /** Length of the whole window in milliseconds (60 000 by default). */
  get windowMs(): number {
    return this.bucketMs * this.bucketCount;
  }

  /**
   * Add counts that happened at `timestamp`.
   * Returns false, and ignores the counts, if they fall outside the window:
   * older than the window, or more than one bucket in the future (a client with a bad clock).
   */
  add(timestamp: number, counts: FlagCounts, now: number): boolean {
    const index = this.sliceOf(timestamp);
    const nowIndex = this.sliceOf(now);
    if (index <= nowIndex - this.bucketCount || index > nowIndex + 1) {
      return false;
    }

    const position = this.positionOf(index);
    let slot = this.slots[position];
    if (slot === undefined || slot.index !== index) {
      // Empty, or left over from an earlier lap: start this slice fresh.
      slot = { index, counts: emptyCounts() };
      this.slots[position] = slot;
    }

    slot.counts.on.requests += counts.on.requests;
    slot.counts.on.errors += counts.on.errors;
    slot.counts.off.requests += counts.off.requests;
    slot.counts.off.errors += counts.off.errors;
    return true;
  }

  /** Sum of all counts in the window that ends at `now`. Stale slots are skipped. */
  totals(now: number): FlagCounts {
    const nowIndex = this.sliceOf(now);
    const oldestIndex = nowIndex - this.bucketCount + 1;
    const total = emptyCounts();

    for (const slot of this.slots) {
      if (slot === undefined || slot.index < oldestIndex || slot.index > nowIndex + 1) {
        continue;
      }
      total.on.requests += slot.counts.on.requests;
      total.on.errors += slot.counts.on.errors;
      total.off.requests += slot.counts.off.requests;
      total.off.errors += slot.counts.off.errors;
    }
    return total;
  }

  private sliceOf(timestamp: number): number {
    return Math.floor(timestamp / this.bucketMs);
  }

  private positionOf(index: number): number {
    // JavaScript's % can return negatives; this keeps the position in 0..bucketCount-1.
    return ((index % this.bucketCount) + this.bucketCount) % this.bucketCount;
  }
}
