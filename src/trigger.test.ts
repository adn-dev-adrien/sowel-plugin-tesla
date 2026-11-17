import { describe, expect, it } from "vitest";
import { ChargeTrigger, DURING_MS, nextDaily, SETTLE_MS, type Timers } from "./trigger.js";

/** A manual clock: `advance` runs every timer due, in order. */
function fakeTimers() {
  let t = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    now: () => t,
    set(ms, fn) {
      const id = seq++;
      pending.set(id, { at: t + ms, fn });
      return () => void pending.delete(id);
    },
  };
  function advance(ms: number) {
    const end = t + ms;
    for (;;) {
      const next = [...pending.entries()]
        .filter(([, p]) => p.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      pending.delete(next[0]);
      t = next[1].at;
      next[1].fn();
    }
    t = end;
  }
  return { timers, advance };
}

const MIN = 60_000;

function setup() {
  const reads: string[] = [];
  const clock = fakeTimers();
  const trigger = new ChargeTrigger((r) => reads.push(r), clock.timers);
  return { reads, clock, trigger };
}

describe("ChargeTrigger", () => {
  it("reads 2 min after the start, every 30 min, and 2 min after the end", () => {
    const { reads, clock, trigger } = setup();
    trigger.onPower(2980);
    clock.advance(SETTLE_MS - 1);
    expect(reads).toEqual([]);
    clock.advance(1);
    expect(reads).toEqual(["charge-start"]);
    // The clamp keeps reporting (every 10 min here); readings change nothing.
    for (let i = 0; i < 6; i++) {
      trigger.onPower(2990);
      clock.advance(10 * MIN);
    }
    expect(reads).toEqual(["charge-start", "charging", "charging"]);
    trigger.onPower(0);
    clock.advance(SETTLE_MS);
    expect(reads).toEqual(["charge-start", "charging", "charging", "charge-end"]);
    clock.advance(DURING_MS * 3);
    expect(reads).toHaveLength(4);
  });

  it("does not read on a spike shorter than the settle time", () => {
    const { reads, clock, trigger } = setup();
    trigger.onPower(900);
    clock.advance(MIN);
    trigger.onPower(3);
    clock.advance(SETTLE_MS * 3);
    expect(reads).toEqual([]);
  });

  it("keeps a pause shorter than 2 min inside the charge", () => {
    const { reads, clock, trigger } = setup();
    trigger.onPower(3000);
    clock.advance(SETTLE_MS);
    trigger.onPower(100);
    clock.advance(MIN);
    trigger.onPower(3000);
    clock.advance(SETTLE_MS * 2);
    expect(reads).toEqual(["charge-start"]);
  });

  it("skips a start read within 30 min of another charge read, and then its end", () => {
    const { reads, clock, trigger } = setup();
    trigger.onPower(3000);
    clock.advance(SETTLE_MS);
    trigger.onPower(0);
    clock.advance(SETTLE_MS);
    expect(reads).toEqual(["charge-start", "charge-end"]);
    // A new charge 10 min later: start skipped, and no end read for it.
    clock.advance(10 * MIN);
    trigger.onPower(3000);
    clock.advance(SETTLE_MS);
    trigger.onPower(0);
    clock.advance(SETTLE_MS);
    expect(reads).toEqual(["charge-start", "charge-end"]);
  });

  it("bounds a power flapping around 500 W to one start and one end per 30 min", () => {
    const { reads, clock, trigger } = setup();
    for (let i = 0; i < 12; i++) {
      trigger.onPower(3000);
      clock.advance(3 * MIN);
      trigger.onPower(200);
      clock.advance(3 * MIN);
    }
    // 72 min of flapping: cycles at 0 and ~36 min are read, the rest are not.
    expect(reads.filter((r) => r === "charge-end").length).toBeLessThanOrEqual(3);
    expect(reads.length).toBeLessThanOrEqual(6);
  });

  it("defers the start read when the power dips during the first 2 min", () => {
    const { reads, clock, trigger } = setup();
    trigger.onPower(7000);
    clock.advance(90_000);
    trigger.onPower(300); // dip
    clock.advance(30_000); // the start settles while dipping
    trigger.onPower(7000); // back before the end
    clock.advance(SETTLE_MS);
    expect(reads).toEqual(["charge-start"]);
    clock.advance(DURING_MS);
    expect(reads).toEqual(["charge-start", "charging"]);
  });

  it("ends a charge whose charger went silent, with an end read, and stops reading", () => {
    const { reads, clock, trigger } = setup();
    trigger.onPower(3000);
    clock.advance(SETTLE_MS);
    // no reading any more
    clock.advance(DURING_MS * 6);
    expect(reads[0]).toBe("charge-start");
    expect(reads.at(-1)).toBe("charge-end");
    expect(reads.filter((r) => r === "charging").length).toBeLessThanOrEqual(1);
    expect(trigger.isCharging()).toBe(false);
    const n = reads.length;
    clock.advance(DURING_MS * 10);
    expect(reads.length).toBe(n);
  });

  it("ends a charge after 24 h even when the power keeps reporting", () => {
    const { reads, clock, trigger } = setup();
    trigger.onPower(3000);
    for (let i = 0; i < 26 * 6; i++) {
      clock.advance(10 * MIN);
      trigger.onPower(3000 + (i % 2));
    }
    expect(reads.filter((r) => r === "charge-end").length).toBeGreaterThanOrEqual(1);
    expect(reads.filter((r) => r === "charging").length).toBeLessThanOrEqual(50);
  });

  it("ignores non-numeric readings and treats a reversed clamp as power", () => {
    const { reads, clock, trigger } = setup();
    trigger.onPower(null);
    trigger.onPower("n/a");
    clock.advance(SETTLE_MS);
    expect(reads).toEqual([]);
    trigger.onPower(-3000);
    clock.advance(SETTLE_MS);
    expect(reads).toEqual(["charge-start"]);
  });

  it("stop cancels everything", () => {
    const { reads, clock, trigger } = setup();
    trigger.onPower(3000);
    trigger.stop();
    clock.advance(DURING_MS * 2);
    expect(reads).toEqual([]);
    expect(trigger.isCharging()).toBe(false);
  });
});

describe("nextDaily", () => {
  it("picks 07:00, then 19:00, then tomorrow 07:00", () => {
    expect(nextDaily(new Date(2026, 10, 17, 3)).getHours()).toBe(7);
    expect(nextDaily(new Date(2026, 10, 17, 7)).getHours()).toBe(19);
    const late = nextDaily(new Date(2026, 10, 17, 20));
    expect([late.getDate(), late.getHours()]).toEqual([18, 7]);
  });
});
