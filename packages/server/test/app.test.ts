import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { WindowStore } from '@flagguard/core';
import { createApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';

const KEY = 'test-ingest-key-0123456789';
const NOW = Date.parse('2026-11-28T10:00:30Z');

const YAML = `
rate_limit: { per_second: 1, burst: 3 }
flags:
  new_checkout:
    environments: [production]
`;

function setup(yaml = YAML) {
  const config = parseConfig(yaml, { FLAGGUARD_INGEST_KEY: KEY });
  const store = new WindowStore();
  let clock = NOW;
  const app = createApp({ config, store, now: () => clock });
  return { app, store, advance: (ms: number) => (clock += ms) };
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    flag: 'new_checkout',
    environment: 'production',
    window_start: '2026-11-28T10:00:25Z',
    on: { requests: 100, errors: 80 },
    off: { requests: 100, errors: 1 },
    ...overrides,
  };
}

const post = (app: ReturnType<typeof setup>['app'], body: unknown, key: string | null = KEY) => {
  const req = request(app).post('/v1/report');
  if (key !== null) req.set('Authorization', `Bearer ${key}`);
  return req.send(body as object);
};

describe('GET /health', () => {
  it('answers without a key and shows dry-run mode', async () => {
    const { app } = setup();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', dry_run: true, flags_tracked: 0 });
  });
});

describe('POST /v1/report', () => {
  it('accepts a valid report and adds it to the window', async () => {
    const { app, store } = setup();
    const res = await post(app, report());
    expect(res.status).toBe(202);
    expect(store.get('production', 'new_checkout').totals(NOW).on).toEqual({
      requests: 100,
      errors: 80,
    });
  });

  it('rejects a missing key with 401', async () => {
    const { app } = setup();
    expect((await post(app, report(), null)).status).toBe(401);
  });

  it('rejects a wrong key with 401', async () => {
    const { app } = setup();
    const res = await post(app, report(), 'wrong-key');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_ingest_key');
  });

  it('rejects errors greater than requests with 400', async () => {
    const { app } = setup();
    const res = await post(app, report({ on: { requests: 10, errors: 1000 } }));
    expect(res.status).toBe(400);
    expect(res.body.details[0].message).toBe('errors cannot exceed requests');
  });

  it('rejects negative numbers, missing fields and unknown fields with 400', async () => {
    const { app } = setup();
    expect((await post(app, report({ on: { requests: -1, errors: 0 } }))).status).toBe(400);
    expect((await post(app, { flag: 'new_checkout' })).status).toBe(400);
    expect((await post(app, report({ admin: true }))).status).toBe(400);
  });

  it('rejects malformed JSON with 400', async () => {
    const { app } = setup();
    const res = await request(app)
      .post('/v1/report')
      .set('Authorization', `Bearer ${KEY}`)
      .set('Content-Type', 'application/json')
      .send('{"flag": ');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('malformed_json');
  });

  it('rejects flags that flagguard.yml does not guard with 404', async () => {
    const { app } = setup();
    expect((await post(app, report({ flag: 'some_other_flag' }))).status).toBe(404);
    expect((await post(app, report({ environment: 'staging' }))).status).toBe(404);
  });

  it('rejects a report from outside the window with 422', async () => {
    const { app } = setup();
    const res = await post(app, report({ window_start: '2026-11-28T09:00:00Z' }));
    expect(res.status).toBe(422);
  });

  it('rate-limits a flood with 429 and Retry-After, then recovers', async () => {
    const { app, advance } = setup(); // burst 3, refill 1 per second
    for (let i = 0; i < 3; i++) expect((await post(app, report())).status).toBe(202);

    const limited = await post(app, report());
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('1');

    advance(1_000); // one token refilled
    expect((await post(app, report())).status).toBe(202);
  });
});

describe('config', () => {
  it('refuses to start without a strong ingest key', () => {
    expect(() => parseConfig('', {})).toThrow(/FLAGGUARD_INGEST_KEY/);
    expect(() => parseConfig('', { FLAGGUARD_INGEST_KEY: 'change-me' })).toThrow();
  });

  it('turns YAML percentages into fractions and applies per-flag overrides', () => {
    const config = parseConfig(
      `
defaults: { max_diff_points: 10 }
flags:
  a: { environments: [prod], consecutive_breaches: 5 }
`,
      { FLAGGUARD_INGEST_KEY: KEY },
    );
    expect(config.ruleFor('prod', 'a')).toMatchObject({ maxDiff: 0.1, consecutiveBreaches: 5 });
    expect(config.ruleFor('prod', 'b')).toBeUndefined();
  });

  it('reports typos in the YAML clearly', () => {
    expect(() =>
      parseConfig('flags: { a: { environments: [p], min_requets: 5 } }', {
        FLAGGUARD_INGEST_KEY: KEY,
      }),
    ).toThrow(/Invalid flagguard.yml/);
  });
});
