import { getClientIp } from "./client-ip";

export type RateLimitDecision = {
  allowed: boolean;
  retryAfterMs: number;
};

type Bucket = {
  timestamps: number[];
};

const buckets = new Map<string, Bucket>();
let lastSweepAt = 0;
const sweepIntervalMs = 5 * 60 * 1000;
const staleBucketAfterMs = 60 * 60 * 1000;

/**
 * In-process sliding-window rate limiter. Sufficient for a single-replica MVP.
 * Multi-replica deployments must replace this with a shared store (e.g. Redis).
 */
export function checkRateLimit(key: string, limit: number, windowMs: number, now: number = Date.now()): RateLimitDecision {
  const windowStart = now - windowMs;
  const bucket = buckets.get(key);

  if (bucket) {
    const fresh = bucket.timestamps.filter((timestamp) => timestamp > windowStart);
    if (fresh.length >= limit) {
      const oldest = fresh[0];
      return { allowed: false, retryAfterMs: Math.max(1, oldest + windowMs - now) };
    }
    fresh.push(now);
    bucket.timestamps = fresh;
  } else {
    buckets.set(key, { timestamps: [now] });
  }

  maybeSweep(now);
  return { allowed: true, retryAfterMs: 0 };
}

/**
 * Resolve limit/window from env (with fallback) and decide for a Request.
 * Returns the 429 decision so callers can attach `Retry-After`.
 */
export function enforceRateLimit(
  request: Request,
  envLimit: string | undefined,
  envWindowMs: string | undefined,
  defaultLimit: number,
  defaultWindowMs: number,
  options: { now?: number; scope?: string } = {},
): RateLimitDecision {
  const now = options.now ?? Date.now();
  const limit = positiveInt(envLimit, defaultLimit);
  const windowMs = positiveInt(envWindowMs, defaultWindowMs);
  const key = `${options.scope ?? "default"}:ip:${getClientIp(request) || "unknown"}`;
  return checkRateLimit(key, limit, windowMs, now);
}

/** Test-only: clear all buckets between cases. */
export function resetRateLimitsForTest() {
  buckets.clear();
  lastSweepAt = 0;
}

function maybeSweep(now: number) {
  if (now - lastSweepAt < sweepIntervalMs) return;
  lastSweepAt = now;
  const cutoff = now - staleBucketAfterMs;
  for (const [key, bucket] of buckets) {
    const last = bucket.timestamps[bucket.timestamps.length - 1];
    if (last === undefined || last < cutoff) {
      buckets.delete(key);
    }
  }
}

function positiveInt(envValue: string | undefined, fallback: number): number {
  const value = Number(envValue);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
