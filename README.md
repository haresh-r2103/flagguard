# FlagGuard

Automatic kill switch for [Flagsmith](https://github.com/Flagsmith/flagsmith) feature flags.
When the code behind a flag starts failing more than the code it replaced, FlagGuard switches
the flag off and tells your team.

> Work in progress for the WeMakeDevs Flagsmith hackathon (Track 3: Build on Open Source Flagsmith).

## Status

| Phase                    | State       |
| ------------------------ | ----------- |
| 0. Scaffold              | Done        |
| 1. Sliding window        | Next        |
| 2. Kill rule             | Not started |
| 3. Report API            | Not started |
| 4. Acting (Flagsmith)    | Not started |
| 5. Alerts and audit      | Not started |
| 6. SDK                   | Not started |
| 7. Demo shop, simulation | Not started |
| 8. Self-hosted setup     | Not started |

## Development

Requires Node.js 20 or newer.

```bash
npm install
npm test          # run all tests
npm run check     # typecheck + formatting + tests
cp .env.example .env   # then fill in your keys (never commit .env)
```

See [docs/architecture.md](docs/architecture.md) for the design.

## License

MIT
