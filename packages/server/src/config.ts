import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { DEFAULT_KILL_RULE, type KillRuleConfig } from '@flagguard/core';

/**
 * Configuration comes from two places:
 * - flagguard.yml: which flags to guard and their thresholds (safe to commit)
 * - environment variables (.env): secrets and ports (never committed)
 */

const percent = z.number().min(0).max(100);

/** Thresholds as written in YAML. Percent values are human-friendly: 5 means 5%. */
const ruleOverridesSchema = z
  .object({
    min_requests: z.number().int().positive().optional(),
    max_diff_points: percent.optional(),
    min_error_rate_percent: percent.optional(),
    max_error_rate_without_baseline_percent: percent.optional(),
    consecutive_breaches: z.number().int().positive().optional(),
  })
  .strict();

const flagSchema = ruleOverridesSchema
  .extend({ environments: z.array(z.string().min(1)).min(1) })
  .strict();

const fileSchema = z
  .object({
    /** Dry run: decide and alert, but never switch a flag off. On by default (Problem 4). */
    dry_run: z.boolean().default(true),
    rate_limit: z
      .object({
        per_second: z.number().positive().default(10),
        burst: z.number().int().positive().default(20),
      })
      .strict()
      .default({}),
    defaults: ruleOverridesSchema.default({}),
    flags: z.record(z.string().min(1), flagSchema).default({}),
    flagsmith: z
      .object({
        /**
         * FlagGuard environment name -> Flagsmith environment key. These are the public,
         * client-side keys (Environment settings > SDK keys), so they are safe in this file.
         */
        environment_keys: z.record(z.string().min(1), z.string().min(1)).default({}),
      })
      .strict()
      .default({}),
  })
  .strict();

export interface ServerConfig {
  port: number;
  ingestKey: string;
  dryRun: boolean;
  rateLimit: { perSecond: number; burst: number };
  flagsmith: {
    apiUrl: string;
    /** Organisation API key. Required unless dry run is on. */
    adminKey: string | undefined;
    environmentKeys: Record<string, string>;
  };
  /** Kill rule for a guarded flag, or undefined if FlagGuard does not guard it. */
  ruleFor(environment: string, flag: string): KillRuleConfig | undefined;
  /** Every guarded (environment, flag) pair. */
  guardedFlags(): { environment: string; flag: string; rule: KillRuleConfig }[];
}

type RuleOverrides = z.infer<typeof ruleOverridesSchema>;

function toRule(base: KillRuleConfig, o: RuleOverrides): KillRuleConfig {
  return {
    minRequests: o.min_requests ?? base.minRequests,
    maxDiff: o.max_diff_points !== undefined ? o.max_diff_points / 100 : base.maxDiff,
    minErrorRate:
      o.min_error_rate_percent !== undefined ? o.min_error_rate_percent / 100 : base.minErrorRate,
    maxErrorRateWithoutBaseline:
      o.max_error_rate_without_baseline_percent !== undefined
        ? o.max_error_rate_without_baseline_percent / 100
        : base.maxErrorRateWithoutBaseline,
    consecutiveBreaches: o.consecutive_breaches ?? base.consecutiveBreaches,
  };
}

export class ConfigError extends Error {}

/** Builds the config from YAML text and environment variables. Pure, so tests need no files. */
export function parseConfig(yamlText: string, env: NodeJS.ProcessEnv): ServerConfig {
  const raw: unknown = yamlText.trim() === '' ? {} : parseYaml(yamlText);
  const parsed = fileSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new ConfigError(`Invalid flagguard.yml:\n${issues.join('\n')}`);
  }
  const file = parsed.data;

  // Secure default: refuse to start with a missing or placeholder ingest key (Problem 8).
  const ingestKey = env.FLAGGUARD_INGEST_KEY ?? '';
  if (ingestKey.length < 16) {
    throw new ConfigError(
      'FLAGGUARD_INGEST_KEY must be at least 16 characters. Generate one with: openssl rand -hex 24',
    );
  }

  const port = Number(env.PORT ?? 4000);
  if (!Number.isInteger(port) || port <= 0) throw new ConfigError(`Invalid PORT: ${env.PORT}`);

  const base = toRule(DEFAULT_KILL_RULE, file.defaults);
  const rules = new Map<string, { environment: string; flag: string; rule: KillRuleConfig }>();
  for (const [flag, settings] of Object.entries(file.flags)) {
    const rule = toRule(base, settings);
    for (const environment of settings.environments) {
      rules.set(`${environment}\u0000${flag}`, { environment, flag, rule });
    }
  }

  const adminKey = env.FLAGSMITH_ADMIN_API_KEY?.trim() || undefined;
  if (!file.dry_run) {
    if (adminKey === undefined) {
      throw new ConfigError(
        'dry_run is false, so FLAGSMITH_ADMIN_API_KEY is required (Organisation Settings > API Keys)',
      );
    }
    const missing = [...rules.values()]
      .map((r) => r.environment)
      .filter(
        (e, i, all) => all.indexOf(e) === i && file.flagsmith.environment_keys[e] === undefined,
      );
    if (missing.length > 0) {
      throw new ConfigError(
        `dry_run is false, so flagsmith.environment_keys needs a key for: ${missing.join(', ')}`,
      );
    }
  }

  return {
    port,
    ingestKey,
    dryRun: file.dry_run,
    rateLimit: { perSecond: file.rate_limit.per_second, burst: file.rate_limit.burst },
    flagsmith: {
      apiUrl: env.FLAGSMITH_API_URL?.trim() || 'https://api.flagsmith.com/api/v1',
      adminKey,
      environmentKeys: file.flagsmith.environment_keys,
    },
    ruleFor: (environment, flag) => rules.get(`${environment}\u0000${flag}`)?.rule,
    guardedFlags: () => [...rules.values()],
  };
}

/** Reads flagguard.yml from disk. A missing file means "no flags guarded yet". */
export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  return parseConfig(text, env);
}
