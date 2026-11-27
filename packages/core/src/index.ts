/**
 * @flagguard/core
 *
 * Pure decision logic for FlagGuard: sliding windows and the kill rule.
 * This package does no network or file I/O, so it can be tested with plain data.
 */

export const CORE_VERSION = '0.1.0';

export { emptyCounts, errorRate, type FlagCounts, type PathCounts } from './types.js';
export { SlidingWindow, type SlidingWindowOptions } from './sliding-window.js';
export { WindowStore } from './window-store.js';
