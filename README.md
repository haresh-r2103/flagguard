# FlagGuard

Automatic kill switch for [Flagsmith](https://github.com/Flagsmith/flagsmith) feature flags.
When the code behind a flag starts failing more than the code it replaced, FlagGuard switches
the flag off and tells your team.

> Work in progress for the WeMakeDevs Flagsmith hackathon (Track 3: Build on Open Source Flagsmith).

## Status

| Phase                    | State       |
| ------------------------ | ----------- |
| 0. Scaffold              | Done        |
| 1. Sliding window        | Done        |
| 2. Kill rule             | Done        |
| 3. Report API            | Done        |
| 4. Acting (Flagsmith)    | Done        |
| 5. Alerts and audit      | Done        |
| 6. SDK                   | Done        |
| 7. Demo shop, simulation | Next        |
| 8. Self-hosted setup     | Not started |

## Development

Requires Node.js 20 or newer.

```bash
npm install
npm test          # run all tests
npm run check     # typecheck + formatting + tests
cp .env.example .env   # then fill in your keys (never commit .env)
cp flagguard.example.yml flagguard.yml
npm run dev:server     # FlagGuard on http://localhost:4000
npm run check:flagsmith  # read-only: can FlagGuard see your flags in Flagsmith?
```

FlagGuard starts in **dry run**: it logs what it would disable but changes nothing.
Set `dry_run: false` in `flagguard.yml` once `check:flagsmith` passes.

Every decision is written to `data/audit.jsonl`. Set `DISCORD_WEBHOOK_URL` and/or
`ALERT_WEBHOOK_URL` in `.env` to get one alert per incident.

### Report API

`POST /v1/report` with `Authorization: Bearer <FLAGGUARD_INGEST_KEY>`:

```json
{
  "flag": "new_checkout",
  "environment": "development",
  "window_start": "2026-11-28T10:00:25Z",
  "on": { "requests": 100, "errors": 80 },
  "off": { "requests": 100, "errors": 1 }
}
```

| Status | Meaning                                                      |
| ------ | ------------------------------------------------------------ |
| 202    | Accepted                                                     |
| 400    | Invalid report (bad JSON, missing fields, errors > requests) |
| 401    | Missing or wrong ingest key                                  |
| 404    | Flag not listed in `flagguard.yml`                           |
| 413    | Body over 10 kB                                              |
| 422    | `window_start` outside the 60 s window                       |
| 429    | Rate limited; see `Retry-After`                              |

`GET /health` returns `{ "status": "ok", "dry_run": true, "flags_tracked": 1 }`.

### Using the SDK in your app

```ts
import { FlagGuardClient } from '@flagguard/sdk';

const fg = new FlagGuardClient({
  url: 'http://localhost:4000',
  ingestKey: process.env.FLAGGUARD_INGEST_KEY!,
  environment: 'production',
});

const isOn = flags.isFeatureEnabled('new_checkout'); // from the Flagsmith SDK
await fg.guard('new_checkout', isOn, () => (isOn ? newCheckout(order) : oldCheckout(order)));
```

`guard()` never waits on the network. Counts are sent every 5 s in the background, and if
FlagGuard is down the app carries on as normal (fail-open).

See [docs/architecture.md](docs/architecture.md) for the design.

## License

MIT
