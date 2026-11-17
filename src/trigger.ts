/**
 * Spec 001 FR5 — when to read the car, from the charger's power.
 *
 * - charge start: first reading of 500 W or more → a read 2 min later;
 * - during the charge: a read every 30 min;
 * - charge end: power under 500 W for 2 min → a read, if the charge was read
 *   at least once (a spike or a flapping power earns no end read).
 *
 * Guards (spec 001 review):
 * - a dip during the first 2 min defers the start read, it never cancels it;
 * - the start read is skipped when another CHARGE read happened less than
 *   30 min before (daily and refresh reads do not count: their data may be
 *   hours old or taken before a drive);
 * - a charger that stops reporting ends the charge after 45 min of silence,
 *   and no charge lasts more than 24 h: a lost clamp must never read forever.
 *
 * Timers are injected so the logic is tested without waiting.
 */

export const THRESHOLD_W = 500;
export const SETTLE_MS = 2 * 60_000;
export const DURING_MS = 30 * 60_000;
export const SILENCE_MS = 45 * 60_000;
export const MAX_CHARGE_MS = 24 * 3_600_000;

export type ReadReason = "charge-start" | "charging" | "charge-end";

export interface Timers {
  set(ms: number, fn: () => void): () => void;
  now(): number;
}

export const realTimers: Timers = {
  set(ms, fn) {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return () => clearTimeout(t);
  },
  now: () => Date.now(),
};

type Cancel = () => void;

export class ChargeTrigger {
  private charging = false;
  private chargeStartedAt = 0;
  /** A read was made during the charge in progress: its end deserves one too. */
  private readThisCharge = false;
  /** The start settled while the power was dipping: read once it is back. */
  private startDeferred = false;
  private startTimer: Cancel | null = null;
  private endTimer: Cancel | null = null;
  private periodicTimer: Cancel | null = null;
  private lastChargeReadAt: number | null = null;
  private lastPowerAt = 0;

  constructor(
    private readonly read: (reason: ReadReason) => void,
    private readonly timers: Timers = realTimers,
  ) {}

  isCharging(): boolean {
    return this.charging;
  }

  onPower(value: unknown): void {
    if (value === null || value === undefined || value === "") return;
    const w = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(w)) return;
    this.lastPowerAt = this.timers.now();
    const active = Math.abs(w) >= THRESHOLD_W;

    if (active) {
      if (this.endTimer) {
        // The power came back before the end: same charge.
        this.endTimer();
        this.endTimer = null;
        if (this.startDeferred) {
          this.startDeferred = false;
          this.startTimer = this.timers.set(SETTLE_MS, () => this.onStartSettled());
        }
        return;
      }
      if (this.charging) return;
      this.charging = true;
      this.chargeStartedAt = this.timers.now();
      this.readThisCharge = false;
      this.startDeferred = false;
      this.startTimer = this.timers.set(SETTLE_MS, () => this.onStartSettled());
      return;
    }

    if (this.charging && !this.endTimer)
      this.endTimer = this.timers.set(SETTLE_MS, () => this.end());
  }

  private onStartSettled(): void {
    this.startTimer = null;
    if (this.endTimer) {
      this.startDeferred = true;
      return;
    }
    const recent =
      this.lastChargeReadAt !== null && this.timers.now() - this.lastChargeReadAt < DURING_MS;
    if (!recent) this.fire("charge-start");
    this.schedulePeriodic();
  }

  /** Charge over: power low for 2 min, charger silent, or 24 h. */
  private end(): void {
    const readIt = this.readThisCharge;
    this.reset();
    if (readIt) this.fire("charge-end");
  }

  private schedulePeriodic(): void {
    this.periodicTimer?.();
    this.periodicTimer = this.timers.set(DURING_MS, () => {
      this.periodicTimer = null;
      if (!this.charging) return;
      const now = this.timers.now();
      if (now - this.lastPowerAt > SILENCE_MS || now - this.chargeStartedAt > MAX_CHARGE_MS) {
        this.endTimer?.();
        this.endTimer = null;
        this.end();
        return;
      }
      if (!this.endTimer) this.fire("charging");
      this.schedulePeriodic();
    });
  }

  private fire(reason: ReadReason): void {
    this.lastChargeReadAt = this.timers.now();
    if (reason !== "charge-end") this.readThisCharge = true;
    this.read(reason);
  }

  private reset(): void {
    for (const t of [this.startTimer, this.endTimer, this.periodicTimer]) t?.();
    this.startTimer = this.endTimer = this.periodicTimer = null;
    this.charging = false;
    this.readThisCharge = false;
    this.startDeferred = false;
  }

  stop(): void {
    this.reset();
  }
}

/** Next 07:00 or 19:00 local time strictly after `now` (FR6). */
export function nextDaily(now: Date, hours: readonly number[] = [7, 19]): Date {
  const candidates: Date[] = [];
  for (const dayOffset of [0, 1]) {
    for (const h of hours) {
      const d = new Date(now);
      d.setDate(d.getDate() + dayOffset);
      d.setHours(h, 0, 0, 0);
      if (d.getTime() > now.getTime()) candidates.push(d);
    }
  }
  return candidates.sort((a, b) => a.getTime() - b.getTime())[0];
}
