/**
 * Tesla Fleet API answers → the electric vehicle contract (core spec 183).
 * Pure functions: no I/O, no clock. Field names and units measured on the
 * owner's Model 3 on 2026-11-17 (spec 001, "Measured").
 */

export const EV_CHARGING_STATES = [
  "unplugged",
  "idle",
  "scheduled",
  "waiting",
  "charging",
  "completed",
  "error",
] as const;
export type EvChargingState = (typeof EV_CHARGING_STATES)[number];

const KM_PER_MILE = 1.609344;

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

/** Miles → km, rounded to the kilometre for a range, to 0.1 km for an odometer. */
export function milesToKm(miles: number, decimals = 0): number {
  const f = 10 ** decimals;
  return Math.round(miles * KM_PER_MILE * f) / f;
}

/**
 * Tesla's `charging_state` → the contract. `null` for an unknown value: the
 * caller keeps the previous one (FR "anything else").
 */
export function chargingStateOf(state: unknown, scheduledPending: unknown): EvChargingState | null {
  switch (state) {
    case "Disconnected":
      return "unplugged";
    case "Charging":
    case "Starting":
      return "charging";
    case "Complete":
      return "completed";
    case "Stopped":
      return scheduledPending === true ? "scheduled" : "idle";
    case "NoPower":
      return "waiting";
    default:
      return null;
  }
}

/**
 * The car's charging power in W. `charger_power` is an integer in kW (3 for
 * 2.9 kW), so current × voltage is preferred when both are there.
 */
export function chargePowerW(chargeState: Record<string, unknown>): number | undefined {
  const amps = num(chargeState.charger_actual_current);
  const volts = num(chargeState.charger_voltage);
  const phases = num(chargeState.charger_phases);
  if (amps !== undefined && volts !== undefined) {
    // A three-phase charge reports the per-phase current and voltage.
    const factor = phases !== undefined && phases > 1 ? phases : 1;
    return amps > 0 && volts > 50 ? Math.round(amps * volts * factor) : 0;
  }
  const kw = num(chargeState.charger_power);
  return kw === undefined ? undefined : Math.round(kw * 1000);
}

export interface MappedRead {
  payload: Record<string, unknown>;
  /** A `charging_state` value the mapping does not know, for a one-time log. */
  unknownChargingState?: string;
}

/**
 * The `response` of `vehicle_data` or `vehicle_data_cached` → the contract
 * payload. Absent fields are omitted, so a cached read (no odometer) leaves the
 * previous mileage in place.
 */
export function mapVehicleData(response: unknown): MappedRead {
  const out: Record<string, unknown> = {};
  const r = rec(response);
  const cs = rec(r?.charge_state);
  const vs = rec(r?.vehicle_state);
  let unknownChargingState: string | undefined;

  if (cs) {
    const level = num(cs.battery_level);
    if (level !== undefined) out.battery_level = level;
    const range = num(cs.battery_range);
    if (range !== undefined) out.range = milesToKm(range);
    const limit = num(cs.charge_limit_soc);
    if (limit !== undefined) out.charge_limit = limit;
    if (typeof cs.charging_state === "string") {
      out.plugged = cs.charging_state !== "Disconnected";
      const state = chargingStateOf(cs.charging_state, cs.scheduled_charging_pending);
      if (state) out.charging_state = state;
      else unknownChargingState = cs.charging_state;
    }
    const power = chargePowerW(cs);
    if (power !== undefined) out.charge_power = power;
    const ts = num(cs.timestamp);
    if (ts !== undefined) out.reported_at = new Date(ts).toISOString();
  }
  if (vs) {
    const odo = num(vs.odometer);
    if (odo !== undefined) out.mileage = milesToKm(odo, 1);
  }
  return unknownChargingState ? { payload: out, unknownChargingState } : { payload: out };
}

/** `Tesla 1234`: the device's source id, never the full VIN (FR4). */
export function sourceIdOf(vin: string): string {
  return `Tesla ${vin.slice(-4)}`;
}
