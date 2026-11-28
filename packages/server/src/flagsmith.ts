import { RetryableError } from './retry.js';

/**
 * The output edge that talks to Flagsmith. The rest of the server only knows this interface,
 * so tests can use a fake, and another flag provider could be added later.
 */
export interface FlagController {
  /** Current on/off state of a flag in an environment. */
  getState(environment: string, flag: string): Promise<{ id: number; enabled: boolean }>;
  /** Set the flag OFF. "Set", not "toggle", so repeating it is harmless (idempotent). */
  disable(environment: string, flag: string): Promise<void>;
}

/** A problem that retrying won't fix, such as a wrong admin key or a missing flag. */
export class FlagsmithError extends Error {}

export interface FlagsmithOptions {
  /** e.g. https://api.flagsmith.com/api/v1, or http://localhost:8000/api/v1 when self-hosted */
  apiUrl: string;
  /** Organisation API key. Lives only on the FlagGuard server (Problem 8). */
  adminKey: string;
  /** FlagGuard environment name -> Flagsmith environment key (from flagguard.yml). */
  environmentKeys: Record<string, string>;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

interface FeatureState {
  id: number;
  enabled: boolean;
  feature_segment?: unknown;
  identity?: unknown;
}

/**
 * Uses the Flagsmith Admin API:
 *   GET   /environments/{key}/featurestates/?feature_name={flag}  -> find the state's id
 *   PATCH /environments/{key}/featurestates/{id}/  {"enabled": false}
 * with the header  Authorization: Api-Key <organisation key>.
 */
export class FlagsmithController implements FlagController {
  private readonly apiUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: FlagsmithOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async getState(environment: string, flag: string): Promise<{ id: number; enabled: boolean }> {
    const envKey = this.environmentKey(environment);
    const body = await this.request(
      'GET',
      `/environments/${encodeURIComponent(envKey)}/featurestates/?feature_name=${encodeURIComponent(flag)}`,
    );

    // The API returns either a plain list or a paginated { results: [...] }.
    const list: FeatureState[] = Array.isArray(body)
      ? body
      : ((body as { results?: FeatureState[] }).results ?? []);
    // The environment default is the state that isn't a segment or identity override.
    const state = list.find((s) => s.feature_segment == null && s.identity == null);
    if (state === undefined) {
      throw new FlagsmithError(`Flag "${flag}" not found in environment "${environment}"`);
    }
    return { id: state.id, enabled: state.enabled };
  }

  async disable(environment: string, flag: string): Promise<void> {
    const { id } = await this.getState(environment, flag);
    const envKey = this.environmentKey(environment);
    await this.request(
      'PATCH',
      `/environments/${encodeURIComponent(envKey)}/featurestates/${id}/`,
      {
        enabled: false,
      },
    );
  }

  private environmentKey(environment: string): string {
    const key = this.options.environmentKeys[environment];
    if (key === undefined) {
      throw new FlagsmithError(
        `No Flagsmith environment key for "${environment}". Add it under flagsmith.environment_keys in flagguard.yml`,
      );
    }
    return key;
  }

  private async request(method: string, path: string, json?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.apiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Api-Key ${this.options.adminKey}`,
          'Content-Type': 'application/json',
        },
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // Network failure or timeout: we don't know if it worked, and retrying is safe.
      throw new RetryableError(`Flagsmith ${method} ${path} failed: ${String(error)}`);
    }

    if (response.status === 429 || response.status >= 500) {
      throw new RetryableError(`Flagsmith ${method} ${path} returned ${response.status}`);
    }
    if (!response.ok) {
      // 401/403: wrong key or permissions. 404: wrong environment key. Retrying won't help.
      throw new FlagsmithError(`Flagsmith ${method} ${path} returned ${response.status}`);
    }
    return response.status === 204 ? null : response.json();
  }
}
