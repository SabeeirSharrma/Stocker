/**
 * Client-side rate limiter / request queue (spec P5).
 *
 * Each adapter declares its limits; every network call passes through
 * `acquire()`, which spaces requests out and enforces per-minute and per-day
 * budgets. When the provider answers 429/402 we `reportRateLimit()` so the
 * queue pauses instead of hammering the API — and the UI surfaces a clear
 * message (never silent, P5/X1).
 */

import { ProviderError } from './provider';
import type { RateLimits } from './provider';

export interface LimiterStatus {
  queued: number;
  blockedUntilMs: number | null;
  usedThisMinute: number;
  usedToday: number;
}

export class RateLimiter {
  private queue: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  private running = false;
  private nextSlotMs = 0;
  private minuteStamps: number[] = [];
  private dayStamps: number[] = [];
  private blockedUntilMs = 0;
  constructor(
    private limits: RateLimits,
    private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Wait until a slot is available for a request. Rejects when the daily budget is exhausted. */
  async acquire(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.queue.length >= 50) {
        reject(new ProviderError('rate_limit', 'Too many queued requests', 'Slow down or wait for current requests to finish.'));
        return;
      }
      this.queue.push({ resolve, reject });
      void this.pump();
    });
  }

  private failAll(err: ProviderError): void {
    const pending = this.queue;
    this.queue = [];
    for (const item of pending) item.reject(err);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        try {
          const now0 = this.now();
          if (this.blockedUntilMs > now0) {
            await this.sleep(this.blockedUntilMs - now0);
          }
          const t = this.now();
          // minute budget
          this.minuteStamps = this.minuteStamps.filter((x) => t - x < 60_000);
          if (this.minuteStamps.length >= this.limits.perMinute) {
            await this.sleep(Math.max(10, 60_000 - (t - this.minuteStamps[0])));
            continue;
          }
          // day budget
          if (this.limits.perDay != null) {
            const dayStart = this.now() - 86_400_000;
            this.dayStamps = this.dayStamps.filter((x) => x > dayStart);
            if (this.dayStamps.length >= this.limits.perDay) {
              this.failAll(
                new ProviderError('rate_limit', 'Daily request budget exhausted for this API key', 'Resets within 24 hours; cached data remains available.'),
              );
              return;
            }
          }
          // spacing between requests
          const nowMs = this.now();
          const wait = this.nextSlotMs - nowMs;
          if (wait > 0) await this.sleep(wait);
          const stamp = this.now();
          this.nextSlotMs = stamp + this.limits.minIntervalMs;
          this.minuteStamps.push(stamp);
          this.dayStamps.push(stamp);
        } catch (e) {
          const item = this.queue.shift();
          item?.reject(e);
          continue;
        }
        const item = this.queue.shift();
        item?.resolve();
      }
    } finally {
      this.running = false;
    }
  }

  /** Provider said slow down (429). Pause the whole queue for `ms`. */
  reportRateLimit(ms: number): void {
    this.blockedUntilMs = Math.max(this.blockedUntilMs, this.now() + Math.max(ms, 1_000));
  }

  status(): LimiterStatus {
    const t = this.now();
    return {
      queued: this.queue.length,
      blockedUntilMs: this.blockedUntilMs > t ? this.blockedUntilMs : null,
      usedThisMinute: this.minuteStamps.filter((x) => t - x < 60_000).length,
      usedToday: this.dayStamps.filter((x) => x > t - 86_400_000).length,
    };
  }

  /** Test helper: reset internal state. */
  reset(): void {
    this.queue = [];
    this.nextSlotMs = 0;
    this.minuteStamps = [];
    this.dayStamps = [];
    this.blockedUntilMs = 0;
  }
}
