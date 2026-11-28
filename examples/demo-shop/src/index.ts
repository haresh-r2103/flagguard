/**
 * Demo shop: a tiny store whose new checkout sits behind the `new_checkout` flag and is
 * guarded by FlagGuard. It has a switch to inject a bug into the new checkout, so you can
 * watch FlagGuard catch it. Run from the repo root: npm run dev:shop
 *
 * Demo only: the /admin routes have no login. Don't expose this app to the internet.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import express from 'express';
import { FlagGuardClient } from '@flagguard/sdk';
import { FlagCache } from './flag-cache.js';
import { page } from './page.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const FLAG = 'new_checkout';
const port = Number(process.env.SHOP_PORT ?? 3000);
const environment = process.env.SHOP_ENVIRONMENT ?? 'development';
/** Share of users who get the new checkout while the flag is ON. The rest are the baseline. */
const rolloutPercent = Number(process.env.SHOP_ROLLOUT_PERCENT ?? 50);

const flags = new FlagCache(
  process.env.FLAGSMITH_API_URL ?? 'https://api.flagsmith.com/api/v1',
  process.env.FLAGSMITH_SERVER_KEY ?? '',
);
const fg = new FlagGuardClient({
  url: process.env.FLAGGUARD_URL ?? `http://localhost:${process.env.PORT ?? 4000}`,
  ingestKey: process.env.FLAGGUARD_INGEST_KEY ?? '',
  environment,
  onError: (error) =>
    console.log(`[flagguard] report failed (shop keeps working): ${String(error)}`),
});

// Demo state: the injected bug, and counters for the page.
const bug = { on: false, failRate: 0.8 };
const stats = { newOk: 0, newFailed: 0, classicOk: 0, classicFailed: 0 };

/**
 * Who gets the new checkout: flag ON, and the user falls in the rollout percentage.
 * Hashing the user id means the same user always lands on the same side.
 * (In production you'd use a Flagsmith percentage-split segment for this.)
 */
function usesNewCheckout(userId: string): boolean {
  if (!flags.isEnabled(FLAG)) return false;
  const bucket = createHash('sha256').update(userId).digest().readUInt32BE(0) % 100;
  return bucket < rolloutPercent;
}

async function newCheckout(): Promise<string> {
  if (bug.on && Math.random() < bug.failRate) {
    throw new TypeError("Cannot read properties of undefined (reading 'price')");
  }
  return 'Paid with one-click checkout';
}

async function classicCheckout(): Promise<string> {
  return 'Paid with classic checkout';
}

const app = express();
app.use(express.json());

app.get('/', (_req, res) => {
  res.type('html').send(page());
});

app.post('/checkout', async (req, res) => {
  const userId = String(req.body?.userId ?? Math.random());
  const isOn = usesNewCheckout(userId);
  try {
    const message = await fg.guard(FLAG, isOn, () => (isOn ? newCheckout() : classicCheckout()));
    isOn ? stats.newOk++ : stats.classicOk++;
    res.json({ ok: true, checkout: isOn ? 'new' : 'classic', message });
  } catch (error) {
    isOn ? stats.newFailed++ : stats.classicFailed++;
    res.status(500).json({ ok: false, checkout: isOn ? 'new' : 'classic', error: String(error) });
  }
});

app.get('/status', (_req, res) => {
  res.json({
    flag: { name: FLAG, enabled: flags.isEnabled(FLAG), flagsmithReachable: flags.lastRefreshOk },
    rolloutPercent,
    bug,
    stats,
  });
});

/** Demo control: break or fix the new checkout. Body: { "on": true, "failRate": 0.8 } */
app.post('/admin/bug', (req, res) => {
  bug.on = Boolean(req.body?.on);
  if (typeof req.body?.failRate === 'number')
    bug.failRate = Math.min(1, Math.max(0, req.body.failRate));
  console.log(`[shop] bug ${bug.on ? `ON (${bug.failRate * 100}% of new checkouts fail)` : 'OFF'}`);
  res.json(bug);
});

app.post('/admin/reset-stats', (_req, res) => {
  Object.assign(stats, { newOk: 0, newFailed: 0, classicOk: 0, classicFailed: 0 });
  res.json(stats);
});

await flags.refresh();
flags.start(10_000);
const server = app.listen(port, () => {
  console.log(`Demo shop on http://localhost:${port} | environment: ${environment}`);
  console.log(`${FLAG} is ${flags.isEnabled(FLAG) ? 'ON' : 'OFF'} | rollout ${rolloutPercent}%`);
});

const shutdown = async () => {
  flags.stop();
  await fg.close(); // send the last counts
  server.close(() => process.exit(0));
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
