import { describe, expect, it, vi } from 'vitest';
import { WindowStore } from '@flagguard/core';
import { parseConfig } from '../src/config.js';
import { FlagsmithController, FlagsmithError, type FlagController } from '../src/flagsmith.js';
import { Guardian, type GuardEvent } from '../src/guardian.js';
import { RetryableError, withRetry } from '../src/retry.js';

const KEY = 'test-ingest-key-0123456789';
const noSleep = () => Promise.resolve();
const quiet = () => {};

describe('withRetry: exponential backoff', () => {
  it('retries retryable errors with 1 s, 2 s, 4 s waits, then succeeds', async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 4) throw new RetryableError('timeout');
        return 'done';
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(result).toBe('done');
    expect(waits).toEqual([1_000, 2_000, 4_000]);
  });

  it('gives up after 4 attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new RetryableError('down'));
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('never retries a permanent error such as a wrong key', async () => {
    const fn = vi.fn().mockRejectedValue(new FlagsmithError('401'));
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toThrow('401');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

/** A fake Flagsmith API that records requests, so tests never touch the real one. */
function fakeFlagsmith(status = 200) {
  const calls: { method: string; url: string; auth: string | null; body: unknown }[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? 'GET',
      url: String(url),
      auth: headers.get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (status !== 200) return new Response('{}', { status });
    if ((init?.method ?? 'GET') === 'GET') {
      return Response.json({
        results: [
          { id: 7, enabled: true, feature_segment: 3, identity: null }, // segment override
          { id: 42, enabled: true, feature_segment: null, identity: null }, // environment default
        ],
      });
    }
    return Response.json({ id: 42, enabled: false });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe('FlagsmithController', () => {
  const options = {
    apiUrl: 'https://flagsmith.test/api/v1/',
    adminKey: 'admin-secret',
    environmentKeys: { development: 'envKey123' },
  };

  it('finds the environment default state and PATCHes it to enabled: false', async () => {
    const { calls, fetchFn } = fakeFlagsmith();
    await new FlagsmithController({ ...options, fetchFn }).disable('development', 'new_checkout');

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: 'https://flagsmith.test/api/v1/environments/envKey123/featurestates/?feature_name=new_checkout',
      auth: 'Api-Key admin-secret',
    });
    expect(calls[1]).toMatchObject({
      method: 'PATCH',
      url: 'https://flagsmith.test/api/v1/environments/envKey123/featurestates/42/',
      body: { enabled: false },
    });
  });

  it('treats 5xx as retryable and 401 as permanent', async () => {
    const down = new FlagsmithController({ ...options, fetchFn: fakeFlagsmith(503).fetchFn });
    await expect(down.disable('development', 'x')).rejects.toBeInstanceOf(RetryableError);

    const badKey = new FlagsmithController({ ...options, fetchFn: fakeFlagsmith(401).fetchFn });
    await expect(badKey.disable('development', 'x')).rejects.toBeInstanceOf(FlagsmithError);
  });

  it('explains a missing environment key', async () => {
    const controller = new FlagsmithController({ ...options, fetchFn: fakeFlagsmith().fetchFn });
    await expect(controller.disable('production', 'x')).rejects.toThrow(/environment_keys/);
  });
});

describe('Guardian: the check loop', () => {
  const NOW = 1_000_000_000_000;

  function setup(dryRun: boolean, controller?: FlagController) {
    const yaml = `
dry_run: ${dryRun}
flagsmith: { environment_keys: { development: envKey123 } }
flags:
  new_checkout: { environments: [development] }
`;
    const config = parseConfig(yaml, {
      FLAGGUARD_INGEST_KEY: KEY,
      FLAGSMITH_ADMIN_API_KEY: 'admin-secret',
    });
    const store = new WindowStore();
    const fake = controller ?? { getState: vi.fn(), disable: vi.fn().mockResolvedValue(undefined) };
    const events: GuardEvent[] = [];
    const guardian = new Guardian({
      config,
      store,
      controller: fake,
      now: () => NOW,
      onEvent: (e) => void events.push(e),
      retry: { sleep: noSleep },
      log: quiet,
    });
    // A broken feature: 80% errors on ON vs 1% on OFF.
    store.get('development', 'new_checkout').add(
      NOW - 1_000,
      {
        on: { requests: 100, errors: 80 },
        off: { requests: 100, errors: 1 },
      },
      NOW,
    );
    return { guardian, fake, events };
  }

  it('disables the flag on the 3rd breaching check, exactly once', async () => {
    const { guardian, fake, events } = setup(false);
    await guardian.checkOnce();
    await guardian.checkOnce();
    expect(fake.disable).not.toHaveBeenCalled();

    await guardian.checkOnce();
    expect(fake.disable).toHaveBeenCalledWith('development', 'new_checkout');
    expect(events.map((e) => e.type)).toEqual(['killed']);

    await guardian.checkOnce(); // still broken, but already handled
    expect(fake.disable).toHaveBeenCalledTimes(1);
  });

  it('in dry run, reports what it would do and never calls Flagsmith', async () => {
    const { guardian, fake, events } = setup(true);
    for (let i = 0; i < 4; i++) await guardian.checkOnce();
    expect(fake.disable).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['would_kill']);
  });

  it('if Flagsmith stays down, raises kill_failed and tries again on later checks', async () => {
    const broken: FlagController = {
      getState: vi.fn(),
      disable: vi.fn().mockRejectedValue(new RetryableError('Flagsmith down')),
    };
    const { guardian, events } = setup(false, broken);
    for (let i = 0; i < 3; i++) await guardian.checkOnce();
    expect(events[0]?.type).toBe('kill_failed');
    expect(broken.disable).toHaveBeenCalledTimes(4); // 1 try + 3 retries

    for (let i = 0; i < 3; i++) await guardian.checkOnce(); // 3 more breaches -> new attempt
    expect(broken.disable).toHaveBeenCalledTimes(8);
  });
});

describe('config: acting settings', () => {
  it('requires the admin key once dry run is off', () => {
    expect(() => parseConfig('dry_run: false', { FLAGGUARD_INGEST_KEY: KEY })).toThrow(
      /FLAGSMITH_ADMIN_API_KEY/,
    );
  });

  it('requires an environment key for every guarded environment once dry run is off', () => {
    expect(() =>
      parseConfig('dry_run: false\nflags: { a: { environments: [production] } }', {
        FLAGGUARD_INGEST_KEY: KEY,
        FLAGSMITH_ADMIN_API_KEY: 'admin',
      }),
    ).toThrow(/production/);
  });
});
