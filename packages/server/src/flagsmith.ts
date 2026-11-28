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
export class FlagsmithError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

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
  /** The feature's id: a number, or an object with an id, depending on the Flagsmith version. */
  feature?: number | { id: number };
  feature_segment?: unknown;
  identity?: unknown;
}

/**
 * Uses the Flagsmith Admin API, with the header  Authorization: Api-Key <organisation key>:
 *   GET   /api/v1/environments/{key}/featurestates/?feature_name={flag}  -> state id + feature id
 *   PATCH /api/v1/environments/{key}/featurestates/{id}/  {"enabled": false}
 * Environments with feature versioning turned on refuse that PATCH with 400. For those it
 * falls back to the newer endpoint from Flagsmith's docs:
 *   PATCH /api/__future__/environments/{key}/features/{feature_id}/
 *         {"environment_default": {"enabled": false}}
 */
export class FlagsmithController implements FlagController {
  private readonly apiUrl: string;
  /** Same server, newer API: .../api/v1 -> .../api/__future__ */
  private readonly futureUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: FlagsmithOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.futureUrl = this.apiUrl.replace(/\/v1$/, '/__future__');
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async getState(environment: string, flag: string): Promise<{ id: number; enabled: boolean }> {
    const state = await this.findState(environment, flag);
    return { id: state.id, enabled: state.enabled };
  }

  async disable(environment: string, flag: string): Promise<void> {
    const state = await this.findState(environment, flag);
    const envKey = encodeURIComponent(this.environmentKey(environment));
    try {
      await this.request(
        'PATCH',
        `${this.apiUrl}/environments/${envKey}/featurestates/${state.id}/`,
        {
          enabled: false,
        },
      );
    } catch (error) {
      const featureId = typeof state.feature === 'object' ? state.feature.id : state.feature;
      if (!(error instanceof FlagsmithError && error.status === 400) || featureId === undefined) {
        throw error;
      }
      // Feature versioning is on for this environment: use the newer endpoint.
      await this.request(
        'PATCH',
        `${this.futureUrl}/environments/${envKey}/features/${featureId}/`,
        {
          environment_default: { enabled: false },
        },
      );
    }
  }

  private async findState(environment: string, flag: string): Promise<FeatureState> {
    const envKey = encodeURIComponent(this.environmentKey(environment));
    const body = await this.request(
      'GET',
      `${this.apiUrl}/environments/${envKey}/featurestates/?feature_name=${encodeURIComponent(flag)}`,
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
    return state;
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

  private async request(method: string, url: string, json?: unknown): Promise<unknown> {
    const path = url.replace(/^https?:\/\/[^/]+/, ''); // for messages: no host
    let response: Response;
    try {
      response = await this.fetchFn(url, {
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
      // 400: request refused. 401/403: wrong key or permissions. 404: wrong environment key.
      // Retrying won't help. Include Flagsmith's own explanation, shortened.
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new FlagsmithError(
        `Flagsmith ${method} ${path} returned ${response.status}${detail ? `: ${detail}` : ''}`,
        response.status,
      );
    }
    return response.status === 204 ? null : response.json();
  }
}
