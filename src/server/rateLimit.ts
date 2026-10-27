import { HttpError } from './errors.js';

/**
 * Fixed-window, in-memory rate limiter. Enough to blunt password guessing and
 * sign-up spam on a single instance; a multi-instance deployment would move
 * this to Redis or the database.
 */
export class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  /** Counts a hit and throws 429 once `limit` hits happen within `windowMs`. */
  hit(key: string, limit: number, windowMs: number) {
    const now = Date.now();
    if (this.windows.size > 10_000) this.prune(now);

    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, w);
    }
    w.count++;
    if (w.count > limit) {
      const retryAfter = Math.ceil((w.resetAt - now) / 1000);
      const wait = retryAfter > 90 ? `${Math.ceil(retryAfter / 60)} minutes` : `${retryAfter} seconds`;
      throw new HttpError(429, 'rate_limited', `Too many attempts. Please try again in ${wait}.`, { retryAfter });
    }
  }

  /** Forget a key, e.g. after a successful sign-in. */
  reset(key: string) {
    this.windows.delete(key);
  }

  private prune(now: number) {
    for (const [key, w] of this.windows) if (w.resetAt <= now) this.windows.delete(key);
  }
}
