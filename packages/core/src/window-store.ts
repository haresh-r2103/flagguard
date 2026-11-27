import { SlidingWindow, type SlidingWindowOptions } from './sliding-window.js';

/**
 * Keeps one SlidingWindow per (environment, flag) pair.
 * The same flag name in production and staging is tracked separately,
 * because they are different deployments that can fail independently.
 */
export class WindowStore {
  private readonly windows = new Map<string, SlidingWindow>();

  constructor(private readonly options: SlidingWindowOptions = {}) {}

  /** Returns the window for this flag, creating it on first use. */
  get(environment: string, flag: string): SlidingWindow {
    const key = WindowStore.key(environment, flag);
    let window = this.windows.get(key);
    if (window === undefined) {
      window = new SlidingWindow(this.options);
      this.windows.set(key, window);
    }
    return window;
  }

  /** Every tracked flag, for the check loop to visit. */
  entries(): { environment: string; flag: string; window: SlidingWindow }[] {
    return [...this.windows.entries()].map(([key, window]) => {
      const [environment = '', flag = ''] = key.split('\u0000');
      return { environment, flag, window };
    });
  }

  get size(): number {
    return this.windows.size;
  }

  // A NUL character cannot appear in an environment or flag name, so the key is unambiguous.
  private static key(environment: string, flag: string): string {
    return `${environment}\u0000${flag}`;
  }
}
