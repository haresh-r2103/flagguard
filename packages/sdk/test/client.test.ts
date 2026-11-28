import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { WindowStore } from '@flagguard/core';
import { FlagGuardClient } from '../src/index.js';
// The end-to-end test starts the real server app. Imported by path: tests may cross packages.
import { createApp } from '../../server/src/app.js';
import { parseConfig } from '../../server/src/config.js';

const NOW = Date.parse('2026-11-28T12:00:00Z');

function client(fetchFn: typeof fetch, extra = {}) {
  return new FlagGuardClient({
    url: 'http://flagguard.test/',
    ingestKey: 'ingest',
    environment: 'production',
    flushIntervalMs: 0, // tests call flush() themselves
    fetchFn,
    now: () => NOW,
    ...extra,
  });
}

const ok = () => vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
const bodies = (fetchFn: ReturnType<typeof vi.fn>) =>
  fetchFn.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));

describe('guard()', () => {
  it('returns the result and counts a success on the right path', async () => {
    const fetchFn = ok();
    const fg = client(fetchFn);
    expect(await fg.guard('new_checkout', true, () => 'paid')).toBe('paid');
    await fg.guard('new_checkout', false, async () => 'paid');
    await fg.flush();

    expect(bodies(fetchFn)).toEqual([
      {
        flag: 'new_checkout',
        environment: 'production',
        window_start: '2026-11-28T12:00:00.000Z',
        on: { requests: 1, errors: 0 },
        off: { requests: 1, errors: 0 },
      },
    ]);
  });

  it('counts an error and re-throws the same error, so app fallbacks still work', async () => {
    const fetchFn = ok();
    const fg = client(fetchFn);
    const bug = new TypeError("cannot read 'price' of undefined");

    await expect(fg.guard('new_checkout', true, () => Promise.reject(bug))).rejects.toBe(bug);
    await fg.flush();
    expect(bodies(fetchFn)[0].on).toEqual({ requests: 1, errors: 1 });
  });
});

describe('batching', () => {
  it('sends one report per flag per flush, however many requests', async () => {
    const fetchFn = ok();
    const fg = client(fetchFn);
    for (let i = 0; i < 500; i++) fg.record('a', true, i % 5 !== 0); // 100 errors
    fg.record('b', false, true);
    await fg.flush();

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const a = bodies(fetchFn).find((b) => b.flag === 'a');
    expect(a.on).toEqual({ requests: 500, errors: 100 });
  });

  it('starts fresh after each flush and sends nothing when idle', async () => {
    const fetchFn = ok();
    const fg = client(fetchFn);
    fg.record('a', true, true);
    await fg.flush();
    await fg.flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('caps the number of flags it counts (bounded memory)', async () => {
    const fetchFn = ok();
    const fg = client(fetchFn, { maxFlags: 2 });
    for (const flag of ['a', 'b', 'c']) fg.record(flag, true, true);
    await fg.flush();
    expect(bodies(fetchFn).map((b) => b.flag)).toEqual(['a', 'b']);
  });
});

describe('fail-open', () => {
  it('never throws when FlagGuard is unreachable, and reports the problem to onError', async () => {
    const onError = vi.fn();
    const fg = client(vi.fn().mockRejectedValue(new Error('ECONNREFUSED')), { onError });
    fg.record('a', true, false);
    await expect(fg.flush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('never slows guard(): the app gets its answer before any report is sent', async () => {
    const neverAnswers = vi.fn(() => new Promise<Response>(() => {}));
    const fg = client(neverAnswers as unknown as typeof fetch);
    await expect(fg.guard('a', true, () => 'fast')).resolves.toBe('fast');
    expect(neverAnswers).not.toHaveBeenCalled();
  });

  it('times out a slow FlagGuard instead of waiting forever', async () => {
    const onError = vi.fn();
    const slow = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
      )) as unknown as typeof fetch;
    const fg = client(slow, { timeoutMs: 20, onError });
    fg.record('a', true, true);
    await fg.flush();
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('end to end: SDK -> real FlagGuard server -> window', () => {
  it('reports land in the server window and are judged there', async () => {
    const key = 'end-to-end-ingest-key-123';
    const config = parseConfig('flags: { new_checkout: { environments: [production] } }', {
      FLAGGUARD_INGEST_KEY: key,
    });
    const store = new WindowStore();
    const server = createApp({ config, store }).listen(0); // any free port
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const fg = new FlagGuardClient({
        url: `http://127.0.0.1:${port}`,
        ingestKey: key,
        environment: 'production',
        flushIntervalMs: 0,
        onError: (e) => {
          throw e;
        },
      });
      for (let i = 0; i < 100; i++) {
        await fg
          .guard('new_checkout', true, () => (i < 80 ? Promise.reject(new Error('bug')) : 1))
          .catch(() => {});
        await fg.guard('new_checkout', false, () => 1);
      }
      await fg.close();

      const totals = store.get('production', 'new_checkout').totals(Date.now());
      expect(totals).toEqual({
        on: { requests: 100, errors: 80 },
        off: { requests: 100, errors: 0 },
      });
    } finally {
      server.close();
    }
  });
});
