import { describe, expect, it } from 'vitest';
import {
  BreachTracker,
  DEFAULT_KILL_RULE,
  evaluate,
  SlidingWindow,
  type FlagCounts,
} from '../src/index.js';

function counts(onReq: number, onErr: number, offReq: number, offErr: number): FlagCounts {
  return { on: { requests: onReq, errors: onErr }, off: { requests: offReq, errors: offErr } };
}

describe('evaluate: Problem 2 scenarios (baseline comparison)', () => {
  it('database outage: both paths fail 100%, so no breach', () => {
    const result = evaluate(counts(500, 500, 500, 500));
    expect(result.verdict).toBe('healthy');
    expect(result.diff).toBe(0);
  });

  it('real bug: ON 80% vs OFF 1%, so breach', () => {
    const result = evaluate(counts(500, 400, 500, 5));
    expect(result.verdict).toBe('breach');
    expect(result.diff).toBeCloseTo(0.79);
  });
});

describe('evaluate: Problem 4 scenarios (avoiding false alarms)', () => {
  it('3 AM, 3 requests with 1 random failure: wait for more data', () => {
    expect(evaluate(counts(3, 1, 200, 2)).verdict).toBe('insufficient_data');
  });

  it('just at the minimum sample size, a real bug is judged', () => {
    expect(evaluate(counts(50, 40, 200, 2)).verdict).toBe('breach');
  });

  it('a small gap within 5 points is healthy', () => {
    expect(evaluate(counts(1000, 40, 1000, 10)).verdict).toBe('healthy'); // 4% vs 1%
  });

  it('floor: with a strict gap setting, a tiny real difference is still ignored', () => {
    // ON 0.6% vs OFF 0.1% is 0.5 points: above a strict 0.2-point gap, but under the 2% floor.
    const strict = { ...DEFAULT_KILL_RULE, maxDiff: 0.002 };
    expect(evaluate(counts(10_000, 60, 10_000, 10), strict).verdict).toBe('below_floor');
  });
});

describe('evaluate: no baseline (found while coding)', () => {
  // A flag rolled out to 100% sends no OFF traffic, so there is nothing to compare with.
  it('falls back to an absolute limit: 30% errors is a breach', () => {
    const result = evaluate(counts(500, 150, 0, 0));
    expect(result.verdict).toBe('breach');
    expect(result.usedBaseline).toBe(false);
    expect(result.offRate).toBeNull();
  });

  it('falls back to an absolute limit: 10% errors is tolerated', () => {
    expect(evaluate(counts(500, 50, 0, 0)).verdict).toBe('healthy');
  });
});

describe('BreachTracker: consecutive breaches and deduplication', () => {
  const breach = evaluate(counts(500, 400, 500, 5));
  const healthy = evaluate(counts(500, 5, 500, 5));
  const n = DEFAULT_KILL_RULE.consecutiveBreaches;

  it('one bad burst then recovery: never kills', () => {
    const tracker = new BreachTracker();
    expect(tracker.record('f', breach, n)).toEqual({ action: 'none', streak: 1 });
    expect(tracker.record('f', breach, n)).toEqual({ action: 'none', streak: 2 });
    expect(tracker.record('f', healthy, n)).toEqual({ action: 'none', streak: 0 }); // reset
    expect(tracker.record('f', breach, n)).toEqual({ action: 'none', streak: 1 });
  });

  it('3 breaches in a row: kills exactly once, then stays quiet', () => {
    const tracker = new BreachTracker();
    tracker.record('f', breach, n);
    tracker.record('f', breach, n);
    expect(tracker.record('f', breach, n).action).toBe('kill');
    expect(tracker.record('f', breach, n).action).toBe('already_killed');
    expect(tracker.isKilled('f')).toBe(true);
  });

  it('tracks flags independently', () => {
    const tracker = new BreachTracker();
    tracker.record('a', breach, n);
    tracker.record('a', breach, n);
    expect(tracker.record('b', breach, n).streak).toBe(1);
  });

  it('reset after a human re-enables the flag starts from zero', () => {
    const tracker = new BreachTracker();
    for (let i = 0; i < n; i++) tracker.record('f', breach, n);
    tracker.reset('f');
    expect(tracker.isKilled('f')).toBe(false);
    expect(tracker.record('f', breach, n)).toEqual({ action: 'none', streak: 1 });
  });
});

describe('end to end in the core: window -> evaluate -> tracker', () => {
  it('kills on the 3rd check after a bad deploy, about 15 s in', () => {
    const SECOND = 1_000;
    const window = new SlidingWindow();
    const tracker = new BreachTracker();
    const deployAt = 600 * SECOND;
    const actions: { at: number; action: string }[] = [];

    // A report and a check every 5 s. Healthy for 10 minutes, then the ON path fails 80%.
    for (let t = 0; t < deployAt + 60 * SECOND; t += 5 * SECOND) {
      const bad = t >= deployAt;
      window.add(t, counts(100, bad ? 80 : 1, 100, 1), t + 5 * SECOND);
      const now = t + 5 * SECOND;
      const result = tracker.record('new_checkout', evaluate(window.totals(now)), 3);
      if (result.action !== 'none')
        actions.push({ at: (now - deployAt) / SECOND, action: result.action });
    }

    expect(actions[0]).toEqual({ at: 15, action: 'kill' });
    expect(actions.slice(1).every((a) => a.action === 'already_killed')).toBe(true);
  });
});
