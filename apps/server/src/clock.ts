/** Time source. Real in production, controlled in replay tests. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class ManualClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export const iso = (ms: number) => new Date(ms).toISOString();
