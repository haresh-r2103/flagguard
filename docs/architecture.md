# Architecture

FlagGuard switches off a Flagsmith feature flag automatically when the code behind it starts
failing more than the code it replaced.

## Core vs edges

```
        INPUTS (edges)              CORE (same for everyone)          OUTPUTS (edges)
 ┌────────────────────┐     ┌──────────────────────────────┐    ┌──────────────────────┐
 │ HTTP API /v1/report│     │  Sliding window per flag     │    │ Flagsmith actuator   │
 │ JS SDK (guard)     │ ──► │  Kill rule:                  │──► │  (set flag OFF)      │
 │                    │     │   min sample, baseline gap,  │    │ Notifiers:           │
 │                    │     │   floor, consecutive checks  │    │  Discord / webhook   │
 └────────────────────┘     └──────────────▲───────────────┘    │ Audit log (SQLite)   │
                                           │                    └──────────────────────┘
                                   flagguard.yml (config)
```

| Package              | Role                                                      | Talks to the network? |
| -------------------- | --------------------------------------------------------- | --------------------- |
| `packages/core`      | Sliding windows and the kill rule. Pure functions.        | No                    |
| `packages/server`    | Report API, check loop, Flagsmith actions, alerts, audit. | Yes                   |
| `packages/sdk`       | `guard()` for apps, batched background reporting.         | Yes                   |
| `examples/demo-shop` | Example app with a flagged checkout that can be broken.   | Yes                   |

The core never imports from the server or SDK. Adding a new input (a Python SDK) or output
(Slack) means a new adapter, with no change to the core.

## Pipeline

1. Code inside a guard runs; the guard counts requests and errors for the ON or OFF path.
2. Every 5 s the SDK sends one batched report per flag in the background (500 ms timeout).
3. The server adds the report to the newest of 12 five-second buckets.
4. Every 5 s the server checks each flag's 60 s window against the kill rule.
5. After 3 failed checks in a row, the server sets the flag OFF in Flagsmith (with retries),
   sends one alert and writes an audit record.
