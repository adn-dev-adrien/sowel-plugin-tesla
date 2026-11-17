/**
 * Tesla Fleet API client (spec 001): tokens, partner registration, the four
 * vehicle reads, and the billing count. No secret, token or full VIN ever
 * reaches an error message or a log line.
 */

import type { Budget } from "./budget.js";

export const AUTHORIZE_URL = "https://auth.tesla.com/oauth2/v3/authorize";
export const TOKEN_URL = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";
export const API_BASE: Readonly<Record<Region, string>> = {
  eu: "https://fleet-api.prd.eu.vn.cloud.tesla.com",
  na: "https://fleet-api.prd.na.vn.cloud.tesla.com",
};
export const SCOPES = "openid offline_access vehicle_device_data";
export const LIVE_ENDPOINTS = "charge_state;vehicle_state";

export type Region = "eu" | "na";

export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type Http = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<HttpResponse>;

export const fetchHttp: Http = (url, init) => fetch(url, init);

export type FleetErrorKind =
  | "auth" // refresh token used, expired or revoked: the user must reconnect
  | "credentials" // client id / secret refused (partner token): fix the settings
  | "payment" // 402: no payment method or billing limit reached
  | "rate" // 429
  | "asleep" // 408
  | "unavailable" // 404 / 412 on a cached read: no cached data for this car
  | "unregistered" // 412 elsewhere: partner account not registered in the region
  | "cap" // our own monthly cap
  | "http"
  | "network";

export class FleetError extends Error {
  constructor(
    readonly kind: FleetErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "FleetError";
  }
}

export interface Credentials {
  clientId: string;
  clientSecret: string;
  region: Region;
  domain: string;
}

export interface TokenStore {
  get(): string | undefined;
  /** Called with each new refresh token BEFORE it is used (they are single-use). */
  set(refreshToken: string): void;
}

export interface Vehicle {
  vin: string;
  displayName: string;
  state: string;
}

/** Callback URL of the core's plugin OAuth route. */
export function redirectUriOf(domain: string): string {
  return `https://${domain}/api/v1/plugins/tesla/oauth/callback`;
}

export function authorizeUrl(creds: Credentials, state: string): string {
  return (
    `${AUTHORIZE_URL}?` +
    new URLSearchParams({
      response_type: "code",
      client_id: creds.clientId,
      redirect_uri: redirectUriOf(creds.domain),
      scope: SCOPES,
      state,
      prompt_missing_scopes: "true",
    }).toString()
  );
}

const TOKEN_MARGIN_MS = 5 * 60_000;

/** In-flight refreshes, by client id: module-wide on purpose (see accessToken). */
const REFRESHING = new Map<string, Promise<Record<string, unknown>>>();

export class FleetClient {
  private access: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly creds: Credentials,
    private readonly tokens: TokenStore,
    private readonly budget: Budget,
    private readonly http: Http = fetchHttp,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get base(): string {
    return API_BASE[this.creds.region];
  }

  hasRefreshToken(): boolean {
    return Boolean(this.tokens.get());
  }

  // ── OAuth ───────────────────────────────────────────────────

  private async form(
    params: Record<string, string>,
    refusedKind: "auth" | "credentials" = "auth",
  ): Promise<Record<string, unknown>> {
    let res: HttpResponse;
    try {
      res = await this.http(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
      });
    } catch {
      throw new FleetError("network", "Tesla authentication server unreachable");
    }
    const body = parse(await res.text());
    if (res.status >= 200 && res.status < 300) return body;
    const code = typeof body.error === "string" ? body.error : "";
    if (res.status === 400 || res.status === 401)
      throw new FleetError(
        refusedKind,
        `Tesla refused the token request (${code || res.status})`,
        res.status,
      );
    throw new FleetError("http", `Tesla token request failed (${res.status})`, res.status);
  }

  /** The authorization code from the Connect button → a stored refresh token. */
  async exchangeCode(code: string): Promise<void> {
    const body = await this.form({
      grant_type: "authorization_code",
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      code,
      audience: this.base,
      redirect_uri: redirectUriOf(this.creds.domain),
    });
    this.storeTokens(body);
  }

  private storeTokens(body: Record<string, unknown>, saveRefresh = true): string {
    // Saved before anything else: a refresh token is single-use, the old one
    // is now spent, and losing the new one means a new Connect (review).
    if (saveRefresh && typeof body.refresh_token === "string" && body.refresh_token)
      this.tokens.set(body.refresh_token);
    const access = typeof body.access_token === "string" ? body.access_token : "";
    if (!access) throw new FleetError("auth", "Tesla returned no access token");
    const ttl = typeof body.expires_in === "number" ? body.expires_in * 1000 : 3_600_000;
    this.access = { token: access, expiresAt: this.now() + ttl };
    return access;
  }

  private async accessToken(force = false): Promise<string> {
    if (!force && this.access && this.access.expiresAt - TOKEN_MARGIN_MS > this.now())
      return this.access.token;
    // One refresh at a time per application, across client instances: a
    // restart builds a new client while the old one may still be refreshing,
    // and two refreshes would spend the same single-use token (review #7).
    const key = this.creds.clientId;
    let shared = REFRESHING.get(key);
    if (!shared) {
      shared = (async () => {
        const refresh = this.tokens.get();
        if (!refresh) throw new FleetError("auth", "Not connected to a Tesla account");
        const body = await this.form({
          grant_type: "refresh_token",
          client_id: this.creds.clientId,
          refresh_token: refresh,
        });
        if (typeof body.refresh_token === "string" && body.refresh_token)
          this.tokens.set(body.refresh_token);
        return body;
      })().finally(() => REFRESHING.delete(key));
      REFRESHING.set(key, shared);
    }
    // Already saved once, inside the shared refresh.
    return this.storeTokens(await shared, false);
  }

  // ── Partner registration (FR1c) ─────────────────────────────

  /** Registers the domain in the region unless Tesla already knows it. Not billed. */
  async ensureRegistered(): Promise<"already" | "registered"> {
    const partner = await this.form(
      {
        grant_type: "client_credentials",
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        scope: SCOPES,
        audience: this.base,
      },
      "credentials",
    );
    const token = typeof partner.access_token === "string" ? partner.access_token : "";
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const check = await this.http(
      `${this.base}/api/1/partner_accounts/public_key?domain=${encodeURIComponent(this.creds.domain)}`,
      { headers },
    );
    const known = parse(await check.text());
    if (check.status === 200 && rec(known.response)?.public_key) return "already";
    const reg = await this.http(`${this.base}/api/1/partner_accounts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ domain: this.creds.domain }),
    });
    if (reg.status >= 200 && reg.status < 300) return "registered";
    throw new FleetError(
      "unregistered",
      `Tesla refused to register ${this.creds.domain} (${reg.status}): is the public key served there?`,
      reg.status,
    );
  }

  // ── Vehicle API (billed) ────────────────────────────────────

  private async api(path: string, cached = false): Promise<unknown> {
    if (!this.budget.canSpend())
      throw new FleetError("cap", `Monthly cap of ${this.budget.limit()} requests reached`);
    let token = await this.accessToken();
    let res = await this.call(path, token);
    if (res.status === 401) {
      token = await this.accessToken(true);
      if (!this.budget.canSpend())
        throw new FleetError("cap", `Monthly cap of ${this.budget.limit()} requests reached`);
      res = await this.call(path, token);
    }
    const body = parse(await res.text());
    const s = res.status;
    if (s >= 200 && s < 300) return body.response;
    if (s === 401) throw new FleetError("auth", "Tesla rejected the access token", s);
    if (s === 402) throw new FleetError("payment", "Tesla requires a payment method (402)", s);
    if (s === 408) throw new FleetError("asleep", "The car is asleep or offline", s);
    if (s === 429) {
      const retry = Number(res.headers.get("retry-after"));
      throw new FleetError(
        "rate",
        "Tesla rate limit",
        s,
        Number.isFinite(retry) && retry > 0 ? retry * 1000 : 60_000,
      );
    }
    if (cached && (s === 404 || s === 412))
      throw new FleetError("unavailable", "No cached data for this car", s);
    if (s === 412) throw new FleetError("unregistered", "Partner account not registered", s);
    throw new FleetError("http", `Tesla API answered ${s}`, s);
  }

  private async call(path: string, token: string): Promise<HttpResponse> {
    let res: HttpResponse;
    try {
      res = await this.http(this.base + path, { headers: { authorization: `Bearer ${token}` } });
    } catch {
      throw new FleetError("network", "Tesla API unreachable");
    }
    // Billing: every answer under 500 counts, whatever its status.
    if (res.status < 500) this.budget.record();
    return res;
  }

  async vehicles(): Promise<Vehicle[]> {
    const list = await this.api("/api/1/vehicles");
    return (Array.isArray(list) ? list : []).map(vehicleOf).filter((v): v is Vehicle => !!v);
  }

  async vehicle(vin: string): Promise<Vehicle | null> {
    return vehicleOf(await this.api(`/api/1/vehicles/${encodeURIComponent(vin)}`));
  }

  /** A live read: only on a car known to be online (FR6). */
  async liveData(vin: string): Promise<unknown> {
    const q = encodeURIComponent(LIVE_ENDPOINTS);
    return this.api(`/api/1/vehicles/${encodeURIComponent(vin)}/vehicle_data?endpoints=${q}`);
  }

  /** The car's last report to Tesla: never wakes it, may be hours old, no odometer. */
  async cachedData(vin: string): Promise<unknown> {
    return this.api(`/api/1/vehicles/${encodeURIComponent(vin)}/vehicle_data_cached`, true);
  }
}

function parse(text: string): Record<string, unknown> {
  try {
    return rec(JSON.parse(text)) ?? {};
  } catch {
    return {};
  }
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

function vehicleOf(v: unknown): Vehicle | null {
  const r = rec(v);
  if (!r || typeof r.vin !== "string") return null;
  return {
    vin: r.vin,
    displayName: typeof r.display_name === "string" && r.display_name ? r.display_name : "Tesla",
    state: typeof r.state === "string" ? r.state : "unknown",
  };
}
