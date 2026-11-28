/**
 * @flagguard/server entry point: load config, build the app, start listening.
 * Run from the repo root: npm run dev:server
 */
import { existsSync } from 'node:fs';
import { WindowStore } from '@flagguard/core';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const configPath = process.env.FLAGGUARD_CONFIG ?? 'flagguard.yml';

try {
  const config = loadConfig(configPath);
  const store = new WindowStore();
  const app = createApp({ config, store });

  app.listen(config.port, () => {
    const guarded = config.guardedFlags().map((g) => `${g.environment}/${g.flag}`);
    console.log(`FlagGuard listening on http://localhost:${config.port}`);
    console.log(`Config: ${configPath} | dry run: ${config.dryRun}`);
    console.log(`Guarding: ${guarded.length > 0 ? guarded.join(', ') : '(no flags configured)'}`);
  });
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
