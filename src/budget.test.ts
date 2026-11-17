import { describe, expect, it } from "vitest";
import { Budget, monthKey } from "./budget.js";

function store(initial?: string) {
  let v = initial;
  return { get: () => v, set: (x: string) => void (v = x), peek: () => v };
}

describe("Budget", () => {
  it("counts, persists and stops at the cap", () => {
    const s = store();
    const now = () => new Date(2026, 10, 17, 12);
    const b = new Budget(s, 3, now);
    expect(b.canSpend()).toBe(true);
    expect(b.record()).toBe(false);
    expect(b.record()).toBe(false);
    expect(b.record()).toBe(true); // this one reached the cap
    expect(b.canSpend()).toBe(false);
    // A restart reads the persisted count.
    expect(new Budget(s, 3, now).used()).toBe(3);
  });

  it("starts again on the 1st of the month", () => {
    const s = store(JSON.stringify({ month: "2026-11", count: 1500 }));
    expect(new Budget(s, 1500, () => new Date(2026, 10, 30, 23)).canSpend()).toBe(false);
    expect(new Budget(s, 1500, () => new Date(2026, 11, 1, 0, 1)).canSpend()).toBe(true);
  });

  it("treats a corrupt store as an empty month", () => {
    expect(new Budget(store("{oops"), 10, () => new Date(2026, 0, 5)).used()).toBe(0);
  });

  it("keys months in local time", () => {
    expect(monthKey(new Date(2026, 0, 1, 0, 30))).toBe("2026-01");
  });
});
