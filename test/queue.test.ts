/** Rate-limiter / request queue tests (spec P5: never hammer the provider). */
import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../src/data/queue';
import { ProviderError } from '../src/data/provider';

/** Deterministic clock: sleep() advances virtual time instead of waiting. */
function virtualClock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += Math.max(0, ms);
    },
    sleeps,
  };
}

describe('RateLimiter', () => {
  it('spaces requests by minIntervalMs', async () => {
    const clock = virtualClock();
    const rl = new RateLimiter({ perMinute: 10, minIntervalMs: 500 }, clock.now, clock.sleep);
    const t0 = clock.now();
    await rl.acquire();
    expect(clock.now()).toBe(t0); // first request goes straight out
    await rl.acquire();
    expect(clock.now()).toBe(t0 + 500); // second waits for the spacing
    expect(clock.sleeps).toEqual([500]);
  });

  it('enforces the per-minute budget', async () => {
    const clock = virtualClock();
    const rl = new RateLimiter({ perMinute: 2, minIntervalMs: 0 }, clock.now, clock.sleep);
    await rl.acquire();
    await rl.acquire();
    await rl.acquire(); // 3rd in the same minute → waits for the window to roll
    expect(clock.sleeps.some((ms) => ms > 60_000 - 10)).toBe(true);
    expect(rl.status().usedThisMinute).toBeLessThanOrEqual(2);
  });

  it('rejects with a typed error when the daily budget is exhausted (X1)', async () => {
    const clock = virtualClock();
    const rl = new RateLimiter({ perMinute: 100, perDay: 2, minIntervalMs: 0 }, clock.now, clock.sleep);
    await rl.acquire();
    await rl.acquire();
    await expect(rl.acquire()).rejects.toBeInstanceOf(ProviderError);
    await expect(rl.acquire()).rejects.toMatchObject({ kind: 'rate_limit' });
    const err = await rl.acquire().catch((e: unknown) => e as ProviderError);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).hint).toMatch(/cached data remains available/);
  });

  it('pauses the whole queue after the provider says 429 (P5)', async () => {
    const clock = virtualClock();
    const rl = new RateLimiter({ perMinute: 100, minIntervalMs: 0 }, clock.now, clock.sleep);
    rl.reportRateLimit(30_000);
    expect(rl.status().blockedUntilMs).toBe(clock.now() + 30_000);
    await rl.acquire();
    expect(clock.sleeps).toContain(30_000); // waited out the penalty
    expect(rl.status().blockedUntilMs).toBeNull(); // no longer blocked after time passed
  });

  it('rejects when too many requests pile up', async () => {
    const clock = virtualClock();
    const rl = new RateLimiter({ perMinute: 100, minIntervalMs: 10_000 }, clock.now, clock.sleep);
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 60; i++) pending.push(rl.acquire());
    const results = await Promise.allSettled(pending);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    const err = (rejected[0] as PromiseRejectedResult).reason as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('rate_limit');
  });

  it('reports status and resets cleanly', async () => {
    const clock = virtualClock();
    const rl = new RateLimiter({ perMinute: 5, minIntervalMs: 100 }, clock.now, clock.sleep);
    await rl.acquire();
    expect(rl.status().usedThisMinute).toBe(1);
    expect(rl.status().queued).toBe(0);
    rl.reset();
    expect(rl.status().usedThisMinute).toBe(0);
    expect(rl.status().usedToday).toBe(0);
  });
});
