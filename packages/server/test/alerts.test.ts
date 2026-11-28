import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { evaluate } from '@flagguard/core';
import { DiscordNotifier, formatAlert, type Notifier } from '../src/alerts.js';
import { AuditLog } from '../src/audit-log.js';
import { createEventHandler } from '../src/event-handler.js';
import type { GuardEvent } from '../src/guardian.js';

const AT = Date.parse('2026-11-28T14:02:15Z');

function event(type: GuardEvent['type'], overrides: Partial<GuardEvent> = {}): GuardEvent {
  return {
    type,
    environment: 'production',
    flag: 'new_checkout',
    at: AT,
    evaluation: evaluate({
      on: { requests: 500, errors: 400 },
      off: { requests: 500, errors: 5 },
    }),
    requestsOn: 500,
    requestsOff: 500,
    ...overrides,
  };
}

describe('formatAlert', () => {
  it('a kill says what, where, the numbers, when, and what to do next', () => {
    const alert = formatAlert(event('killed'));
    expect(alert.title).toBe('FlagGuard disabled new_checkout (production)');
    expect(alert.lines).toEqual([
      'Error rate: 80.0% with the flag ON vs 1.0% OFF (last 60 s)',
      'Requests: 500 ON, 500 OFF',
      'At: 2026-11-28T14:02:15.000Z',
      'Fix the bug, then turn the flag back on in Flagsmith.',
    ]);
  });

  it('a failed kill is critical and tells a human to act', () => {
    const alert = formatAlert(event('kill_failed', { error: 'Flagsmith returned 503' }));
    expect(alert.severity).toBe('critical');
    expect(alert.lines).toContain('Reason: Flagsmith returned 503');
  });

  it('a dry-run decision says nothing was changed', () => {
    expect(formatAlert(event('would_kill')).title).toMatch(/^\[dry run\]/);
  });
});

describe('DiscordNotifier', () => {
  it('posts one embed to the webhook', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await new DiscordNotifier('https://discord.test/hook', fetchFn).send(event('killed'));

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://discord.test/hook');
    const body = JSON.parse(String(init.body));
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].title).toBe('FlagGuard disabled new_checkout (production)');
  });
});

describe('AuditLog', () => {
  it('appends one JSON line per event and reads them back after a "restart"', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fg-')), 'nested', 'audit.jsonl');
    new AuditLog(path).append(event('killed'));
    new AuditLog(path).append(event('kill_failed'));

    const records = new AuditLog(path).recent() as { type: string; at: string }[];
    expect(records.map((r) => r.type)).toEqual(['killed', 'kill_failed']);
    expect(records[0]?.at).toBe('2026-11-28T14:02:15.000Z');
  });

  it('skips a damaged line instead of failing', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fg-')), 'audit.jsonl');
    writeFileSync(path, '{"type":"killed"}\n{broken\n');
    appendFileSync(path, '{"type":"would_kill"}\n');
    expect(new AuditLog(path).recent()).toEqual([{ type: 'killed' }, { type: 'would_kill' }]);
  });
});

describe('createEventHandler', () => {
  function fakeNotifier(fail = false): Notifier & { sent: GuardEvent[] } {
    const sent: GuardEvent[] = [];
    return {
      name: fail ? 'broken' : 'fake',
      sent,
      send: async (e) => {
        if (fail) throw new Error('channel down');
        sent.push(e);
      },
    };
  }

  it('sends repeated kill_failed alerts at most once per cooldown, per flag', async () => {
    let clock = AT;
    const notifier = fakeNotifier();
    const handle = createEventHandler({ notifiers: [notifier], now: () => clock, log: () => {} });

    await handle(event('kill_failed'));
    clock += 15_000;
    await handle(event('kill_failed')); // 15 s later: suppressed
    await handle(event('kill_failed', { flag: 'other_flag' })); // different flag: sent
    clock += 5 * 60_000;
    await handle(event('kill_failed')); // after the cooldown: sent again

    expect(notifier.sent.map((e) => e.flag)).toEqual([
      'new_checkout',
      'other_flag',
      'new_checkout',
    ]);
  });

  it('still audits suppressed alerts', async () => {
    const audit = { append: vi.fn() } as unknown as AuditLog;
    const handle = createEventHandler({ audit, notifiers: [], now: () => AT, log: () => {} });
    await handle(event('kill_failed'));
    await handle(event('kill_failed'));
    expect(audit.append).toHaveBeenCalledTimes(2);
  });

  it('a broken channel never stops the other channels', async () => {
    const good = fakeNotifier();
    const logs: string[] = [];
    const handle = createEventHandler({
      notifiers: [fakeNotifier(true), good],
      log: (m) => void logs.push(m),
    });
    await handle(event('killed'));
    expect(good.sent).toHaveLength(1);
    expect(logs[0]).toMatch(/broken failed: Error: channel down/);
  });
});
