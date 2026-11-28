/**
 * Simulated shoppers for the demo: sends checkouts to the demo shop and prints a line a second.
 *
 *   npm run simulate                      # 20 checkouts/s for 90 s, bug injected at 20 s
 *   npm run simulate -- --rps 30 --seconds 120 --bug-at 30
 *   npm run simulate -- --bug-at -1       # no bug: healthy traffic only
 *
 * The data is simulated; say so in the demo. FlagGuard sees exactly what a real app would send.
 */
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:3000' },
    rps: { type: 'string', default: '20' },
    seconds: { type: 'string', default: '90' },
    'bug-at': { type: 'string', default: '20' },
    users: { type: 'string', default: '1000' },
  },
});

const shop = values.url.replace(/\/+$/, '');
const rps = Number(values.rps);
const seconds = Number(values.seconds);
const bugAt = Number(values['bug-at']);
const users = Number(values.users);

type Result = { ok: boolean; checkout: 'new' | 'classic' };

async function checkout(): Promise<Result | null> {
  const userId = `user-${Math.floor(Math.random() * users)}`;
  try {
    const response = await fetch(`${shop}/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    return (await response.json()) as Result;
  } catch {
    return null; // shop not reachable
  }
}

async function post(path: string, body: unknown) {
  await fetch(`${shop}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const pad = (s: string | number, n: number) => String(s).padStart(n);
const pct = (bad: number, total: number) =>
  total === 0 ? '   -  ' : `${((100 * bad) / total).toFixed(0)}%`.padStart(6);

console.log(`Simulating ${rps} checkouts/s for ${seconds}s against ${shop}`);
console.log(
  bugAt >= 0
    ? `Bug will be injected into the new checkout at ${bugAt}s`
    : 'No bug will be injected',
);
console.log('');
console.log('  time   new ok / fail  err   classic ok / fail  err   flag');

await post('/admin/bug', { on: false });
await post('/admin/reset-stats', {});

for (let second = 0; second < seconds; second++) {
  if (second === bugAt) {
    await post('/admin/bug', { on: true });
    console.log(`  ----- ${second}s: bug injected into the new checkout -----`);
  }

  const started = Date.now();
  const results = await Promise.all(Array.from({ length: rps }, () => checkout()));
  const count = (path: Result['checkout'], ok: boolean) =>
    results.filter((r) => r?.checkout === path && r.ok === ok).length;
  const [newOk, newFail, classicOk, classicFail] = [
    count('new', true),
    count('new', false),
    count('classic', true),
    count('classic', false),
  ];
  const status = (await (await fetch(`${shop}/status`)).json()) as { flag: { enabled: boolean } };

  console.log(
    `  ${pad(second, 3)}s   ${pad(newOk, 6)} / ${pad(newFail, 4)} ${pct(newFail, newOk + newFail)}   ` +
      `${pad(classicOk, 10)} / ${pad(classicFail, 4)} ${pct(classicFail, classicOk + classicFail)}   ` +
      `${status.flag.enabled ? 'ON' : 'OFF'}`,
  );

  await new Promise((r) => setTimeout(r, Math.max(0, 1_000 - (Date.now() - started))));
}

console.log(
  '\nDone. The bug is still on in the shop; click "Fix it" or POST /admin/bug {"on": false}.',
);
