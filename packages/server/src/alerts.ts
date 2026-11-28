import type { GuardEvent } from './guardian.js';

/**
 * Alerts (Problem 6): one clear message per incident, with what a human needs to act.
 * Every alert channel is a Notifier, an output edge like the Flagsmith controller.
 */
export interface Notifier {
  readonly name: string;
  send(event: GuardEvent): Promise<void>;
}

export interface Alert {
  title: string;
  lines: string[];
  severity: 'info' | 'warning' | 'critical';
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

/** Turns an event into words. Pure, so every channel says the same thing and it's easy to test. */
export function formatAlert(event: GuardEvent): Alert {
  const where = `${event.flag} (${event.environment})`;
  const e = event.evaluation;
  const numbers = e.usedBaseline
    ? `Error rate: ${pct(e.onRate)} with the flag ON vs ${pct(e.offRate)} OFF (last 60 s)`
    : `Error rate: ${pct(e.onRate)} with the flag ON (no OFF traffic to compare with)`;
  const traffic = `Requests: ${event.requestsOn} ON, ${event.requestsOff} OFF`;
  const when = `At: ${new Date(event.at).toISOString()}`;

  switch (event.type) {
    case 'killed':
      return {
        severity: 'warning',
        title: `FlagGuard disabled ${where}`,
        lines: [numbers, traffic, when, 'Fix the bug, then turn the flag back on in Flagsmith.'],
      };
    case 'would_kill':
      return {
        severity: 'info',
        title: `[dry run] FlagGuard would disable ${where}`,
        lines: [numbers, traffic, when, 'Nothing was changed. Set dry_run: false to act.'],
      };
    case 'kill_failed':
      return {
        severity: 'critical',
        title: `FlagGuard could NOT disable ${where}`,
        lines: [
          numbers,
          traffic,
          when,
          `Reason: ${event.error ?? 'unknown'}`,
          'The flag is probably still ON. Turn it off in Flagsmith by hand.',
        ],
      };
  }
}

const DISCORD_COLOURS = { info: 0xf39c12, warning: 0xe74c3c, critical: 0x8e44ad } as const;

/** Posts to a Discord channel webhook as an embed (a coloured card). */
export class DiscordNotifier implements Notifier {
  readonly name = 'discord';

  constructor(
    private readonly webhookUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(event: GuardEvent): Promise<void> {
    const alert = formatAlert(event);
    await postJson(this.fetchFn, this.webhookUrl, {
      username: 'FlagGuard',
      embeds: [
        {
          title: alert.title,
          description: alert.lines.join('\n'),
          color: DISCORD_COLOURS[alert.severity],
          timestamp: new Date(event.at).toISOString(),
        },
      ],
    });
  }
}

/** Posts the raw event plus the formatted alert to any URL: Slack bridges, Zapier, your own API. */
export class WebhookNotifier implements Notifier {
  readonly name = 'webhook';

  constructor(
    private readonly url: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(event: GuardEvent): Promise<void> {
    await postJson(this.fetchFn, this.url, { event, alert: formatAlert(event) });
  }
}

async function postJson(fetchFn: typeof fetch, url: string, body: unknown): Promise<void> {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`alert POST returned ${response.status}`);
}
