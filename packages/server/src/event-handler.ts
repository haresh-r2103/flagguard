import type { AuditLog } from './audit-log.js';
import type { Notifier } from './alerts.js';
import type { GuardEvent } from './guardian.js';

export interface EventHandlerDeps {
  audit?: AuditLog;
  notifiers: Notifier[];
  now?: () => number;
  log?: (message: string) => void;
  /** At most one 'kill_failed' alert per flag in this period (default 5 minutes). */
  failureAlertCooldownMs?: number;
}

/**
 * What happens after the check loop produces an event:
 * 1. Always write it to the audit log (the permanent record).
 * 2. Send alerts, except repeated 'kill_failed' alerts inside the cooldown.
 *
 * 'killed' and 'would_kill' are already sent once per incident by the BreachTracker.
 * 'kill_failed' can repeat every ~15 s while Flagsmith is down, so it gets a cooldown
 * here: otherwise one outage would flood the channel (alert fatigue, Problem 6).
 *
 * A failing alert channel is logged and never stops the check loop or other channels.
 */
export function createEventHandler(deps: EventHandlerDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console.log;
  const cooldownMs = deps.failureAlertCooldownMs ?? 5 * 60_000;
  const lastFailureAlert = new Map<string, number>();

  return async (event: GuardEvent): Promise<void> => {
    try {
      deps.audit?.append(event);
    } catch (error) {
      log(`[audit] could not write: ${String(error)}`);
    }

    if (event.type === 'kill_failed') {
      const key = `${event.environment}/${event.flag}`;
      const last = lastFailureAlert.get(key);
      if (last !== undefined && now() - last < cooldownMs) return;
      lastFailureAlert.set(key, now());
    }

    // Send to every channel at once; one slow or broken channel doesn't block the others.
    const results = await Promise.allSettled(deps.notifiers.map((n) => n.send(event)));
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        log(`[alert] ${deps.notifiers[i]?.name ?? 'notifier'} failed: ${String(result.reason)}`);
      }
    });
  };
}
