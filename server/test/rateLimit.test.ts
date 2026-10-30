import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRateLimiter,
  ipKey,
  rateLimitSettings,
  retryAfterSeconds,
} from "../src/rateLimit.js";

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

test("refuses a limit or window that isn't a sensible number", () => {
  for (const [limit, windowMs] of [
    [-1, 1000],
    [1.5, 1000],
    [1, 0],
    [1, Number.NaN],
  ] as const) {
    assert.throws(() => createRateLimiter({ limit, windowMs }), RangeError);
  }
});

test("the wait is in whole seconds, and never zero", () => {
  assert.equal(retryAfterSeconds(0), 1);
  assert.equal(retryAfterSeconds(1), 1);
  assert.equal(retryAfterSeconds(1000), 1);
  assert.equal(retryAfterSeconds(1001), 2);
  assert.equal(retryAfterSeconds(15 * 60 * 1000), 900);
});

test("IP keys: IPv4 as is, IPv6 grouped by its first 64 bits", () => {
  assert.equal(ipKey(undefined), "unknown");
  assert.equal(ipKey("203.0.113.5"), "203.0.113.5");
  assert.equal(ipKey("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(ipKey("::FFFF:203.0.113.5"), "203.0.113.5");
  // However an address in the same /64 is written, it has the same key.
  assert.equal(ipKey("2001:db8:1:2::1"), "2001:db8:1:2::/64");
  assert.equal(ipKey("2001:0DB8:0001:0002:ffff:0:0:9"), "2001:db8:1:2::/64");
  assert.equal(ipKey("2001:db8:1:3::1"), "2001:db8:1:3::/64");
  assert.equal(
    ipKey("2001:db8:aaaa:bbbb:cccc:dddd:eeee:ffff"),
    "2001:db8:aaaa:bbbb::/64",
  );
  assert.equal(ipKey("2001:db8::"), "2001:db8:0:0::/64");
  assert.equal(ipKey("::1"), "0:0:0:0::/64");
  assert.equal(ipKey("fe80::1%eth0"), "fe80:0:0:0::/64");
  assert.equal(ipKey("64:ff9b::1.2.3.4"), "64:ff9b:0:0::/64");
});
