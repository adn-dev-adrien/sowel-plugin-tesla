import { describe, expect, it } from "vitest";
import { Budget } from "./budget.js";
import { authorizeUrl, FleetClient, FleetError, redirectUriOf, type Http } from "./fleet.js";

const CREDS = {
  clientId: "cid",
  clientSecret: "csecret",
  region: "eu" as const,
  domain: "domotique.example.org",
};
const VIN = "LRWTESTVIN0001234";

/** The FleetError a promise rejects with; fails the test if it resolves. */
async function failure(p: Promise<unknown>): Promise<FleetError> {
  try {
    await p;
  } catch (e) {
    return e as FleetError;
  }
  throw new Error("expected a rejection");
}

type Route = (
  url: string,
  body?: string,
) => { status: number; body?: unknown; headers?: Record<string, string> };

function harness(route: Route, refresh = "rt-1", cap = 100) {
  const calls: { url: string; body?: string }[] = [];
  const http: Http = async (url, init) => {
    calls.push({ url, body: init.body });
    const r = route(url, init.body);
    return {
      status: r.status,
      headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null },
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {})),
    };
  };
  let token: string | undefined = refresh;
  const saved: string[] = [];
  let usage: string | undefined;
  const budget = new Budget({ get: () => usage, set: (v) => void (usage = v) }, cap);
  const client = new FleetClient(
    CREDS,
    { get: () => token, set: (v) => void (saved.push(v), (token = v)) },
    budget,
    http,
  );
  return { client, calls, saved, budget, token: () => token };
}

const tokenOk = (n: number) => ({
  status: 200,
  body: { access_token: `at-${n}`, refresh_token: `rt-${n + 1}`, expires_in: 28800 },
});

describe("FleetClient tokens", () => {
  it("rotates the refresh token and saves it before using the access token", async () => {
    const h = harness((url) =>
      url.includes("oauth2") ? tokenOk(1) : { status: 200, body: { response: [] } },
    );
    await h.client.vehicles();
    expect(h.saved).toEqual(["rt-2"]);
    const body = new URLSearchParams(h.calls[0].body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-1");
    // The access token is reused: one refresh for two calls.
    await h.client.vehicles();
    expect(h.calls.filter((c) => c.url.includes("oauth2"))).toHaveLength(1);
  });

  it("refreshes once, not twice, for parallel calls", async () => {
    const h = harness((url) =>
      url.includes("oauth2") ? tokenOk(1) : { status: 200, body: { response: [] } },
    );
    await Promise.all([h.client.vehicles(), h.client.vehicles()]);
    expect(h.calls.filter((c) => c.url.includes("oauth2"))).toHaveLength(1);
  });

  it("shares one refresh between two clients of the same application (restart race)", async () => {
    let tokenCalls = 0;
    let token: string | undefined = "rt-1";
    const store = { get: () => token, set: (v: string) => void (token = v) };
    const http: Http = async (url) => {
      if (url.includes("oauth2")) tokenCalls++;
      await new Promise((r) => setTimeout(r, 5));
      const body = url.includes("oauth2")
        ? { access_token: "at", refresh_token: "rt-2", expires_in: 28800 }
        : { response: [] };
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
    };
    const mk = () =>
      new FleetClient(
        { ...CREDS, clientId: "shared-app" },
        store,
        new Budget({ get: () => undefined, set: () => undefined }, 100),
        http,
      );
    await Promise.all([mk().vehicles(), mk().vehicles()]);
    expect(tokenCalls).toBe(1);
    expect(token).toBe("rt-2");
  });

  it("turns a refused refresh into an auth error with no token in the message", async () => {
    const h = harness(() => ({ status: 401, body: { error: "login_required" } }));
    const err = await failure(h.client.vehicles());
    expect(err).toBeInstanceOf(FleetError);
    expect(err.kind).toBe("auth");
    expect(err.message).not.toContain("rt-1");
  });

  it("exchanges the authorization code with the core's callback URL", async () => {
    const h = harness(() => tokenOk(7), "");
    await h.client.exchangeCode("the-code");
    const body = new URLSearchParams(h.calls[0].body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("redirect_uri")).toBe(
      "https://domotique.example.org/api/v1/plugins/tesla/oauth/callback",
    );
    expect(body.get("audience")).toBe("https://fleet-api.prd.eu.vn.cloud.tesla.com");
    expect(h.saved).toEqual(["rt-8"]);
  });
});

describe("FleetClient billing and errors", () => {
  function api(status: number, body: unknown = {}, headers?: Record<string, string>) {
    return harness((url) => (url.includes("oauth2") ? tokenOk(1) : { status, body, headers }));
  }

  it("counts every answer under 500, and none above", async () => {
    const ok = api(200, { response: [] });
    await ok.client.vehicles();
    expect(ok.budget.used()).toBe(1);
    const asleep = api(408);
    await asleep.client.liveData(VIN).catch(() => undefined);
    expect(asleep.budget.used()).toBe(1);
    const down = api(503);
    await down.client.liveData(VIN).catch(() => undefined);
    expect(down.budget.used()).toBe(0);
  });

  it("stops at the cap without calling Tesla", async () => {
    const h = harness(
      (url) => (url.includes("oauth2") ? tokenOk(1) : { status: 200, body: { response: [] } }),
      "rt-1",
      1,
    );
    await h.client.vehicles();
    const err = await failure(h.client.vehicles());
    expect(err.kind).toBe("cap");
    expect(h.calls.filter((c) => !c.url.includes("oauth2"))).toHaveLength(1);
  });

  it.each([
    [402, "payment"],
    [408, "asleep"],
    [412, "unregistered"],
    [500, "http"],
  ])("maps %i to %s", async (status, kind) => {
    const err = await failure(api(status).client.liveData(VIN));
    expect(err.kind).toBe(kind);
  });

  it("maps 404/412 on a cached read to unavailable", async () => {
    expect((await failure(api(412).client.cachedData(VIN))).kind).toBe("unavailable");
    expect((await failure(api(404).client.cachedData(VIN))).kind).toBe("unavailable");
  });

  it("reads Retry-After on a 429", async () => {
    const err = await failure(api(429, {}, { "retry-after": "42" }).client.liveData(VIN));
    expect(err.kind).toBe("rate");
    expect(err.retryAfterMs).toBe(42_000);
  });

  it("refreshes and retries once on a 401 from the API", async () => {
    let apiCalls = 0;
    let n = 0;
    const h = harness((url) => {
      if (url.includes("oauth2")) return tokenOk(++n);
      apiCalls++;
      return apiCalls === 1
        ? { status: 401 }
        : { status: 200, body: { response: { state: "online", vin: VIN } } };
    });
    expect((await h.client.vehicle(VIN))?.state).toBe("online");
    expect(h.saved).toEqual(["rt-2", "rt-3"]);
  });

  it("asks for the live endpoints only", async () => {
    const h = api(200, { response: {} });
    await h.client.liveData(VIN);
    expect(h.calls.at(-1)?.url).toContain("vehicle_data?endpoints=charge_state%3Bvehicle_state");
  });
});

describe("partner registration", () => {
  it("does nothing when Tesla already knows the domain", async () => {
    const h = harness((url) =>
      url.includes("oauth2")
        ? { status: 200, body: { access_token: "pt" } }
        : { status: 200, body: { response: { public_key: "04ab" } } },
    );
    expect(await h.client.ensureRegistered()).toBe("already");
    expect(h.calls.some((c) => c.url.endsWith("/partner_accounts"))).toBe(false);
    expect(h.budget.used()).toBe(0);
  });

  it("registers the domain otherwise", async () => {
    const h = harness((url) =>
      url.includes("oauth2")
        ? { status: 200, body: { access_token: "pt" } }
        : url.includes("public_key")
          ? { status: 404 }
          : { status: 200, body: { response: {} } },
    );
    expect(await h.client.ensureRegistered()).toBe("registered");
    expect(h.calls.at(-1)?.body).toBe(JSON.stringify({ domain: "domotique.example.org" }));
  });
});

describe("URLs", () => {
  it("builds the authorize URL with the read scope only", () => {
    const u = new URL(authorizeUrl(CREDS, "st"));
    expect(u.searchParams.get("scope")).toBe("openid offline_access vehicle_device_data");
    expect(u.searchParams.get("redirect_uri")).toBe(redirectUriOf(CREDS.domain));
    expect(u.searchParams.get("state")).toBe("st");
  });
});
