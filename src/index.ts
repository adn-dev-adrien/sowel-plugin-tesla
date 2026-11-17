/**
 * Sowel plugin: Tesla (spec 001)
 *
 * A Tesla through the official Fleet API, read-only, published as a device
 * carrying the electric vehicle contract of core spec 183. Every request is
 * billed by Tesla, so the car is read only when a read is useful: around the
 * charges seen on the charger's power, twice a day otherwise, and on demand.
 * The plugin never wakes the car.
 */

import { randomBytes } from "node:crypto";
import { Budget } from "./budget.js";
import {
  isConfigured,
  readConfig,
  REFRESH_TOKEN_KEY,
  REGISTERED_KEY,
  SETTINGS_SCHEMA,
  USAGE_KEY,
  type PluginConfig,
} from "./config.js";
import { authorizeUrl, fetchHttp, FleetClient, FleetError, type Http } from "./fleet.js";
import { EV_CHARGING_STATES, mapVehicleData, sourceIdOf } from "./mapping.js";
import { Scheduler } from "./scheduler.js";
import type {
  Device,
  DiscoveredDevice,
  IntegrationPlugin,
  IntegrationSettingDef,
  IntegrationStatus,
  Logger,
  PluginDeps,
} from "./sowel-api.js";
import { ChargeTrigger, nextDaily, realTimers, type ReadReason, type Timers } from "./trigger.js";

export const INTEGRATION_ID = "tesla";
export const DISCOVERY_EVERY_MS = 24 * 3_600_000;
const RETRY_DISCOVERY_MS = 15 * 60_000;

type Reason = ReadReason | "daily" | "refresh" | "startup";

const ALARM = {
  auth: "tesla:auth",
  payment: "tesla:payment",
  cap: "tesla:cap",
  credentials: "tesla:credentials",
  charger: "tesla:charger",
} as const;

/** Errors a retry cannot fix: a person must act. */
const FATAL: ReadonlySet<string> = new Set(["auth", "payment", "credentials"]);
/** A Connect click is valid this long (review #8: the callback route is public). */
const CONNECT_WINDOW_MS = 15 * 60_000;

export function discoveredDevice(sourceId: string, displayName: string): DiscoveredDevice {
  return {
    friendlyName: sourceId,
    manufacturer: "Tesla",
    model: displayName,
    powerSource: "mains",
    data: [
      { key: "battery_level", type: "number", category: "ev_battery_level", unit: "%" },
      { key: "range", type: "number", category: "ev_range", unit: "km" },
      { key: "plugged", type: "boolean", category: "ev_plugged" },
      {
        key: "charging_state",
        type: "enum",
        category: "ev_charging_state",
        enumValues: [...EV_CHARGING_STATES],
      },
      { key: "charge_limit", type: "number", category: "ev_charge_limit", unit: "%" },
      { key: "charge_power", type: "number", category: "ev_charge_power", unit: "W" },
      { key: "mileage", type: "number", category: "ev_mileage", unit: "km" },
      { key: "reported_at", type: "string", category: "ev_reported_at" },
    ],
    // Core spec 184: read now. Never a wake (spec 001 A1).
    orders: [{ key: "refresh", type: "boolean", category: "ev_refresh" }],
  };
}

export class TeslaPlugin implements IntegrationPlugin {
  readonly id = INTEGRATION_ID;
  readonly name = "Tesla";
  readonly description =
    "Tesla through the official Fleet API: battery, range, charging state and mileage, read only around charges";
  readonly icon = "Car";
  readonly apiVersion = 2;

  private readonly logger: Logger;
  private status: IntegrationStatus = "not_configured";
  private cfg: PluginConfig | null = null;
  private client: FleetClient | null = null;
  private budget: Budget | null = null;
  private trigger: ChargeTrigger | null = null;
  private scheduler: Scheduler | null = null;
  private unsubscribe: (() => void) | null = null;
  /** sourceId → VIN. The VIN stays here and in request paths only. */
  private readonly cars = new Map<string, string>();
  private readonly raised = new Set<string>();
  private readonly unknownStates = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastPollAt: string | null = null;
  private generation = 0;
  private connectArmedUntil = 0;

  constructor(
    private readonly deps: PluginDeps,
    private readonly http: Http = fetchHttp,
    private readonly timers: Timers = realTimers,
  ) {
    this.logger = deps.logger.child({ module: "tesla" });
  }

  getStatus(): IntegrationStatus {
    return this.status;
  }

  isConfigured(): boolean {
    return isConfigured(this.deps.settingsManager);
  }

  getSettingsSchema(): IntegrationSettingDef[] {
    return SETTINGS_SCHEMA;
  }

  async start(): Promise<void> {
    await this.stop();
    const generation = ++this.generation;
    const settings = this.deps.settingsManager;
    this.cfg = readConfig(settings);
    if (!this.cfg) {
      this.status = "not_configured";
      return;
    }
    this.budget = new Budget(
      { get: () => settings.get(USAGE_KEY), set: (v) => settings.set(USAGE_KEY, v) },
      this.cfg.monthlyCap,
    );
    this.client = new FleetClient(
      this.cfg.creds,
      {
        get: () => settings.get(REFRESH_TOKEN_KEY) || undefined,
        set: (v) => settings.set(REFRESH_TOKEN_KEY, v),
      },
      this.budget,
      this.http,
    );
    this.scheduler = new Scheduler((err) => this.logger.error({ err }, "Tesla timer failed"));
    this.status = "disconnected";

    const charger = this.cfg.chargerEquipmentId;
    if (this.cfg.invalidCharger) {
      this.raise(
        ALARM.charger,
        "warning",
        "Tesla : l'identifiant de la borne n'est pas valide (36 caractères attendus, la fin de l'adresse de la page de la borne). Lectures limitées à 7 h et 19 h.",
      );
      this.logger.warn(
        { length: this.cfg.invalidCharger.length },
        "Tesla charger id is not an equipment id",
      );
    } else {
      this.resolve(ALARM.charger, "Tesla : borne reconnue");
    }
    if (charger) {
      this.trigger = new ChargeTrigger((reason) => this.readAll(reason), this.timers);
      this.unsubscribe = this.deps.eventBus.on((event) => {
        if (
          event.type === "equipment.data.changed" &&
          event.equipmentId === charger &&
          event.alias === "power"
        )
          this.trigger?.onPower(event.value);
      });
    }

    if (!this.client.hasRefreshToken()) {
      // Not "disconnected": the core waits for every integration that is not
      // `not_configured` before starting recipes (review #9).
      this.status = "not_configured";
      this.logger.info("Tesla plugin waiting for the Connect button (no account linked yet)");
      return;
    }
    this.logger.info(
      { region: this.cfg.creds.region, charger: Boolean(charger), cap: this.cfg.monthlyCap },
      "Tesla plugin started",
    );
    void this.connect(generation);
  }

  private async connect(generation: number): Promise<void> {
    const live = () => generation === this.generation;
    if (!live()) return;
    try {
      await this.ensureRegistered();
      if (!live()) return;
      await this.discover();
    } catch (err) {
      if (!live()) return;
      this.onError(err, "discovery");
      if (!(err instanceof FleetError && FATAL.has(err.kind)))
        this.scheduler?.after(RETRY_DISCOVERY_MS, () => this.connect(generation));
      return;
    }
    if (!live()) return;
    this.scheduler?.every(
      DISCOVERY_EVERY_MS,
      async () => {
        if (live()) await this.discover().catch((e) => this.onError(e, "discovery"));
      },
      DISCOVERY_EVERY_MS,
    );
    this.scheduleDaily(generation);
    void this.readAll("startup");
  }

  /** Once per domain and region (FR1c); partner calls are not billed. */
  private async ensureRegistered(): Promise<void> {
    if (!this.cfg || !this.client) return;
    const marker = `${this.cfg.creds.region}:${this.cfg.creds.domain}:${this.cfg.creds.clientId}`;
    const settings = this.deps.settingsManager;
    if (settings.get(REGISTERED_KEY) === marker) return;
    const outcome = await this.client.ensureRegistered();
    settings.set(REGISTERED_KEY, marker);
    this.logger.info({ outcome, region: this.cfg.creds.region }, "Tesla partner domain checked");
  }

  private async discover(): Promise<void> {
    if (!this.client) return;
    const vehicles = await this.client.vehicles();
    const active = new Set<string>();
    for (const v of vehicles) {
      const sourceId = sourceIdOf(v.vin);
      active.add(sourceId);
      this.cars.set(sourceId, v.vin);
      this.deps.deviceManager.upsertFromDiscovery(
        INTEGRATION_ID,
        INTEGRATION_ID,
        discoveredDevice(sourceId, v.displayName),
      );
    }
    for (const id of [...this.cars.keys()]) if (!active.has(id)) this.cars.delete(id);
    this.deps.deviceManager.removeStaleDevices(INTEGRATION_ID, active);
    this.markOk();
    this.logger.info({ vehicles: vehicles.length }, "Tesla vehicles discovered");
  }

  private scheduleDaily(generation: number): void {
    const now = new Date(this.timers.now());
    const at = nextDaily(now);
    this.scheduler?.after(at.getTime() - now.getTime(), async () => {
      if (generation !== this.generation) return;
      // A charge in progress already reads every 30 min.
      if (!this.trigger?.isCharging()) void this.readAll("daily");
      this.scheduleDaily(generation);
    });
  }

  /** Reads are serialised: two at once would only double the bill. */
  private readAll(reason: Reason): Promise<void> {
    const run = this.queue.then(async () => {
      for (const [sourceId, vin] of this.cars) await this.readCar(sourceId, vin, reason);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async readCar(sourceId: string, vin: string, reason: Reason): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      // FR6: ask first, so a sleeping car never costs a 408.
      const state = (await client.vehicle(vin))?.state ?? "unknown";
      let response: unknown;
      let source: "live" | "cached";
      if (state === "online") {
        response = await client.liveData(vin);
        source = "live";
      } else {
        response = await client.cachedData(vin);
        source = "cached";
      }
      const { payload, unknownChargingState } = mapVehicleData(response);
      if (unknownChargingState && !this.unknownStates.has(unknownChargingState)) {
        this.unknownStates.add(unknownChargingState);
        this.logger.warn(
          { value: unknownChargingState },
          "Unknown Tesla charging_state, previous value kept",
        );
      }
      if (client !== this.client) return; // stopped meanwhile
      if (Object.keys(payload).length > 0)
        this.deps.deviceManager.updateDeviceData(INTEGRATION_ID, sourceId, payload);
      this.deps.deviceManager.updateDeviceStatus(INTEGRATION_ID, sourceId, "online");
      this.lastPollAt = new Date(this.timers.now()).toISOString();
      this.markOk();
      this.logger.info(
        { car: sourceId, reason, state, source, used: this.budget?.used() },
        "Tesla vehicle read",
      );
    } catch (err) {
      if (err instanceof FleetError && err.kind === "unavailable") {
        this.logger.info({ car: sourceId, reason }, "No cached Tesla data, read skipped");
        return;
      }
      this.onError(err, reason);
      if (reason === "refresh") throw userError(err);
    }
  }

  private markOk(): void {
    this.setStatus("connected");
    this.resolve(ALARM.auth, "Compte Tesla reconnecté");
    this.resolve(ALARM.credentials, "Identifiants Tesla acceptés");
    this.resolve(ALARM.payment, "Facturation Tesla rétablie");
    this.resolve(ALARM.cap, "Tesla : nouveau mois, lectures reprises");
  }

  private onError(err: unknown, context: string): void {
    if (!(err instanceof FleetError)) {
      this.logger.error({ err, context }, "Tesla read failed");
      return;
    }
    switch (err.kind) {
      case "auth":
        this.setStatus("error");
        this.raise(
          ALARM.auth,
          "error",
          "Tesla : la connexion au compte a expiré. Réglages → Intégrations → Tesla → Connecter.",
        );
        break;
      case "credentials":
        this.setStatus("error");
        this.raise(
          ALARM.credentials,
          "error",
          "Tesla refuse l'identifiant client ou la clé secrète : vérifiez-les dans Réglages → Intégrations → Tesla.",
        );
        break;
      case "payment":
        this.setStatus("error");
        this.raise(
          ALARM.payment,
          "error",
          "Tesla refuse les requêtes : ajoutez un moyen de paiement ou relevez le plafond sur developer.tesla.com.",
        );
        break;
      case "cap":
        this.raise(
          ALARM.cap,
          "warning",
          `Tesla : plafond de ${this.budget?.limit()} requêtes atteint ce mois-ci, lectures suspendues jusqu'au 1er.`,
        );
        break;
      case "asleep":
        this.logger.info({ context }, "Tesla car asleep, read skipped");
        return;
      case "rate":
        this.logger.warn({ context, retryAfterMs: err.retryAfterMs }, "Tesla rate limit");
        return;
      default:
        this.setStatus("disconnected");
    }
    this.logger.warn(
      { context, kind: err.kind, status: err.status, msg: err.message },
      "Tesla request failed",
    );
  }

  private raise(alarmId: string, level: "warning" | "error", message: string): void {
    if (this.raised.has(alarmId)) return;
    this.raised.add(alarmId);
    this.deps.eventBus.emit({
      type: "system.alarm.raised",
      alarmId,
      level,
      source: INTEGRATION_ID,
      message,
    });
  }

  private resolve(alarmId: string, message: string): void {
    if (!this.raised.delete(alarmId)) return;
    this.deps.eventBus.emit({
      type: "system.alarm.resolved",
      alarmId,
      source: INTEGRATION_ID,
      message,
    });
  }

  private setStatus(status: IntegrationStatus): void {
    if (this.status === status) return;
    const was = this.status;
    this.status = status;
    if (status === "connected")
      this.deps.eventBus.emit({ type: "system.integration.connected", integrationId: this.id });
    else if (was === "connected")
      this.deps.eventBus.emit({ type: "system.integration.disconnected", integrationId: this.id });
  }

  getPollingInfo(): { lastPollAt: string; intervalMs: number } | null {
    if (!this.client) return null;
    return { lastPollAt: this.lastPollAt ?? new Date(0).toISOString(), intervalMs: 12 * 3_600_000 };
  }

  async stop(): Promise<void> {
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.trigger?.stop();
    this.trigger = null;
    this.scheduler?.stop();
    this.scheduler = null;
    this.client = null;
    this.cars.clear();
    if (this.status !== "not_configured") this.setStatus("disconnected");
  }

  async refresh(): Promise<void> {
    await this.readAll("refresh");
  }

  async executeOrder(device: Device, orderKey: string, _value?: unknown): Promise<void> {
    const vin = this.cars.get(device.sourceDeviceId);
    if (!vin) throw new Error("this vehicle is not connected");
    if (orderKey !== "refresh") throw new Error(`unknown order ${orderKey}`);
    const run = this.queue.then(() => this.readCar(device.sourceDeviceId, vin, "refresh"));
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ── Connect button (FR1b) ───────────────────────────────────

  getOAuthUrl(): string | null {
    const cfg = readConfig(this.deps.settingsManager);
    if (!cfg) return null;
    this.connectArmedUntil = this.timers.now() + CONNECT_WINDOW_MS;
    return authorizeUrl(cfg.creds, randomBytes(16).toString("hex"));
  }

  async handleOAuthCallback(code: string): Promise<void> {
    // The core's callback route needs no session and passes no `state`: accept
    // a code only within minutes of a Connect click from the settings page.
    if (this.timers.now() > this.connectArmedUntil)
      throw new Error("Cliquez d'abord sur Connecter dans les réglages Tesla");
    this.connectArmedUntil = 0;
    const cfg = readConfig(this.deps.settingsManager);
    if (!cfg) throw new Error("Renseignez l'identifiant client, la clé secrète et le domaine");
    const settings = this.deps.settingsManager;
    const client = new FleetClient(
      cfg.creds,
      {
        get: () => settings.get(REFRESH_TOKEN_KEY) || undefined,
        set: (v) => settings.set(REFRESH_TOKEN_KEY, v),
      },
      new Budget(
        { get: () => settings.get(USAGE_KEY), set: (v) => settings.set(USAGE_KEY, v) },
        cfg.monthlyCap,
      ),
      this.http,
    );
    try {
      await client.exchangeCode(code);
    } catch (err) {
      throw userError(err);
    }
    this.logger.info("Tesla account linked");
    await this.start();
  }
}

/** A message safe for the UI: never a token, a secret or a raw body. */
function userError(err: unknown): Error {
  return new Error(err instanceof FleetError ? err.message : "Tesla request failed");
}

export function createPlugin(deps: PluginDeps): IntegrationPlugin {
  return new TeslaPlugin(deps);
}
