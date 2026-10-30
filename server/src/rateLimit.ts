/**
 * Rate limits for signing in, signing up and sending messages. The counts
 * live in memory: they reset when the server restarts, and two server
 * instances would each keep their own.
 */

import { isIPv6 } from "node:net";
import type { Response } from "express";
import type { ErrorResponse } from "../../shared/types.js";

export interface RateLimitOptions {
  /** Sign-in attempts from one IP per `loginWindowMs`. Default: 30. */
  loginPerIp?: number;
  /**
   * Sign-in tries for one username from one IP per `loginWindowMs`; a
   * successful one clears the count. Default: 10.
   */
  loginFailuresPerName?: number;
  /** Default: 15 minutes. */
  loginWindowMs?: number;
  /** Sign-up attempts from one IP per `registerWindowMs`. Default: 10. */
  registerPerIp?: number;
  /** Default: an hour. */
  registerWindowMs?: number;
  /**
   * Messages (text and pictures together) one user can send per
   * `messageWindowMs`. Default: 20.
   */
  messagesPerUser?: number;
  /** Default: 10 seconds. */
  messageWindowMs?: number;
  /** The clock (tests move it forward instead of waiting). */
  now?: () => number;
}

const MINUTE_MS = 60 * 1000;

export function rateLimitSettings(options: RateLimitOptions = {}) {
  return {
    loginPerIp: options.loginPerIp ?? 30,
    loginFailuresPerName: options.loginFailuresPerName ?? 10,
    loginWindowMs: options.loginWindowMs ?? 15 * MINUTE_MS,
    registerPerIp: options.registerPerIp ?? 10,
    registerWindowMs: options.registerWindowMs ?? 60 * MINUTE_MS,
    messagesPerUser: options.messagesPerUser ?? 20,
    messageWindowMs: options.messageWindowMs ?? 10 * 1000,
    now: options.now ?? Date.now,
  };
}
type RateLimitSettings = ReturnType<typeof rateLimitSettings>;

export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterMs: number };

export interface RateLimiter {
  /**
   * Counts an attempt for `key`, unless it's already over the limit (then
   * nothing is counted).
   */
  hit(key: string): RateLimitResult;
  /** Says whether `key` is over the limit, without counting anything. */
  check(key: string): RateLimitResult;
  /** Forgets every attempt for `key`. */
  reset(key: string): void;
  stop(): void;
}

/** Allows `limit` attempts per key in any `windowMs`-long stretch of time. */
export function createRateLimiter({
  limit,
  windowMs,
  now = Date.now,
}: {
  limit: number;
  windowMs: number;
  now?: () => number;
}): RateLimiter {
  if (!Number.isInteger(limit) || limit < 0)
    throw new RangeError(`Invalid rate limit: ${limit}`);
  if (!Number.isFinite(windowMs) || windowMs <= 0)
    throw new RangeError(`Invalid rate limit window: ${windowMs}`);

  /** When each key's recent attempts happened, oldest first. */
  const attempts = new Map<string, number[]>();

  /** The attempts for `key` in the window up to `time`; forgets it if none. */
  function recent(key: string, time: number): number[] {
    const cutoff = time - windowMs;
    const times = (attempts.get(key) ?? []).filter((t) => t > cutoff);
    if (times.length > 0) attempts.set(key, times);
    else attempts.delete(key);
    return times;
  }

  function result(times: number[], time: number): RateLimitResult {
    if (times.length < limit) return { ok: true };
    // Refused attempts aren't counted, so there are never more than `limit`
    // and the oldest one is the next to leave the window.
    const oldest = times[0] ?? time;
    return { ok: false, retryAfterMs: oldest + windowMs - time };
  }

  // Clear out keys nobody has used for a while, so memory stays bounded.
  const timer = setInterval(
    () => {
      const time = now();
      for (const key of attempts.keys()) recent(key, time);
    },
    Math.max(windowMs, 1000),
  );
  timer.unref(); // don't keep the process alive just for this

  return {
    hit(key) {
      // One reading of the clock, so the wait can't come out as zero.
      const time = now();
      const times = recent(key, time);
      const answer = result(times, time);
      if (answer.ok) attempts.set(key, [...times, time]);
      return answer;
    },
    check(key) {
      const time = now();
      return result(recent(key, time), time);
    },
    reset(key) {
      attempts.delete(key);
    },
    stop: () => clearInterval(timer),
  };
}

/** Whole seconds to wait, at least 1, as sent in `retryAfterSeconds`. */
export function retryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

/**
 * If `result` is over the limit, replies 429 with how long to wait (as
 * `retryAfterSeconds` and a Retry-After header) and returns true.
 * `what` names the attempts, e.g. "sign-in attempts".
 */
export function refuseIfLimited<T>(
  res: Response<T | ErrorResponse>,
  result: RateLimitResult,
  what: string,
): boolean {
  if (result.ok) return false;
  const seconds = retryAfterSeconds(result.retryAfterMs);
  res.set("Retry-After", String(seconds));
  res.status(429).json({
    error: `Too many ${what}. Try again in ${seconds} seconds.`,
    retryAfterSeconds: seconds,
  });
  return true;
}

/**
 * The key an IP address is limited under. IPv6 addresses are grouped by their
 * first 64 bits, since one machine usually has a whole /64 to pick from.
 */
export function ipKey(ip: string | undefined): string {
  if (!ip) return "unknown";
  const address = ip.split("%")[0] ?? ip; // drop a zone, as in fe80::1%eth0
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) return mapped[1]; // IPv4 written as IPv6
  if (!isIPv6(address)) return address;

  // Write out the groups that "::" leaves out. An IPv4 part at the end (as in
  // 64:ff9b::1.2.3.4) stands for two groups.
  const groupsOf = (part: string) =>
    part === ""
      ? []
      : part.split(":").flatMap((g) => (g.includes(".") ? ["0", "0"] : [g]));
  const [head = "", tail = ""] = address.split("::");
  const left = groupsOf(head);
  const right = groupsOf(tail);
  const groups = [
    ...left,
    ...Array<string>(8 - left.length - right.length).fill("0"),
    ...right,
  ];
  const prefix = groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(":");
  return `${prefix}::/64`;
}

/** The limiters the routes and socket handlers use. */
export interface RateLimits {
  /** Every sign-in attempt, by IP. */
  loginIp: RateLimiter;
  /** Sign-ins, by IP and lowercased username; a successful one clears it. */
  loginName: RateLimiter;
  /** Every sign-up attempt, by IP. */
  register: RateLimiter;
  /** Messages sent, by user id: all tabs and picture uploads share one budget. */
  messages: RateLimiter;
  stop(): void;
}

export function createRateLimits(settings: RateLimitSettings): RateLimits {
  const { now } = settings;
  const limits = {
    loginIp: createRateLimiter({
      limit: settings.loginPerIp,
      windowMs: settings.loginWindowMs,
      now,
    }),
    loginName: createRateLimiter({
      limit: settings.loginFailuresPerName,
      windowMs: settings.loginWindowMs,
      now,
    }),
    register: createRateLimiter({
      limit: settings.registerPerIp,
      windowMs: settings.registerWindowMs,
      now,
    }),
    messages: createRateLimiter({
      limit: settings.messagesPerUser,
      windowMs: settings.messageWindowMs,
      now,
    }),
  };
  return {
    ...limits,
    stop() {
      for (const limiter of Object.values(limits)) limiter.stop();
    },
  };
}
