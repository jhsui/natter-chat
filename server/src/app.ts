import express, { type ErrorRequestHandler } from "express";
import cookieParser from "cookie-parser";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { requireAuth } from "./auth.js";
import { createBot, type Bot } from "./bot.js";
import { openDb, type Db, type DbConfig } from "./db.js";
import {
  demoRoutes,
  demoSettings,
  startGuestCleanup,
  type DemoOptions,
} from "./demo.js";
import { fetchLinkPreview, type LinkPreviewFetcher } from "./linkPreview.js";
import { createPresence } from "./presence.js";
import {
  createRateLimits,
  rateLimitSettings,
  type RateLimitOptions,
} from "./rateLimit.js";
import { attachSocket, emitNewMessage, type ChatServer } from "./socket.js";
import { authRoutes } from "./routes/auth.js";
import { chatRoutes } from "./routes/chat.js";
import { MAX_AVATAR_BYTES, profileRoutes } from "./routes/profile.js";
import {
  chatImageStorageFromEnv,
  storageFromEnv,
  type AvatarStorage,
  type ChatImageStorage,
} from "./storage.js";

export interface ServerOptions {
  db: DbConfig;
  /** Where avatars go. Defaults to Supabase from env vars (null if not configured). */
  avatarStorage?: AvatarStorage | null;
  /** Where pictures sent in chats go (a private bucket). Same default. */
  chatImageStorage?: ChatImageStorage | null;
  /**
   * Looks up previews for links in messages. Defaults to downloading the linked
   * page (see linkPreview.ts); null turns link previews off.
   */
  linkPreviews?: LinkPreviewFetcher | null;
  /**
   * Turns on the demo: "Try the demo" guest accounts and Natter Bot (see
   * demo.ts and bot.ts). Off unless given; `true` uses the default settings.
   */
  demo?: boolean | DemoOptions;
  /**
   * Limits on signing in, signing up and sending messages (see rateLimit.ts).
   * On with the defaults unless given; false turns them off.
   */
  rateLimits?: RateLimitOptions | false;
  /**
   * How many proxies sit in front of the server, so `req.ip` is the visitor's
   * address from X-Forwarded-For rather than the proxy's. Leave it off when
   * there's no proxy, or anyone could fake their IP to get around the limits.
   */
  trustProxy?: number | false;
  clientDist?: string;
  corsOrigin?: string;
}

export interface ChatApp {
  app: express.Express;
  httpServer: http.Server;
  io: ChatServer;
  db: Db;
  /** The demo's moving parts, when it's turned on. */
  demo: {
    bot: Bot;
    /** Deletes expired guests now; resolves to how many. */
    cleanUpGuests(): Promise<number>;
  } | null;
  close(): Promise<void>;
}

/**
 * Connects to the database and builds the whole server without listening, so
 * tests can start it on a random port with a throwaway database.
 */
export async function createServer({
  db: dbConfig,
  avatarStorage = storageFromEnv(),
  chatImageStorage = chatImageStorageFromEnv(),
  linkPreviews = fetchLinkPreview,
  demo = false,
  rateLimits = {},
  trustProxy = false,
  clientDist,
  corsOrigin,
}: ServerOptions): Promise<ChatApp> {
  const db = await openDb(dbConfig);
  const presence = createPresence();
  const app = express();
  const httpServer = http.createServer(app);
  // Natter Bot is created below, once the socket server it talks through exists.
  let bot: Bot | null = null;
  const io = attachSocket(httpServer, db, presence, {
    corsOrigin,
    chatImageStorage,
    linkPreviews,
    onMessage: (message) => bot?.receive(message),
    onConnect: (user) => bot?.connected(user.id),
  });

  const demoOptions = demo === true ? {} : demo || null;
  const settings = demoSettings(demoOptions ?? {});
  let cleanup: ReturnType<typeof startGuestCleanup> | null = null;
  if (demoOptions) {
    bot = await createBot({
      db,
      io,
      presence,
      chatImageStorage,
      linkPreviews,
      timing: demoOptions.botTiming,
    });
    cleanup = startGuestCleanup(
      db,
      { avatarStorage, chatImageStorage },
      settings,
    );
  }

  const limits = rateLimits
    ? createRateLimits(rateLimitSettings(rateLimits))
    : null;

  app.disable("x-powered-by");
  if (trustProxy !== false) app.set("trust proxy", trustProxy);
  app.use(express.json({ limit: "10kb" }));
  app.use(cookieParser());

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.use("/api/auth", authRoutes(db), demoRoutes(db, bot, settings));
  // Everything else under /api needs a signed-in user.
  app.use(
    "/api",
    requireAuth(db),
    chatRoutes(db, presence, chatImageStorage, (message) => {
      emitNewMessage(io, message);
      bot?.receive(message); // a picture sent to Natter Bot gets an answer too
    }),
    profileRoutes(db, presence, avatarStorage, (user) =>
      io.emit("profile:updated", user),
    ),
  );
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // In production, serve the built React app from the same origin.
  if (clientDist && fs.existsSync(path.join(clientDist, "index.html"))) {
    app.use(express.static(clientDist));
    app.use((req, res, next) => {
      if (req.method !== "GET") return next();
      res.sendFile(path.join(clientDist, "index.html"));
    });
  }

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Invalid JSON" });
      return;
    }
    if (err?.type === "entity.too.large") {
      res.status(413).json({
        error: `That's too large (max ${Math.round((err.limit ?? MAX_AVATAR_BYTES) / 1024)} KB)`,
      });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  };
  app.use(errorHandler);

  return {
    app,
    httpServer,
    io,
    db,
    demo: bot && cleanup ? { bot, cleanUpGuests: cleanup.run } : null,
    close: () =>
      new Promise<void>((resolve, reject) => {
        bot?.stop();
        cleanup?.stop();
        limits?.stop();
        // Stops Socket.IO and the HTTP server, then closes the database connection.
        io.close(() => {
          db.close().then(resolve, reject);
        });
      }),
  };
}
