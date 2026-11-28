import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { WindowStore } from '@flagguard/core';
import { requireIngestKey } from './auth.js';
import type { ServerConfig } from './config.js';
import { TokenBucketLimiter } from './rate-limiter.js';
import { reportSchema } from './report-schema.js';

export interface AppDeps {
  config: ServerConfig;
  store: WindowStore;
  /** Injected clock, as in the core: tests control time. */
  now?: () => number;
}

/**
 * Builds the HTTP app without starting it. Tests call this directly;
 * index.ts calls it and then listens on a port.
 */
export function createApp({ config, store, now = Date.now }: AppDeps) {
  const app = express();
  app.disable('x-powered-by'); // don't advertise the framework

  const limiter = new TokenBucketLimiter(config.rateLimit.perSecond, config.rateLimit.burst);

  const rateLimit: RequestHandler = (req, res, next) => {
    const result = limiter.take(req.ip ?? 'unknown', now());
    if (!result.allowed) {
      res.set('Retry-After', String(result.retryAfterSeconds));
      res
        .status(429)
        .json({ error: 'rate_limited', retry_after_seconds: result.retryAfterSeconds });
      return;
    }
    next();
  };

  // Liveness check for Docker, load balancers and the SDK. No secrets, no auth.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', dry_run: config.dryRun, flags_tracked: store.size });
  });

  // Order matters: cheapest rejections first. Rate limit, then the key, then parse the body.
  app.post(
    '/v1/report',
    rateLimit,
    requireIngestKey(config.ingestKey),
    express.json({ limit: '10kb' }),
    (req, res) => {
      const parsed = reportSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'invalid_report',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return;
      }
      const report = parsed.data;

      // Only flags listed in flagguard.yml are tracked, so a leaked ingest key
      // can't make FlagGuard act on flags it was never asked to guard.
      if (config.ruleFor(report.environment, report.flag) === undefined) {
        res
          .status(404)
          .json({ error: 'unknown_flag', flag: report.flag, environment: report.environment });
        return;
      }

      const accepted = store
        .get(report.environment, report.flag)
        .add(Date.parse(report.window_start), { on: report.on, off: report.off }, now());
      if (!accepted) {
        // Too old or too far in the future (Phase 1). The SDK should drop it, not retry.
        res.status(422).json({ error: 'outside_window' });
        return;
      }
      res.status(202).json({ accepted: true });
    },
  );

  // Malformed JSON or an oversized body ends up here instead of crashing the request.
  const onError: ErrorRequestHandler = (
    err: { status?: number; type?: string },
    _req,
    res,
    _next,
  ) => {
    if (err.type === 'entity.too.large') {
      res.status(413).json({ error: 'body_too_large' });
      return;
    }
    if (err.status === 400) {
      res.status(400).json({ error: 'malformed_json' });
      return;
    }
    res.status(500).json({ error: 'internal_error' });
  };
  app.use(onError);

  return app;
}
