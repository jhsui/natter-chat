import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  Message,
  ServerToClientEvents,
} from "../../shared/types.js";
import { REPO_URL } from "../src/bot.js";
import { createServer, type ChatApp, type ServerOptions } from "../src/app.js";

// The demo: "Try the demo" guest accounts and Natter Bot. These tests always
// use throwaway in-memory databases, since they start several servers.

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** In-memory stand-ins for Supabase Storage (see chat.test.ts). */
function fakeStorages() {
  const avatars = new Map<string, Buffer>();
  const images = new Map<string, Buffer>();
  return {
    avatars,
    images,
    avatarStorage: {
      async save(key: string, data: Buffer) {
        avatars.set(key, data);
        return { url: `https://storage.test/avatars/${key}` };
      },
      async remove(key: string) {
        avatars.delete(key);
      },
    },
    chatImageStorage: {
      async save(key: string, data: Buffer) {
        images.set(key, data);
      },
      async read(key: string) {
        const data = images.get(key);
        if (!data) throw new Error(`No such file: ${key}`);
        return data;
      },
      async remove(key: string) {
        images.delete(key);
      },
    },
  };
}

/** Pretends to fetch link previews: knows one site, and records what it was asked. */
const previewsAsked: string[] = [];
async function fakeLinkPreviews(url: string) {
  previewsAsked.push(url);
  if (!url.startsWith("https://news.test/")) return null;
  return {
    url,
    title: "Big news",
    description: null,
    imageUrl: null,
    siteName: "News",
  };
}

/** Natter Bot with no waiting, apart from a short pause to group quick messages. */
const instantBot = {
  settle: 120,
  read: 0,
  typing: 0,
  perChar: 0,
  previewWait: 300,
};

async function start(options: Partial<ServerOptions>) {
  const server = await createServer({
    db: { pgliteDir: "memory://" },
    linkPreviews: fakeLinkPreviews,
    // These tests sign up and send faster than people do.
    rateLimits: false,
    ...options,
  });
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  const baseUrl = `http://localhost:${(server.httpServer.address() as AddressInfo).port}`;
  return { server, baseUrl };
}

/** Tiny HTTP client that remembers the auth cookie, like a browser would. */
function clientOf(baseUrl: string) {
  let cookie = "";
  return {
    get cookie() {
      return cookie;
    },
    async request(
      method: string,
      path: string,
      body?: unknown,
    ): Promise<{ status: number; body: any }> {
      const res = await fetch(baseUrl + path, {
        method,
        headers: { "Content-Type": "application/json", cookie },
        body: body ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0] ?? "";
      return { status: res.status, body: await res.json() };
    },
    async upload(
      path: string,
      data: Buffer,
      contentType: string,
      method = "POST",
    ): Promise<{ status: number; body: any }> {
      const res = await fetch(baseUrl + path, {
        method,
        headers: { "Content-Type": contentType, cookie },
        body: new Uint8Array(data),
      });
      return { status: res.status, body: await res.json() };
    },
    async raw(path: string) {
      return fetch(baseUrl + path, { headers: { cookie } });
    },
  };
}
type Client = ReturnType<typeof clientOf>;

function socketFor(baseUrl: string, c: Client): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const s: ClientSocket = connect(baseUrl, {
      extraHeaders: { cookie: c.cookie },
      transports: ["websocket"],
    });
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
  });
}

/** Records everything the bot does on a socket, so tests can wait for it. */
function watch(socket: ClientSocket, botId: number) {
  const fromBot: Message[] = [];
  const events: string[] = [];
  const reactions: { messageId: number; emoji: string }[] = [];
  socket.on("message:new", (m) => {
    if (m.senderId === botId) fromBot.push(m);
  });
  socket.on("typing", ({ from, typing }) => {
    if (from === botId && typing) events.push("typing");
  });
  socket.on("messages:read", ({ readerId }) => {
    if (readerId === botId) events.push("read");
  });
  socket.on("message:reactions", ({ messageId, reactions: list }) => {
    for (const r of list)
      if (r.userId === botId) reactions.push({ messageId, emoji: r.emoji });
  });

  /** Resolves once the bot has sent `count` more messages. */
  async function next(count = 1): Promise<Message[]> {
    const want = fromBot.length + count;
    const startedAt = Date.now();
    while (fromBot.length < want) {
      if (Date.now() - startedAt > 5000)
        throw new Error(`Natter Bot sent ${fromBot.length}, expected ${want}`);
      await sleep(10);
    }
    return fromBot.slice(want - count, want);
  }
  return { fromBot, events, reactions, next };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A file whose first bytes say PNG, which is all the server checks. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

// ---- The main demo server ----------------------------------------------------

let main: { server: ChatApp; baseUrl: string };
let files: ReturnType<typeof fakeStorages>;
let botId: number;

before(async () => {
  files = fakeStorages();
  main = await start({
    demo: { botTiming: instantBot },
    avatarStorage: files.avatarStorage,
    chatImageStorage: files.chatImageStorage,
  });
  botId = main.server.demo!.bot.user.id;
});

after(() => main.server.close());

/** Starts the demo as a new visitor. */
async function newGuest() {
  const c = clientOf(main.baseUrl);
  const r = await c.request("POST", "/api/auth/demo");
  assert.equal(r.status, 201);
  return { c, user: r.body.user as { id: number; username: string } };
}

async function send(socket: ClientSocket, body: string): Promise<Message> {
  const ack = await socket.emitWithAck("message:send", { to: botId, body });
  assert.ok(ack.ok, "message sent");
  return ack.message;
}

test("starting the demo signs in a guest, with a message from Natter Bot waiting", async () => {
  const c = clientOf(main.baseUrl);
  const r = await c.request("POST", "/api/auth/demo");
  assert.equal(r.status, 201);
  assert.equal(r.body.guest, true);
  assert.match(r.body.user.username, /^guest_\d{4}$/);
  assert.match(r.body.user.displayName, /^Guest \d{4}$/);
  assert.equal(r.body.bot.displayName, "Natter Bot");
  assert.equal(r.body.bot.id, botId);

  const me = await c.request("GET", "/api/auth/me");
  assert.equal(me.body.guest, true);

  const { conversations } = (await c.request("GET", "/api/conversations")).body;
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].id, botId);
  assert.equal(conversations[0].unread, 1);
  assert.equal(conversations[0].online, true, "the bot is always online");
  assert.match(conversations[0].lastBody, /Natter Bot/);

  // A regular account isn't a guest.
  const alice = clientOf(main.baseUrl);
  await alice.request("POST", "/api/auth/register", {
    username: "alice",
    password: "secret1",
  });
  assert.equal((await alice.request("GET", "/api/auth/me")).body.guest, false);
});

test("guests are hidden from everyone else, and Natter Bot can be found", async () => {
  const alice = clientOf(main.baseUrl);
  await alice.request("POST", "/api/auth/login", {
    username: "alice",
    password: "secret1",
  });
  const { people } = (await alice.request("GET", "/api/people")).body;
  assert.deepEqual(
    people.map((p: { username: string }) => p.username),
    ["natter_bot"],
  );
  assert.equal(people[0].online, true);
  assert.equal(
    (await alice.request("GET", "/api/users?q=guest")).body.users.length,
    0,
  );
  assert.equal(
    (await alice.request("GET", "/api/users?q=natter")).body.users[0].id,
    botId,
  );

  // A guest sees the bot and the real people.
  const { c } = await newGuest();
  const seen = (await c.request("GET", "/api/people")).body.people.map(
    (p: { username: string }) => p.username,
  );
  assert.deepEqual(seen, ["alice", "natter_bot"]);

  // Nobody can sign in as the bot or as a guest with a password.
  const r = await clientOf(main.baseUrl).request("POST", "/api/auth/login", {
    username: "natter_bot",
    password: "",
  });
  assert.equal(r.status, 401);
});

test("Natter Bot gives the tour: read receipts, link previews, reactions, replies, a photo", async () => {
  const { c } = await newGuest();
  const socket = await socketFor(main.baseUrl, c);
  const bot = watch(socket, botId);

  // Arriving brings a tip, live.
  const [tip] = await bot.next();
  assert.match(tip!.body, /Sent to Read/);

  // 1. Any message: it's marked read, the bot types, then explains.
  const hi = await send(socket, "hi");
  const [explained, askForLink] = await bot.next(2);
  assert.match(explained!.body, /switch to Read/);
  assert.match(askForLink!.body, /link/);
  // After the tip's "typing…": first "Read", then "typing…" before each answer.
  assert.deepEqual(bot.events, ["typing", "read", "typing", "typing"]);
  const history = (await c.request("GET", `/api/messages/${botId}`)).body
    .messages as Message[];
  assert.ok(history.find((m) => m.id === hi.id)?.readAt, "saved as read");

  // 2. A link: the bot replies to it, and the link gets its preview card.
  const preview = new Promise((resolve) =>
    socket.once("message:preview", resolve),
  );
  const link = await send(socket, "look https://news.test/story");
  const [aboutLink] = await bot.next();
  assert.equal(aboutLink!.replyTo?.id, link.id);
  assert.match(aboutLink!.body, /preview card/);
  assert.deepEqual(await preview, {
    messageId: link.id,
    preview: {
      url: "https://news.test/story",
      title: "Big news",
      description: null,
      imageUrl: null,
      siteName: "News",
    },
  });

  // 3. Next message: a ❤️ reaction and a reply quoting it.
  const cool = await send(socket, "cool");
  const [replied] = await bot.next();
  assert.equal(replied!.replyTo?.id, cool.id);
  assert.deepEqual(bot.reactions.at(-1), { messageId: cool.id, emoji: "❤️" });

  // 4. A photo, which only the two people in the chat can load.
  await send(socket, "what else?");
  const [photo, caption] = await bot.next(2);
  assert.ok(photo!.image, "an image message");
  assert.equal(photo!.image!.width, 1200);
  assert.match(caption!.body, /photo/);
  const res = await c.raw(photo!.image!.url);
  assert.equal(res.status, 200);
  assert.deepEqual(
    Buffer.from(await res.arrayBuffer()),
    fs.readFileSync(
      new URL("../assets/natter-bot-photo.webp", import.meta.url),
    ),
  );
  const alice = clientOf(main.baseUrl);
  await alice.request("POST", "/api/auth/login", {
    username: "alice",
    password: "secret1",
  });
  assert.equal((await alice.raw(photo!.image!.url)).status, 404);

  // 5. The end of the tour.
  await send(socket, "thanks");
  const [end] = await bot.next();
  assert.match(end!.body, /That's the tour/);

  // Then small talk, never the same line twice in a row.
  let previous = "";
  for (let i = 0; i < 6; i++) {
    await send(socket, `message ${i}`);
    const [line] = await bot.next();
    assert.ok(line!.body);
    assert.notEqual(line!.body, previous);
    previous = line!.body;
  }
  socket.disconnect();
});

test("skipping the link: Natter Bot sends one itself", async () => {
  const { c } = await newGuest();
  const socket = await socketFor(main.baseUrl, c);
  const bot = watch(socket, botId);
  await bot.next(); // the tip

  await send(socket, "hello");
  await bot.next(2);
  await send(socket, "no links, sorry");
  const [withLink] = await bot.next();
  assert.ok(withLink!.body.includes(REPO_URL));
  // Its link goes through the same preview lookup as everyone's.
  await sleep(50);
  assert.ok(previewsAsked.includes(REPO_URL));
  socket.disconnect();
});

test("a link without a preview gets an honest answer", async () => {
  const { c } = await newGuest();
  const socket = await socketFor(main.baseUrl, c);
  const bot = watch(socket, botId);
  await bot.next(); // the tip

  await send(socket, "hey");
  await bot.next(2);
  const link = await send(socket, "https://quiet.test/page"); // no preview for this one
  const [reply] = await bot.next();
  assert.equal(reply!.replyTo?.id, link.id);
  assert.match(reply!.body, /didn't share any details/);
  socket.disconnect();
});

test("a burst of quick messages gets one answer", async () => {
  const { c } = await newGuest();
  const socket = await socketFor(main.baseUrl, c);
  const bot = watch(socket, botId);
  await bot.next(); // the tip

  await send(socket, "one");
  await send(socket, "two");
  await send(socket, "three");
  await bot.next(2); // the first answer is two messages
  await sleep(400);
  assert.equal(bot.fromBot.length, 3, "the tip plus one answer");
  assert.equal(
    bot.events.filter((e) => e === "read").length,
    1,
    "all three were read at once",
  );
  socket.disconnect();
});

test("a picture sent to Natter Bot gets a reaction and a reply", async () => {
  const { c } = await newGuest();
  const socket = await socketFor(main.baseUrl, c);
  const bot = watch(socket, botId);
  await bot.next(); // the tip
  await send(socket, "hi");
  await bot.next(2);

  const r = await c.upload(
    `/api/messages/${botId}/image?width=10&height=10`,
    PNG,
    "image/png",
  );
  assert.equal(r.status, 201);
  const [reply] = await bot.next();
  assert.equal(reply!.replyTo?.id, r.body.message.id);
  assert.match(reply!.body, /photo/);
  assert.deepEqual(bot.reactions.at(-1), {
    messageId: r.body.message.id,
    emoji: "😍",
  });
  socket.disconnect();
});

// ---- Limits and cleanup, on a server whose guests expire quickly -------------

test("guests are limited in how fast they send, but Natter Bot isn't", async () => {
  const clock = { now: 1_000_000 };
  const { server, baseUrl } = await start({
    demo: { botTiming: instantBot },
    rateLimits: { messagesPerUser: 2, now: () => clock.now },
  });
  try {
    const botId = server.demo!.bot.user.id;
    const guest = clientOf(baseUrl);
    assert.equal((await guest.request("POST", "/api/auth/demo")).status, 201);
    const socket = await socketFor(baseUrl, guest);
    const bot = watch(socket, botId);
    await bot.next(); // the tip
    const say = (body: string) =>
      socket.emitWithAck("message:send", { to: botId, body });

    assert.ok((await say("hi")).ok);
    // More than the guest's 2 messages: the bot isn't held to the limit.
    await bot.next(2);
    assert.ok((await say("cool")).ok);
    assert.deepEqual(await say("one more"), {
      error: "Too many messages. Try again in 10 seconds.",
      retryAfterSeconds: 10,
    });

    clock.now += 10 * 1000;
    assert.ok((await say("one more")).ok);
    socket.disconnect();
  } finally {
    await server.close();
  }
});

test("expired guests are deleted with their messages and files; new ones are rate-limited", async () => {
  const storage = fakeStorages();
  const { server, baseUrl } = await start({
    // Guests last 4 seconds (their sign-in too, so the steps before the wait
    // must finish well within that).
    demo: { botTiming: instantBot, guestTtlMs: 4000, maxNewPerWindow: 2 },
    avatarStorage: storage.avatarStorage,
    chatImageStorage: storage.chatImageStorage,
  });
  try {
    const bot = server.demo!.bot.user.id;
    const guest = clientOf(baseUrl);
    assert.equal((await guest.request("POST", "/api/auth/demo")).status, 201);
    assert.equal(
      (await clientOf(baseUrl).request("POST", "/api/auth/demo")).status,
      201,
    );
    const busy = await clientOf(baseUrl).request("POST", "/api/auth/demo");
    assert.equal(busy.status, 503);
    assert.match(busy.body.error, /busy/);

    // The guest leaves files behind: an avatar and a picture in the chat.
    assert.equal(
      (await guest.upload("/api/me/avatar", PNG, "image/png", "PUT")).status,
      200,
    );
    assert.equal(
      (
        await guest.upload(
          `/api/messages/${bot}/image?width=10&height=10`,
          PNG,
          "image/png",
        )
      ).status,
      201,
    );
    assert.equal(storage.avatars.size, 1);
    assert.equal(storage.images.size, 1);

    assert.equal(await server.demo!.cleanUpGuests(), 0, "not expired yet");
    await sleep(4100);
    assert.equal(await server.demo!.cleanUpGuests(), 2);
    assert.equal(storage.avatars.size, 0, "avatar file removed");
    assert.equal(storage.images.size, 0, "chat picture removed");
    assert.equal((await guest.request("GET", "/api/auth/me")).status, 401);
  } finally {
    await server.close();
  }
});

test("with link previews turned off, the tour skips them", async () => {
  const { server, baseUrl } = await start({
    demo: { botTiming: instantBot },
    linkPreviews: null,
  });
  try {
    const bot = server.demo!.bot.user.id;
    const guest = clientOf(baseUrl);
    await guest.request("POST", "/api/auth/demo");
    const socket = await socketFor(baseUrl, guest);
    const seen = watch(socket, bot);
    await seen.next(); // the tip
    await socket.emitWithAck("message:send", { to: bot, body: "hi" });
    const [answer] = await seen.next();
    assert.match(answer!.body, /switch to Read/);
    // Straight on to reactions and replies, without asking for a link.
    const next = await socket.emitWithAck("message:send", {
      to: bot,
      body: "ok",
    });
    const [replied] = await seen.next();
    assert.ok(next.ok);
    assert.equal(replied!.replyTo?.id, next.ok ? next.message.id : 0);
    socket.disconnect();
  } finally {
    await server.close();
  }
});

test("without the demo turned on, there's no demo", async () => {
  const { server, baseUrl } = await start({});
  try {
    const r = await clientOf(baseUrl).request("POST", "/api/auth/demo");
    assert.equal(r.status, 404);
    assert.equal(server.demo, null);
  } finally {
    await server.close();
  }
});
