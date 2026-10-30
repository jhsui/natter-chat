import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter, rateLimitSettings } from "../src/rateLimit.js";

/** A clock the tests move by hand. */
function fakeClock(start = 1_000_000) {
  let time = start;
  return {
    now: () => time,
    advance(ms: number) {
      time += ms;
    },
  };
}

test("allows `limit` attempts per window, then refuses with the wait", () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({
    limit: 3,
    windowMs: 1000,
    now: clock.now,
  });
  try {
    assert.deepEqual(limiter.hit("a"), { ok: true });
    clock.advance(100);
    assert.deepEqual(limiter.hit("a"), { ok: true });
    assert.deepEqual(limiter.hit("a"), { ok: true });
    // The first attempt leaves the window 900 ms from now.
    assert.deepEqual(limiter.hit("a"), { ok: false, retryAfterMs: 900 });
    assert.deepEqual(limiter.check("a"), { ok: false, retryAfterMs: 900 });

    // Other keys have budgets of their own.
    assert.deepEqual(limiter.hit("b"), { ok: true });

    // Once the first attempt is out of the window, there's room for one more.
    clock.advance(900);
    assert.deepEqual(limiter.hit("a"), { ok: true });
    assert.equal(limiter.hit("a").ok, false);
  } finally {
    limiter.stop();
  }
});

test("refused attempts don't push the wait further out", () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({
    limit: 1,
    windowMs: 1000,
    now: clock.now,
  });
  try {
    limiter.hit("a");
    for (let i = 0; i < 5; i++) {
      clock.advance(100);
      assert.equal(limiter.hit("a").ok, false);
    }
    clock.advance(500); // 1000 ms after the only counted attempt
    assert.deepEqual(limiter.hit("a"), { ok: true });
  } finally {
    limiter.stop();
  }
});

test("check doesn't count, and reset forgets a key", () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({
    limit: 2,
    windowMs: 1000,
    now: clock.now,
  });
  try {
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(limiter.check("a"), { ok: true });
    }
    limiter.hit("a");
    limiter.hit("a");
    assert.equal(limiter.check("a").ok, false);
    limiter.reset("a");
    assert.deepEqual(limiter.hit("a"), { ok: true });
  } finally {
    limiter.stop();
  }
});

test("the defaults match the spec", () => {
  const { now, ...settings } = rateLimitSettings();
  assert.equal(typeof now, "function");
  assert.deepEqual(settings, {
    loginPerIp: 30,
    loginFailuresPerName: 10,
    loginWindowMs: 15 * 60 * 1000,
    registerPerIp: 10,
    registerWindowMs: 60 * 60 * 1000,
    messagesPerUser: 20,
    messageWindowMs: 10 * 1000,
  });
});
