import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Http } from "./fleet.js";
import { TeslaPlugin } from "./index.js";
import type { PluginDeps } from "./sowel-api.js";
import { DURING_MS, SETTLE_MS, type Timers } from "./trigger.js";

const VIN = "LRWTESTVIN0001234";
const CHARGER = "charger-eq-1";

const LIVE = {
  charge_state: {
    battery_level: 81,
    battery_range: 197.17,
    charging_state: "Charging",
    charge_limit_soc: 100,
    charger_actual_current: 13,
    charger_voltage: 224,
    timestamp: 1794933730847,
  },
  vehicle_state: { odometer: 30920.9 },
};

interface World {
  carState: string;
  apiStatus?: number;
  tokenStatus?: number;
}

function setup(settingsInit: Record<string, string> = {}, world: World = { carState: "online" }) {
  const settings = new Map<string, string>(
    Object.entries({
      "integration.tesla.client_id": "cid",
      "integration.tesla.client_secret": "csecret",
      "integration.tesla.domain": "https://domotique.example.org/",
      "integration.tesla.charger_equipment_id": CHARGER,
      "integration.tesla.refresh_token": "rt-1",
      "integration.tesla.registered": "eu:domotique.example.org:cid",
      ...settingsInit,
    }),
  );
  const events: Record<string, unknown>[] = [];
  const handlers: ((e: { type: string } & Record<string, unknown>) => void)[] = [];
  const data: Record<string, unknown>[] = [];
  const devices: string[] = [];
  const calls: string[] = [];
  let n = 0;
  const http: Http = async (url) => {
    calls.push(url);
    let status = 200;
    let body: unknown;
    if (url.includes("oauth2")) {
      status = world.tokenStatus ?? 200;
      body = { access_token: `at-${++n}`, refresh_token: `rt-${n + 1}`, expires_in: 28800 };
    } else if (world.apiStatus) {
      status = world.apiStatus;
    } else if (url.endsWith("/api/1/vehicles")) {
      body = { response: [{ vin: VIN, display_name: "My Tesla", state: world.carState }] };
    } else if (url.includes("vehicle_data_cached")) {
      body = { response: { ...LIVE, vehicle_state: {} } };
    } else if (url.includes("vehicle_data")) {
      body = { response: LIVE };
    } else {
      body = { response: { vin: VIN, state: world.carState } };
    }
    return { status, headers: { get: () => null }, text: async () => JSON.stringify(body ?? {}) };
  };
  const deps = {
    logger: {
      child: () => deps.logger,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    eventBus: {
      emit: (e: unknown) => void events.push(e as Record<string, unknown>),
      on: (h: (e: { type: string } & Record<string, unknown>) => void) => {
        handlers.push(h);
        return () => handlers.splice(handlers.indexOf(h), 1);
      },
    },
    settingsManager: {
      get: (k: string) => settings.get(k),
      set: (k: string, v: string) => void settings.set(k, v),
    },
    deviceManager: {
      upsertFromDiscovery: (_i: string, _s: string, d: { friendlyName: string }) =>
        void devices.push(d.friendlyName),
      updateDeviceData: (_i: string, _s: string, p: Record<string, unknown>) => void data.push(p),
      updateDeviceStatus: () => undefined,
      removeStaleDevices: () => undefined,
      logSummary: () => undefined,
    },
    pluginDir: "/tmp",
  } as unknown as PluginDeps;

  const timers: Timers = {
    now: () => Date.now(),
    set: (ms, fn) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
  };
  const plugin = new TeslaPlugin(deps, http, timers);
  const power = (value: number, equipmentId = CHARGER, alias = "power") =>
    handlers.forEach((h) => h({ type: "equipment.data.changed", equipmentId, alias, value }));
  const apiCalls = () => calls.filter((c) => !c.includes("oauth2"));
  return { plugin, settings, events, data, devices, calls, apiCalls, power, world };
}

async function flush() {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 17, 10, 0));
});
afterEach(() => vi.useRealTimers());

describe("TeslaPlugin", () => {
  it("is not configured without client id, secret and domain", async () => {
    const h = setup({ "integration.tesla.client_secret": "" });
    expect(h.plugin.isConfigured()).toBe(false);
    await h.plugin.start();
    expect(h.plugin.getStatus()).toBe("not_configured");
    expect(h.calls).toEqual([]);
  });

  it("waits for Connect when no account is linked, without any request", async () => {
    const h = setup({ "integration.tesla.refresh_token": "" });
    await h.plugin.start();
    await flush();
    expect(h.calls).toEqual([]);
    // not_configured: the core does not wait for it before starting recipes
    expect(h.plugin.getStatus()).toBe("not_configured");
  });

  it("discovers the car and reads it live when online, then is connected", async () => {
    const h = setup();
    await h.plugin.start();
    await flush();
    expect(h.devices).toEqual(["Tesla 1234"]);
    expect(h.data.at(-1)).toMatchObject({ battery_level: 81, mileage: 49762.4, range: 317 });
    expect(h.plugin.getStatus()).toBe("connected");
    // list + state + live read
    expect(h.apiCalls()).toHaveLength(3);
    // The rotated refresh token is persisted.
    expect(h.settings.get("integration.tesla.refresh_token")).toBe("rt-2");
  });

  it("reads the cache of a sleeping car, never a live read", async () => {
    const h = setup({}, { carState: "asleep" });
    await h.plugin.start();
    await flush();
    expect(h.apiCalls().some((c) => c.includes("vehicle_data_cached"))).toBe(true);
    expect(h.apiCalls().some((c) => /vehicle_data\?/.test(c))).toBe(false);
    expect(h.data.at(-1)).not.toHaveProperty("mileage");
  });

  it("reads around a charge seen on the charger's power", async () => {
    const h = setup();
    await h.plugin.start();
    await flush();
    const base = h.apiCalls().length;
    // The startup read is recent: the start read is skipped, the end is read.
    await vi.advanceTimersByTimeAsync(DURING_MS);
    h.power(2980);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await flush();
    const afterStart = h.apiCalls().length;
    expect(afterStart - base).toBe(2); // state + live
    await vi.advanceTimersByTimeAsync(DURING_MS);
    await flush();
    expect(h.apiCalls().length - afterStart).toBe(2);
    h.power(0);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await flush();
    expect(h.apiCalls().length - afterStart).toBe(4);
  });

  it("ignores another equipment's power", async () => {
    const h = setup();
    await h.plugin.start();
    await flush();
    const base = h.apiCalls().length;
    await vi.advanceTimersByTimeAsync(DURING_MS);
    h.power(3000, "another-equipment");
    h.power(3000, CHARGER, "energy");
    await vi.advanceTimersByTimeAsync(SETTLE_MS * 2);
    expect(h.apiCalls().length).toBe(base);
  });

  it("raises an alarm and stops when the account link expired", async () => {
    const h = setup({}, { carState: "online", tokenStatus: 401 });
    await h.plugin.start();
    await flush();
    expect(h.plugin.getStatus()).toBe("error");
    expect(h.events.find((e) => e.type === "system.alarm.raised")?.alarmId).toBe("tesla:auth");
    // no retry loop
    const n = h.calls.length;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(h.calls.length).toBe(n);
  });

  it("raises a payment alarm on 402", async () => {
    const h = setup({}, { carState: "online", apiStatus: 402 });
    await h.plugin.start();
    await flush();
    expect(h.events.some((e) => e.alarmId === "tesla:payment")).toBe(true);
  });

  it("raises the cap alarm and makes no request at the cap", async () => {
    const h = setup({
      "integration.tesla.monthly_cap": "5",
      "integration.tesla.usage": JSON.stringify({ month: "2026-11", count: 5 }),
    });
    await h.plugin.start();
    await flush();
    expect(h.apiCalls()).toEqual([]);
    expect(h.events.some((e) => e.alarmId === "tesla:cap")).toBe(true);
  });

  it("builds the Connect URL from the settings, with a normalised domain", () => {
    const h = setup();
    const url = new URL(h.plugin.getOAuthUrl()!);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://domotique.example.org/api/v1/plugins/tesla/oauth/callback",
    );
    expect(url.searchParams.get("client_id")).toBe("cid");
  });

  it("stores the token from the callback and starts", async () => {
    const h = setup({ "integration.tesla.refresh_token": "" });
    await h.plugin.start();
    h.plugin.getOAuthUrl(); // the Connect click
    await h.plugin.handleOAuthCallback("code-1");
    await flush();
    expect(h.settings.get("integration.tesla.refresh_token")).toMatch(/^rt-/);
    expect(h.devices).toEqual(["Tesla 1234"]);
  });

  it("refuses a callback that no Connect click armed", async () => {
    const h = setup({ "integration.tesla.refresh_token": "" });
    await h.plugin.start();
    await expect(h.plugin.handleOAuthCallback("forged")).rejects.toThrow(/Connecter/);
    expect(h.calls).toEqual([]);
    // and a click arms one callback only
    h.plugin.getOAuthUrl();
    await h.plugin.handleOAuthCallback("code-1");
    await expect(h.plugin.handleOAuthCallback("code-2")).rejects.toThrow(/Connecter/);
  });

  it("refuses a callback after the Connect window", async () => {
    const h = setup({ "integration.tesla.refresh_token": "" });
    h.plugin.getOAuthUrl();
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    await expect(h.plugin.handleOAuthCallback("late")).rejects.toThrow(/Connecter/);
  });

  it("resolves the cap alarm when a new month reads again", async () => {
    const h = setup({
      "integration.tesla.monthly_cap": "5",
      "integration.tesla.usage": JSON.stringify({ month: "2026-11", count: 5 }),
    });
    await h.plugin.start();
    await flush();
    expect(
      h.events.some((e) => e.type === "system.alarm.raised" && e.alarmId === "tesla:cap"),
    ).toBe(true);
    vi.setSystemTime(new Date(2026, 11, 1, 6, 0));
    await h.plugin.start();
    await flush();
    expect(
      h.events.some((e) => e.type === "system.alarm.resolved" && e.alarmId === "tesla:cap"),
    ).toBe(true);
  });

  it("tells refused application credentials apart from an expired link", async () => {
    const h = setup(
      { "integration.tesla.registered": "" },
      { carState: "online", tokenStatus: 401 },
    );
    await h.plugin.start();
    await flush();
    expect(h.events.find((e) => e.type === "system.alarm.raised")?.alarmId).toBe(
      "tesla:credentials",
    );
  });

  it("does not double its timers when restarted while connecting", async () => {
    const h = setup();
    void h.plugin.start();
    void h.plugin.start();
    await h.plugin.start();
    await flush();
    expect(h.apiCalls().filter((c) => c.endsWith("/api/1/vehicles"))).toHaveLength(1);
    const before = h.apiCalls().length;
    // next 19:00 daily read: exactly one (state + read)
    await vi.advanceTimersByTimeAsync(9.5 * 3_600_000);
    await flush();
    expect(h.apiCalls().length - before).toBe(2);
  });

  it("makes no billed request after stop", async () => {
    const h = setup();
    await h.plugin.start();
    await flush();
    await h.plugin.stop();
    const n = h.calls.length;
    h.power(3000);
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(h.calls.length).toBe(n);
  });

  it("refresh order reads the car now", async () => {
    const h = setup();
    await h.plugin.start();
    await flush();
    const base = h.apiCalls().length;
    await h.plugin.executeOrder(
      { id: "d", integrationId: "tesla", sourceDeviceId: "Tesla 1234", name: "x" },
      "refresh",
      true,
    );
    expect(h.apiCalls().length - base).toBe(2);
  });
});
