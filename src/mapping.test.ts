import { describe, expect, it } from "vitest";
import { chargePowerW, chargingStateOf, mapVehicleData, milesToKm, sourceIdOf } from "./mapping.js";

// Measured on the owner's Model 3 on 2026-11-17 (live read while charging), trimmed.
const LIVE = {
  charge_state: {
    battery_level: 81,
    battery_range: 197.17,
    charging_state: "Charging",
    charge_limit_soc: 100,
    charger_power: 3,
    charger_actual_current: 13,
    charger_voltage: 224,
    charger_phases: 1,
    scheduled_charging_pending: false,
    timestamp: 1794933730847,
  },
  vehicle_state: { odometer: 30920.908994, timestamp: 1794933730847 },
};

// The cached read at the same moment: 79 min old, no odometer.
const CACHED = {
  charge_state: {
    battery_level: 75,
    battery_range: 181.37,
    charging_state: "Stopped",
    charge_limit_soc: 100,
    charger_power: 0,
    charger_actual_current: 0,
    charger_voltage: 2,
    scheduled_charging_pending: null,
    timestamp: 1794928982792,
  },
  vehicle_state: { timestamp: 1794928982832 },
};

describe("mapVehicleData", () => {
  it("maps the measured live read to the contract", () => {
    expect(mapVehicleData(LIVE).payload).toEqual({
      battery_level: 81,
      range: 317,
      charge_limit: 100,
      plugged: true,
      charging_state: "charging",
      charge_power: 2912,
      reported_at: new Date(1794933730847).toISOString(),
      mileage: 49762.4,
    });
  });

  it("maps a cached read without inventing a mileage", () => {
    const { payload } = mapVehicleData(CACHED);
    expect(payload).not.toHaveProperty("mileage");
    expect(payload).toMatchObject({ battery_level: 75, charging_state: "idle", charge_power: 0 });
  });

  it("reports an unknown charging_state and leaves it out of the payload", () => {
    const r = mapVehicleData({ charge_state: { charging_state: "Teleporting" } });
    expect(r.unknownChargingState).toBe("Teleporting");
    expect(r.payload).not.toHaveProperty("charging_state");
    expect(r.payload.plugged).toBe(true);
  });

  it("returns an empty payload for an empty or odd answer", () => {
    expect(mapVehicleData(undefined).payload).toEqual({});
    expect(mapVehicleData({ charge_state: "x" }).payload).toEqual({});
  });
});

describe("chargingStateOf", () => {
  it.each([
    ["Disconnected", false, "unplugged"],
    ["Charging", false, "charging"],
    ["Starting", false, "charging"],
    ["Complete", false, "completed"],
    ["Stopped", true, "scheduled"],
    ["Stopped", false, "idle"],
    ["NoPower", false, "waiting"],
    ["Whatever", false, null],
  ])("%s (scheduled %s) → %s", (state, scheduled, expected) => {
    expect(chargingStateOf(state, scheduled)).toBe(expected);
  });
});

describe("chargePowerW", () => {
  it("prefers current × voltage over the integer kW", () => {
    expect(
      chargePowerW({ charger_power: 3, charger_actual_current: 13, charger_voltage: 224 }),
    ).toBe(2912);
  });
  it("multiplies by the phases on a three-phase charge", () => {
    expect(
      chargePowerW({ charger_actual_current: 16, charger_voltage: 230, charger_phases: 3 }),
    ).toBe(11040);
  });
  it("reads 0 when idle (residual voltage)", () => {
    expect(chargePowerW({ charger_actual_current: 0, charger_voltage: 2 })).toBe(0);
  });
  it("falls back to charger_power in kW", () => {
    expect(chargePowerW({ charger_power: 7 })).toBe(7000);
  });
  it("is undefined with nothing to go on", () => {
    expect(chargePowerW({})).toBeUndefined();
  });
});

describe("helpers", () => {
  it("converts miles", () => {
    expect(milesToKm(197.17)).toBe(317);
    expect(milesToKm(30920.908994, 1)).toBe(49762.4);
  });
  it("never exposes the full VIN in the source id", () => {
    expect(sourceIdOf("LRWTESTVIN0001234")).toBe("Tesla 1234");
  });
});
