/**
 * @flagguard/server entry point: load config, build the app, start the check loop, listen.
 * Run from the repo root: npm run dev:server
 */
import { existsSync } from 'node:fs';
import { WindowStore } from '@flagguard/core';
import { DiscordNotifier, WebhookNotifier, type Notifier } from './alerts.js';
import { createApp } from './app.js';
import { AuditLog } from './audit-log.js';
import { ConfigError, loadConfig } from './config.js';
import { createEventHandler } from './event-handler.js';
import { FlagsmithController } from './flagsmith.js';
import { Guardian } from './guardian.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const configPath = process.env.FLAGGUARD_CONFIG ?? 'flagguard.yml';

try {
  const config = loadConfig(configPath);
  const store = new WindowStore();
  const app = createApp({ config, store });

  const controller = new FlagsmithController({
    apiUrl: config.flagsmith.apiUrl,
    adminKey: config.flagsmith.adminKey ?? '',
    environmentKeys: config.flagsmith.environmentKeys,
  });

  // Alerts: every channel configured in .env. None configured = log only.
  const notifiers: Notifier[] = [];
  if (process.env.DISCORD_WEBHOOK_URL) {
    notifiers.push(new DiscordNotifier(process.env.DISCORD_WEBHOOK_URL));
  }
  if (process.env.ALERT_WEBHOOK_URL)
    notifiers.push(new WebhookNotifier(process.env.ALERT_WEBHOOK_URL));
  const auditPath = process.env.FLAGGUARD_AUDIT_LOG ?? 'data/audit.jsonl';
  const onEvent = createEventHandler({ audit: new AuditLog(auditPath), notifiers });

  const guardian = new Guardian({ config, store, controller, onEvent });
  guardian.start(5_000);

  const server = app.listen(config.port, () => {
    const guarded = config.guardedFlags().map((g) => `${g.environment}/${g.flag}`);
    console.log(`FlagGuard listening on http://localhost:${config.port}`);
    console.log(`Config: ${configPath} | dry run: ${config.dryRun}`);
    console.log(`Guarding: ${guarded.length > 0 ? guarded.join(', ') : '(no flags configured)'}`);
    console.log(`Checking every 5 s | audit log: ${auditPath}`);
    console.log(
      `Alerts: ${notifiers.length > 0 ? notifiers.map((n) => n.name).join(', ') : 'log only'}`,
    );
  });

  // Stop cleanly on Ctrl+C or when Docker stops the container.
  const shutdown = () => {
    guardian.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
