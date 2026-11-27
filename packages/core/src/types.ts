/** Requests and errors seen on one code path (flag ON or flag OFF). */
export interface PathCounts {
  requests: number;
  errors: number;
}

/** Counts for both code paths of one flag. OFF is the baseline (the old code). */
export interface FlagCounts {
  on: PathCounts;
  off: PathCounts;
}

export function emptyCounts(): FlagCounts {
  return { on: { requests: 0, errors: 0 }, off: { requests: 0, errors: 0 } };
}

/** Error rate as a fraction between 0 and 1. No requests means no evidence, so 0. */
export function errorRate(path: PathCounts): number {
  return path.requests === 0 ? 0 : path.errors / path.requests;
}
