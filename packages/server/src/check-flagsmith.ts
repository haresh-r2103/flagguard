/**
 * Read-only connection check: can FlagGuard see each guarded flag in Flagsmith?
 * Changes nothing. Run from the repo root: npm run check:flagsmith
 */
import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { FlagsmithController } from './flagsmith.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig(process.env.FLAGGUARD_CONFIG ?? 'flagguard.yml');
if (config.flagsmith.adminKey === undefined) {
  console.error('Set FLAGSMITH_ADMIN_API_KEY in .env first.');
  process.exit(1);
}

const controller = new FlagsmithController({
  apiUrl: config.flagsmith.apiUrl,
  adminKey: config.flagsmith.adminKey,
  environmentKeys: config.flagsmith.environmentKeys,
});

console.log(`Flagsmith API: ${config.flagsmith.apiUrl}`);
let failures = 0;
for (const { environment, flag } of config.guardedFlags()) {
  try {
    const state = await controller.getState(environment, flag);
    console.log(
      `OK    ${environment}/${flag}: ${state.enabled ? 'ON' : 'OFF'} (state id ${state.id})`,
    );
  } catch (error) {
    failures++;
    console.log(`FAIL  ${environment}/${flag}: ${String(error)}`);
  }
}
process.exit(failures === 0 ? 0 : 1);
