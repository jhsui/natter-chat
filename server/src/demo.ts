import { randomBytes, randomInt } from "node:crypto";
import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import type { DemoResponse, ErrorResponse } from "../../shared/types.js";
import { setAuthCookie } from "./auth.js";
import type { Bot, BotTiming } from "./bot.js";
import { toPublicUser, type Db } from "./db.js";
import type { AvatarStorage, ChatImageStorage } from "./storage.js";

/**
 * "Try the demo": one click makes a temporary guest account, signs it in, and
 * starts a chat with Natter Bot. Guests are hidden from everyone else's People
 * list and search, and deleted with their messages after a day.
 */

export interface DemoOptions {
  /** How long a guest account lasts. Default: a day. */
  guestTtlMs?: number;
  /** How often expired guests are cleared out. Default: hourly. */
  cleanupEveryMs?: number;
  /** The most guest accounts that can exist at once. Default: 500. */
  maxGuests?: number;
  /**
   * The most new guests per `windowMs` (default: 60 per 10 minutes), so a
   * script can't create thousands of accounts.
   */
  maxNewPerWindow?: number;
  windowMs?: number;
  /** How quickly Natter Bot answers (tests make it instant). */
  botTiming?: Partial<BotTiming>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function demoSettings(options: DemoOptions = {}) {
  return {
    guestTtlMs: options.guestTtlMs ?? DAY_MS,
    cleanupEveryMs: options.cleanupEveryMs ?? 60 * 60 * 1000,
    maxGuests: options.maxGuests ?? 500,
    maxNewPerWindow: options.maxNewPerWindow ?? 60,
    windowMs: options.windowMs ?? 10 * 60 * 1000,
  };
}
type DemoSettings = ReturnType<typeof demoSettings>;

type DemoReply = DemoResponse | ErrorResponse;

/** POST /api/auth/demo. With `bot` null (demo turned off) it replies 404. */
export function demoRoutes(
  db: Db,
  bot: Bot | null,
  settings: DemoSettings,
): Router {
  const router = Router();
  /** When the recent guests were created, for the per-window limit. */
  let recent: number[] = [];

  router.post("/demo", async (_req: Request, res: Response<DemoReply>) => {
    if (!bot) {
      res
        .status(404)
        .json({ error: "The demo isn't turned on for this server" });
      return;
    }
    const now = Date.now();
    recent = recent.filter((t) => now - t < settings.windowMs);
    if (
      recent.length >= settings.maxNewPerWindow ||
      (await db.countGuests()) >= settings.maxGuests
    ) {
      res.status(503).json({
        error: "The demo is busy right now. Please try again in a few minutes.",
      });
      return;
    }
    recent.push(now);

    // A password nobody knows: guests stay signed in with their cookie only.
    const hash = await bcrypt.hash(randomBytes(32).toString("hex"), 10);
    let user = null;
    for (let attempt = 0; attempt < 5 && !user; attempt++) {
      const number = randomInt(1000, 10000);
      user = await db.createUser(`guest_${number}`, hash, {
        guest: true,
        displayName: `Guest ${number}`,
      });
    }
    if (!user) {
      res.status(503).json({
        error: "The demo is busy right now. Please try again in a few minutes.",
      });
      return;
    }

    // Signed in for exactly as long as the account lasts.
    setAuthCookie(res, user, Math.floor(settings.guestTtlMs / 1000));
    await bot.welcome(user.id);
    res
      .status(201)
      .json({ user: toPublicUser(user), guest: true, bot: bot.user });
  });

  return router;
}

/**
 * Deletes expired guests now and then, along with their files in storage.
 * Returns `run` (which also says how many were deleted) and `stop`.
 */
export function startGuestCleanup(
  db: Db,
  {
    avatarStorage,
    chatImageStorage,
  }: {
    avatarStorage: AvatarStorage | null;
    chatImageStorage: ChatImageStorage | null;
  },
  settings: DemoSettings,
) {
  async function run(): Promise<number> {
    const { count, avatarKeys, imageKeys } = await db.deleteExpiredGuests(
      settings.guestTtlMs,
    );
    // A file that can't be removed right now shouldn't stop the rest.
    const removals = [
      ...avatarKeys.map((key) => avatarStorage?.remove(key)),
      ...imageKeys.map((key) => chatImageStorage?.remove(key)),
    ];
    for (const result of await Promise.allSettled(removals)) {
      if (result.status === "rejected")
        console.error("Couldn't delete a guest's file", result.reason);
    }
    return count;
  }

  const logErrors = (err: unknown) =>
    console.error("Couldn't clear out expired guests", err);
  void run().catch(logErrors);
  const timer = setInterval(
    () => void run().catch(logErrors),
    settings.cleanupEveryMs,
  );
  timer.unref(); // don't keep the process alive just for this

  return { run, stop: () => clearInterval(timer) };
}
