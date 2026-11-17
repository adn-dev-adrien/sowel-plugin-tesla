/**
 * Spec 001 FR8 — the monthly count of billed requests, persisted so a restart
 * does not reset it, and the cap that stops every request until the 1st.
 *
 * Tesla bills every answer under HTTP 500, whatever the endpoint, so the
 * caller records after each such answer, not after each success.
 */

export interface Store {
  get(): string | undefined;
  set(value: string): void;
}

interface Usage {
  month: string;
  count: number;
}

/** `2026-11` in local time: Tesla's billing cycle starts on the 1st. */
export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export class Budget {
  constructor(
    private readonly store: Store,
    private readonly cap: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private read(): Usage {
    const month = monthKey(this.now());
    try {
      const u = JSON.parse(this.store.get() ?? "") as Partial<Usage>;
      if (u.month === month && typeof u.count === "number" && u.count >= 0)
        return { month, count: u.count };
    } catch {
      // empty or corrupt: a new month
    }
    return { month, count: 0 };
  }

  used(): number {
    return this.read().count;
  }

  limit(): number {
    return this.cap;
  }

  canSpend(): boolean {
    return this.read().count < this.cap;
  }

  /** One billed request. Returns true when this one reached the cap. */
  record(): boolean {
    const u = this.read();
    u.count += 1;
    this.store.set(JSON.stringify(u));
    return u.count === this.cap;
  }
}
