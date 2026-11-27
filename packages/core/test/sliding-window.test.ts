import { describe, expect, it } from 'vitest';
import { errorRate, SlidingWindow, WindowStore, type FlagCounts } from '../src/index.js';

const SECOND = 1_000;

/** Counts for one 5 s batch: `onErrors` of `onRequests` failed on the ON path; OFF stays healthy. */
function batch(onRequests: number, onErrors: number, offRequests = 0, offErrors = 0): FlagCounts {
  return {
    on: { requests: onRequests, errors: onErrors },
    off: { requests: offRequests, errors: offErrors },
  };
}

describe('SlidingWindow', () => {
  it('starts empty', () => {
    const window = new SlidingWindow();
    expect(window.totals(0)).toEqual(batch(0, 0));
    expect(window.windowMs).toBe(60 * SECOND);
  });

  it('adds up several reports that land in the same bucket', () => {
    const window = new SlidingWindow();
    window.add(1 * SECOND, batch(10, 1, 10, 0), 2 * SECOND);
    window.add(2 * SECOND, batch(5, 2, 5, 1), 2 * SECOND);
    expect(window.totals(2 * SECOND)).toEqual(batch(15, 3, 15, 1));
  });

  it('drops counts once they are older than 60 seconds', () => {
    const window = new SlidingWindow();
    window.add(0, batch(100, 50), 0);
    expect(window.totals(55 * SECOND).on.requests).toBe(100); // still inside the window
    expect(window.totals(60 * SECOND).on.requests).toBe(0); // slid out
  });

  it('reuses a slot after a full lap without mixing old and new counts', () => {
    const window = new SlidingWindow();
    window.add(0, batch(100, 100), 0); // slice 0 -> slot 0
    window.add(60 * SECOND, batch(10, 0), 60 * SECOND); // slice 12 -> also slot 0
    expect(window.totals(60 * SECOND)).toEqual(batch(10, 0));
  });

  it('rejects reports that are too old or too far in the future', () => {
    const window = new SlidingWindow();
    const now = 120 * SECOND;
    expect(window.add(now - 61 * SECOND, batch(1, 1), now)).toBe(false);
    expect(window.add(now + 30 * SECOND, batch(1, 1), now)).toBe(false);
    expect(window.add(now - 10 * SECOND, batch(1, 1), now)).toBe(true);
    expect(window.totals(now).on.requests).toBe(1);
  });

  it('keeps fixed memory however many reports arrive', () => {
    const window = new SlidingWindow();
    for (let t = 0; t < 3_600 * SECOND; t += 5 * SECOND) {
      window.add(t, batch(500, 5), t);
    }
    // 12 slots regardless of an hour of traffic: the totals cover exactly 12 batches.
    expect(window.totals(3_595 * SECOND).on.requests).toBe(12 * 500);
  });

  it('rejects invalid options', () => {
    expect(() => new SlidingWindow({ bucketCount: 0 })).toThrow();
  });
});

describe('design-doc scenario: a bad deploy after an hour of healthy traffic', () => {
  // 100 requests/s = 500 per 5 s batch. Healthy: 1% errors. After the deploy: 80% errors.
  const deployAt = 3_600 * SECOND;
  const checkAt = deployAt + 15 * SECOND;

  function replay(window: SlidingWindow) {
    for (let t = 0; t < deployAt; t += 5 * SECOND) window.add(t, batch(500, 5), t + 5 * SECOND);
    for (let t = deployAt; t < checkAt; t += 5 * SECOND)
      window.add(t, batch(500, 400), t + 5 * SECOND);
  }

  it('the sliding window shows the spike within 15 seconds', () => {
    const window = new SlidingWindow();
    replay(window);
    const rate = errorRate(window.totals(checkAt).on);
    // 8 healthy batches + 3 bad ones in the window: (40 + 1200) / 5500 = 22.5%
    expect(rate).toBeCloseTo(0.225, 3);
  });

  it('a running total since start would bury the same spike', () => {
    let requests = 0;
    let errors = 0;
    for (let t = 0; t < deployAt; t += 5 * SECOND)
      [requests, errors] = [requests + 500, errors + 5];
    for (let t = deployAt; t < checkAt; t += 5 * SECOND)
      [requests, errors] = [requests + 500, errors + 400];
    expect(errors / requests).toBeLessThan(0.02); // about 1.3%: the bug is invisible
  });
});

describe('WindowStore', () => {
  it('tracks the same flag separately per environment', () => {
    const store = new WindowStore();
    store.get('production', 'new_checkout').add(0, batch(10, 5), 0);
    store.get('staging', 'new_checkout').add(0, batch(10, 0), 0);

    expect(store.size).toBe(2);
    expect(store.get('production', 'new_checkout').totals(0).on.errors).toBe(5);
    expect(store.get('staging', 'new_checkout').totals(0).on.errors).toBe(0);
    expect(
      store
        .entries()
        .map((e) => `${e.environment}/${e.flag}`)
        .sort(),
    ).toEqual(['production/new_checkout', 'staging/new_checkout']);
  });
});

describe('errorRate', () => {
  it('is 0 when there are no requests, instead of dividing by zero', () => {
    expect(errorRate({ requests: 0, errors: 0 })).toBe(0);
  });
});
