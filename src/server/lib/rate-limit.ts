import "server-only";
import Redis from "ioredis";

import { env } from "@/env";

/**
 * Rate limiting with shared state. When REDIS_URL is set the counters live
 * in Redis — atomic across every app instance, survive restarts, and expire
 * themselves — so the limits hold no matter how many Node processes serve
 * traffic. Without it (local dev) a per-process fixed window stands in.
 */
export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  retryAfterMs: number;
};

// INCR + window expiry must be one atomic step: if the process died between
// the two, a key with no TTL would rate-limit that client forever.
const WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

let redis: Redis | null = null;
let redisHealthy = false;

function getRedis(): Redis | null {
  if (!env.REDIS_URL) return null;
  if (!redis) {
    redis = new Redis(env.REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    redis.on("ready", () => {
      redisHealthy = true;
    });
    redis.on("error", (error) => {
      if (redisHealthy) console.error("redis rate limiter:", error.message);
      redisHealthy = false;
    });
  }
  return redis;
}

async function redisLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult | null> {
  const client = getRedis();
  if (!client || !redisHealthy) return null;
  try {
    const [count, ttl] = (await client.eval(
      WINDOW_SCRIPT,
      1,
      `helm:rl:${key}`,
      windowMs,
    )) as [number, number];
    return {
      ok: count <= limit,
      remaining: Math.max(0, limit - count),
      retryAfterMs: count <= limit ? 0 : Math.max(ttl, 0),
    };
  } catch {
    return null; // fall through to the in-process window
  }
}

// ---- in-process fallback (single instance / Redis unavailable) ------------

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
let lastPrune = 0;

function prune(now: number) {
  if (now - lastPrune < 60_000) return;
  lastPrune = now;
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}

function memoryLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  prune(now);

  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterMs: 0 };
  }
  if (bucket.count >= limit) {
    return { ok: false, remaining: 0, retryAfterMs: bucket.resetAt - now };
  }
  bucket.count += 1;
  return { ok: true, remaining: limit - bucket.count, retryAfterMs: 0 };
}

export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const shared = await redisLimit(key, limit, windowMs);
  return shared ?? memoryLimit(key, limit, windowMs);
}

/**
 * Best-effort client IP from proxy headers, falling back to a local key.
 *
 * Trust only the LAST x-forwarded-for entry — the hop our own reverse proxy
 * appended. The first entry is whatever the client sent and is trivially
 * spoofable; taking it would let an attacker forge a fresh key per request and
 * skip the limit. (Our nginx vhost overwrites XFF with $remote_addr, so in
 * practice there's a single trustworthy value; last-hop is correct either way.)
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1]!;
  }
  return headers.get("x-real-ip") ?? "local";
}
