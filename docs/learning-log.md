# Learning log

A record of the design problems worked through while building FlagGuard: what was worked out
independently, where hints were needed, and the concept behind each decision.
Full reasoning, failure scenarios and options are in the design doc.

## Design phase

| #   | Problem            | Outcome                                                                                                                                                                  | Concept                                                     |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| 1   | Reporting          | Worked out async (fire-and-forget) reporting alone. Picked sampling; refined to batched counts. Chose fail-closed; refined to fail-open default with opt-in fail-closed. | Async, timeouts, batching, sampling, fail-open vs closed    |
| 2   | Attribution        | Proposed developer-marked guards alone. Needed hints for shared outages; then picked the baseline comparison.                                                            | Attribution, baseline / control group, blast radius         |
| 3   | Counting over time | Picked the sliding window alone.                                                                                                                                         | Sliding vs tumbling windows, ring buffer                    |
| 4   | Deciding           | Asked for the answer: minimum sample size, floor, consecutive breaches.                                                                                                  | Sample size, false positives vs negatives, hysteresis       |
| 5   | Acting             | Picked retry with backoff alone.                                                                                                                                         | Idempotency ("set to X", not "toggle"), exponential backoff |
| 6   | Alerting           | Picked one alert per kill alone.                                                                                                                                         | Deduplication, alert fatigue, audit log                     |
| 7   | Surviving failure  | Picked Redis; refined to in-memory windows plus persisted kill history (Redis when scaling out).                                                                         | Ephemeral vs durable state, rate limiting (429)             |
| 8   | Security           | Picked the admin key in apps; corrected to an ingest key plus validation.                                                                                                | Least privilege                                             |

Concepts to revisit: fail-open vs fail-closed (1), least privilege (8), when shared state is needed (7).

## Build phase

Checkpoint questions and answers are added here as each phase is finished.
