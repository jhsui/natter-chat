/**
 * Rate limits for signing in, signing up and sending messages. The counts
 * live in memory: they reset when the server restarts, and two server
 * instances would each keep their own.
 */

export interface RateLimitOptions {
  /** Sign-in attempts from one IP per `loginWindowMs`. Default: 30. */
  loginPerIp?: number;
  /**
   * Failed sign-ins for one username from one IP per `loginWindowMs`.
   * Default: 10.
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
  /** When each key's recent attempts happened, oldest first. */
  const attempts = new Map<string, number[]>();

  /** The attempts for `key` inside the window; forgets the key if none are. */
  function recent(key: string): number[] {
    const cutoff = now() - windowMs;
    const times = (attempts.get(key) ?? []).filter((t) => t > cutoff);
    if (times.length > 0) attempts.set(key, times);
    else attempts.delete(key);
    return times;
  }

  function result(times: number[]): RateLimitResult {
    if (times.length < limit) return { ok: true };
    // Refused attempts aren't counted, so there are never more than `limit`
    // and the oldest one is the next to leave the window.
    const oldest = times[0] ?? now();
    return { ok: false, retryAfterMs: oldest + windowMs - now() };
  }

  // Clear out keys nobody has used for a while, so memory stays bounded.
  const timer = setInterval(() => {
    for (const key of attempts.keys()) recent(key);
  }, windowMs);
  timer.unref(); // don't keep the process alive just for this

  return {
    hit(key) {
      const times = recent(key);
      const answer = result(times);
      if (answer.ok) attempts.set(key, [...times, now()]);
      return answer;
    },
    check: (key) => result(recent(key)),
    reset(key) {
      attempts.delete(key);
    },
    stop: () => clearInterval(timer),
  };
}

/** The limiters the routes and socket handlers use. */
export interface RateLimits {
  /** Every sign-in attempt, by IP. */
  loginIp: RateLimiter;
  /** Failed sign-ins, by IP and lowercased username. */
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
