import { errorRate, type FlagCounts } from './types.js';

/**
 * Thresholds for one flag. Rates are fractions: 0.05 means 5%.
 * Defaults are the values from the design doc (Problem 4).
 */
export interface KillRuleConfig {
  /** Do not judge the ON path until it has this many requests in the window. */
  minRequests: number;
  /** Kill only if ON's error rate is more than this much above OFF's (0.05 = 5 points). */
  maxDiff: number;
  /** Kill only if ON's error rate is also above this floor, to ignore tiny real differences. */
  minErrorRate: number;
  /** The rule must be breached on this many checks in a row before a kill. */
  consecutiveBreaches: number;
  /**
   * Used when there is no trustworthy baseline: OFF has fewer than `minRequests`
   * (for example the flag is rolled out to 100%). Kill if ON's rate is above this.
   */
  maxErrorRateWithoutBaseline: number;
}

export const DEFAULT_KILL_RULE: KillRuleConfig = {
  minRequests: 50,
  maxDiff: 0.05,
  minErrorRate: 0.02,
  consecutiveBreaches: 3,
  maxErrorRateWithoutBaseline: 0.25,
};

export type Verdict =
  | 'insufficient_data' // too few ON requests to trust the numbers
  | 'healthy' // checked and fine
  | 'below_floor' // ON is worse than OFF, but its error rate is tiny
  | 'breach'; // the rule is broken on this check

export interface Evaluation {
  verdict: Verdict;
  onRate: number;
  /** null when there is no trustworthy baseline */
  offRate: number | null;
  /** onRate - offRate, or null without a baseline */
  diff: number | null;
  usedBaseline: boolean;
}

/**
 * One check of one flag's window. A pure function: same counts in, same answer out.
 * It judges a single moment only; the streak of breaches is tracked by BreachTracker.
 */
export function evaluate(counts: FlagCounts, rule: KillRuleConfig = DEFAULT_KILL_RULE): Evaluation {
  const onRate = errorRate(counts.on);
  const hasBaseline = counts.off.requests >= rule.minRequests;
  const offRate = hasBaseline ? errorRate(counts.off) : null;
  const diff = offRate === null ? null : onRate - offRate;
  const result = (verdict: Verdict): Evaluation => ({
    verdict,
    onRate,
    offRate,
    diff,
    usedBaseline: hasBaseline,
  });

  // 1. Enough data? (Problem 4: 3 requests with 1 failure is noise, not a 33% error rate.)
  if (counts.on.requests < rule.minRequests) return result('insufficient_data');

  // 2. No baseline to compare with: fall back to an absolute limit.
  if (diff === null) {
    return result(onRate > rule.maxErrorRateWithoutBaseline ? 'breach' : 'healthy');
  }

  // 3. Is ON clearly worse than OFF? (Problem 2: shared outages cancel out.)
  if (diff <= rule.maxDiff) return result('healthy');

  // 4. Worse, but is the error rate big enough to matter?
  if (onRate <= rule.minErrorRate) return result('below_floor');

  return result('breach');
}
