export class RateLimiter {
  private next = 0;
  constructor(private readonly rps: number) {}

  async wait(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.next);
    this.next = slot + 1000 / this.rps;
    if (slot > now) await Bun.sleep(slot - now);
  }

  pause(ms: number): void {
    this.next = Math.max(this.next, Date.now() + ms);
  }
}
