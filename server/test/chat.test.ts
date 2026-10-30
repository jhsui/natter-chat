import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "../../shared/types.js";
import pg from "pg";
import { createServer, type ChatApp, type ServerOptions } from "../src/app.js";
import type { DbConfig } from "../src/db.js";
import type { RateLimitOptions } from "../src/rateLimit.js";

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let server: ChatApp;
let baseUrl: string;

/**
 * By default the tests use a throwaway in-memory PGlite database. To run them
 * against a real Postgres server instead, set TEST_DATABASE_URL — note that
 * the users, messages and reactions tables in that database are wiped first.
 */
async function testDbConfig(): Promise<DbConfig> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return { pgliteDir: "memory://" };
  const pool = new pg.Pool({ connectionString: url });
  await pool.query("DROP TABLE IF EXISTS reactions, messages, users");
  await pool.end();
  return { databaseUrl: url };
}

/** In-memory stand-in for Supabase Storage, so tests need no account or network. */
const fakeStorage = {
  files: new Map<string, { data: Buffer; contentType: string }>(),
  async save(key: string, data: Buffer, contentType: string) {
    this.files.set(key, { data, contentType });
    return { url: `https://storage.test/avatars/${key}` };
  },
  async remove(key: string) {
    this.files.delete(key);
  },
};

/** Same for the private chat-images bucket: files can only be read back by key. */
const fakeChatImages = {
  files: new Map<string, Buffer>(),
  async save(key: string, data: Buffer) {
    this.files.set(key, data);
  },
  async read(key: string) {
    const data = this.files.get(key);
    if (!data) throw new Error(`No such file: ${key}`);
    return data;
  },
  async remove(key: string) {
    this.files.delete(key);
  },
};

/** Stand-in for downloading linked pages: only knows one site, and records what it was asked. */
const fakeLinkPreviews = {
  asked: [] as string[],
  async fetch(url: string) {
    fakeLinkPreviews.asked.push(url);
    if (!url.startsWith("https://news.test/")) return null;
    return {
      url,
      title: "Big news",
      description: "It happened.",
      imageUrl: "https://news.test/photo.jpg",
      siteName: "News",
    };
  },
};

before(async () => {
  server = await createServer({
    db: await testDbConfig(),
    avatarStorage: fakeStorage,
    chatImageStorage: fakeChatImages,
    linkPreviews: fakeLinkPreviews.fetch,
    // These tests sign up and send faster than people do; the rate limit
    // tests below start servers of their own.
    rateLimits: false,
  });
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  baseUrl = `http://localhost:${(server.httpServer.address() as AddressInfo).port}`;
});

after(() => server.close());

/**
 * Tiny HTTP client that remembers the auth cookie, like a browser would. It
 * talks to the main test server unless given another one's URL.
 */
function client(url?: string, extraHeaders: Record<string, string> = {}) {
  let cookie = "";
  return {
    get cookie() {
      return cookie;
    },
    // Responses are loosely typed here on purpose: the tests check the shapes.
    async request(
      method: string,
      path: string,
      body?: unknown,
    ): Promise<{ status: number; body: any; headers: Headers }> {
      const res = await fetch((url ?? baseUrl) + path, {
        method,
        headers: { "Content-Type": "application/json", cookie, ...extraHeaders },
        body: body ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0] ?? "";
      return { status: res.status, body: await res.json(), headers: res.headers };
    },
    /** Sends raw bytes, like the browser does for avatar and image uploads. */
    async upload(
      path: string,
      data: Buffer,
      contentType: string,
      method = "PUT",
    ): Promise<{ status: number; body: any }> {
      const res = await fetch((url ?? baseUrl) + path, {
        method,
        headers: { "Content-Type": contentType, cookie, ...extraHeaders },
        body: new Uint8Array(data),
      });
      return { status: res.status, body: await res.json() };
    },
  };
}
type Client = ReturnType<typeof client>;

function socketFor(c: Client): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const s: ClientSocket = connect(baseUrl, {
      extraHeaders: { cookie: c.cookie },
      transports: ["websocket"],
    });
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
  });
}

function once<E extends keyof ServerToClientEvents>(
  socket: ClientSocket,
  event: E,
): Promise<Parameters<ServerToClientEvents[E]>[0]> {
  return new Promise((resolve) => {
    // socket.io-client's typed `once` overloads are awkward with generic event names.
    (socket.once as (e: string, cb: (arg: unknown) => void) => void)(
      event,
      (arg) => resolve(arg as Parameters<ServerToClientEvents[E]>[0]),
    );
  });
}

const alice = client();
const bob = client();

test("register validates input and rejects duplicates", async () => {
  let r = await alice.request("POST", "/api/auth/register", {
    username: "a",
    password: "secret1",
  });
  assert.equal(r.status, 400);

  r = await alice.request("POST", "/api/auth/register", {
    username: "alice",
    password: "secret1",
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.username, "alice");

  r = await client().request("POST", "/api/auth/register", {
    username: "ALICE",
    password: "secret1",
  });
  assert.equal(r.status, 409, "usernames are case-insensitive");

  r = await bob.request("POST", "/api/auth/register", {
    username: "bob",
    password: "hunter22",
  });
  assert.equal(r.status, 201);
});

test("login, me and logout", async () => {
  const c = client();
  assert.equal((await c.request("GET", "/api/auth/me")).status, 401);
  assert.equal(
    (
      await c.request("POST", "/api/auth/login", {
        username: "bob",
        password: "wrong!!",
      })
    ).status,
    401,
  );

  const r = await c.request("POST", "/api/auth/login", {
    username: "Bob",
    password: "hunter22",
  });
  assert.equal(r.status, 200);
  assert.equal(
    (await c.request("GET", "/api/auth/me")).body.user.username,
    "bob",
  );

  await c.request("POST", "/api/auth/logout");
  assert.equal((await c.request("GET", "/api/auth/me")).status, 401);
});

test("user search excludes yourself", async () => {
  const r = await alice.request("GET", "/api/users?q=b");
  assert.deepEqual(
    r.body.users.map((u: { username: string }) => u.username),
    ["bob"],
  );
  const self = await alice.request("GET", "/api/users?q=alice");
  assert.equal(self.body.users.length, 0);
});

test("sockets reject unauthenticated connections", async () => {
  await assert.rejects(socketFor(client()), /unauthorized/);
});

test("direct messages are delivered live, stored, and marked read", async () => {
  const bobId: number = (await bob.request("GET", "/api/auth/me")).body.user.id;
  const aliceId: number = (await alice.request("GET", "/api/auth/me")).body.user
    .id;

  const aSock = await socketFor(alice);
  const bSock = await socketFor(bob);

  // Typing indicator reaches the recipient.
  const typing = once(bSock, "typing");
  aSock.emit("typing", { to: bobId, typing: true });
  assert.deepEqual(await typing, { from: aliceId, typing: true });

  // Sending a message reaches both sides.
  const bobGets = once(bSock, "message:new");
  const ack = await aSock.emitWithAck("message:send", {
    to: bobId,
    body: "  hi bob  ",
  });
  assert.ok(ack.ok);
  const received = await bobGets;
  assert.equal(received.body, "hi bob");
  assert.equal(received.senderId, aliceId);

  // Bad messages are rejected.
  const errorOf = async (payload: { to: number; body: string }) => {
    const res = await aSock.emitWithAck("message:send", payload);
    return "error" in res ? res.error : "";
  };
  assert.match(await errorOf({ to: bobId, body: "   " }), /empty/);
  assert.match(await errorOf({ to: aliceId, body: "me" }), /yourself/);
  assert.match(await errorOf({ to: 9999, body: "x" }), /not found/);

  // Bob sees an unread conversation with Alice.
  let convos = (await bob.request("GET", "/api/conversations")).body
    .conversations;
  assert.equal(convos[0].username, "alice");
  assert.equal(convos[0].unread, 1);
  assert.equal(convos[0].online, true);

  // Bob reads it; Alice is told.
  const aliceTold = once(aSock, "messages:read");
  bSock.emit("messages:read", { from: aliceId });
  assert.deepEqual(await aliceTold, {
    readerId: bobId,
    senderId: aliceId,
    upToId: received.id,
  });

  convos = (await bob.request("GET", "/api/conversations")).body.conversations;
  assert.equal(convos[0].unread, 0);

  // History is returned oldest-first.
  await bSock.emitWithAck("message:send", { to: aliceId, body: "hey alice" });
  const history = (await alice.request("GET", `/api/messages/${bobId}`)).body;
  assert.deepEqual(
    history.messages.map((m: { body: string }) => m.body),
    ["hi bob", "hey alice"],
  );
  assert.ok(history.messages[0].readAt);

  // Presence: Alice sees Bob go offline.
  const offline = once(aSock, "presence");
  bSock.disconnect();
  assert.deepEqual(await offline, { userId: bobId, online: false });

  aSock.disconnect();
});

test("message history paginates", async () => {
  const carol = client();
  await carol.request("POST", "/api/auth/register", {
    username: "carol",
    password: "secret1",
  });
  const bobId: number = (await bob.request("GET", "/api/auth/me")).body.user.id;
  const sock = await socketFor(carol);
  for (let i = 1; i <= 5; i++)
    await sock.emitWithAck("message:send", { to: bobId, body: `m${i}` });
  sock.disconnect();

  const bodies = (msgs: { body: string }[]) => msgs.map((m) => m.body);

  const page1 = (await carol.request("GET", `/api/messages/${bobId}?limit=3`))
    .body;
  assert.deepEqual(bodies(page1.messages), ["m3", "m4", "m5"]);
  assert.equal(page1.hasMore, true);

  const page2 = (
    await carol.request(
      "GET",
      `/api/messages/${bobId}?limit=3&before=${page1.messages[0].id}`,
    )
  ).body;
  assert.deepEqual(bodies(page2.messages), ["m1", "m2"]);
  assert.equal(page2.hasMore, false);
});

test("people lists every other user with online status and last chat time", async () => {
  const bSock = await socketFor(bob); // bring Bob online

  const { people } = (await alice.request("GET", "/api/people")).body as {
    people: { username: string; online: boolean; lastAt: string | null }[];
  };
  assert.deepEqual(
    people.map((p) => p.username),
    ["bob", "carol"],
    "everyone except me, A–Z",
  );

  const [bobEntry, carolEntry] = people;
  assert.equal(bobEntry?.online, true);
  assert.ok(bobEntry?.lastAt, "alice and bob have chatted");
  assert.equal(carolEntry?.online, false);
  assert.equal(carolEntry?.lastAt, null, "alice and carol never chatted");

  bSock.disconnect();
});

test("database edge cases: duplicate names and out-of-range ids", async () => {
  // The unique index is case-insensitive, even when the route's pre-check is skipped.
  const dana = await server.db.createUser("Dana", "hash");
  assert.equal(dana?.username, "Dana");
  assert.equal(await server.db.createUser("dana", "hash"), null);

  // Ids bigger than a Postgres INTEGER are treated as "not found", not a crash.
  const huge = 99_999_999_999;
  const r = await alice.request("GET", `/api/messages/${huge}`);
  assert.equal(r.status, 404);
  const bobId: number = (await bob.request("GET", "/api/auth/me")).body.user.id;
  const page = await alice.request(
    "GET",
    `/api/messages/${bobId}?before=${huge}`,
  );
  assert.equal(page.status, 200);

  const sock = await socketFor(alice);
  const ack = await sock.emitWithAck("message:send", { to: huge, body: "hi" });
  assert.ok("error" in ack && /not found/.test(ack.error));
  sock.disconnect();
});

test("a burst of messages arrives in the order it was sent", async () => {
  const bobId: number = (await bob.request("GET", "/api/auth/me")).body.user.id;
  const aliceId: number = (await alice.request("GET", "/api/auth/me")).body.user
    .id;
  const aSock = await socketFor(alice);
  const bSock = await socketFor(bob);

  const received: string[] = [];
  const allIn = new Promise<void>((resolve) => {
    bSock.on("message:new", (m) => {
      if (m.senderId === aliceId) received.push(m.body);
      if (received.length === 10) resolve();
    });
  });
  const sent = Array.from({ length: 10 }, (_, i) => `burst ${i}`);
  // Fire all ten without waiting for each acknowledgement.
  await Promise.all(
    sent.map((body) => aSock.emitWithAck("message:send", { to: bobId, body })),
  );
  await allIn;
  assert.deepEqual(received, sent);

  const history = (await alice.request("GET", `/api/messages/${bobId}`)).body;
  assert.deepEqual(
    history.messages.slice(-10).map((m: { body: string }) => m.body),
    sent,
  );
  aSock.disconnect();
  bSock.disconnect();
});

// Smallest valid-looking images: the server only checks the file signature.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WEBP"),
  Buffer.alloc(64),
]);

test("profiles: display name, bio and validation", async () => {
  const bobId: number = (await bob.request("GET", "/api/auth/me")).body.user.id;

  let r = await bob.request("PATCH", "/api/me", {
    displayName: "  Bob   the  Builder ",
    bio: "  Can we fix it?\nYes we can!  ",
  });
  assert.equal(r.status, 200);
  assert.equal(
    r.body.profile.displayName,
    "Bob the Builder",
    "trimmed, single spaces",
  );
  assert.equal(
    r.body.profile.bio,
    "Can we fix it?\nYes we can!",
    "trimmed, keeps line breaks",
  );

  r = await bob.request("PATCH", "/api/me", {
    displayName: "x".repeat(41),
    bio: "",
  });
  assert.equal(r.status, 400);
  r = await bob.request("PATCH", "/api/me", {
    displayName: "Bob",
    bio: "x".repeat(161),
  });
  assert.equal(r.status, 400);

  // Other people can view it, and it shows up in lists and search.
  r = await alice.request("GET", `/api/users/${bobId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.profile.username, "bob");
  assert.equal(r.body.profile.displayName, "Bob the Builder");
  assert.ok(r.body.profile.createdAt);
  const people = (await alice.request("GET", "/api/people")).body.people;
  assert.equal(
    people.find((p: { id: number }) => p.id === bobId).displayName,
    "Bob the Builder",
  );
  const found = (await alice.request("GET", "/api/users?q=builder")).body.users;
  assert.deepEqual(
    found.map((u: { username: string }) => u.username),
    ["bob"],
    "search matches display names",
  );

  // Clearing the name falls back to null (the app then shows the username).
  r = await bob.request("PATCH", "/api/me", { displayName: "   ", bio: null });
  assert.equal(r.body.profile.displayName, null);
  assert.equal(r.body.profile.bio, null);

  assert.equal(
    (await alice.request("GET", "/api/users/99999999999")).status,
    404,
  );
  assert.equal(
    (await client().request("GET", `/api/users/${bobId}`)).status,
    401,
  );
});

test("avatars: upload, replace, remove, and live updates", async () => {
  const watcher = await socketFor(bob); // someone watching for profile changes
  const aliceId: number = (await alice.request("GET", "/api/auth/me")).body.user
    .id;

  const announced = once(watcher, "profile:updated");
  let r = await alice.upload("/api/me/avatar", PNG, "image/png");
  assert.equal(r.status, 200);
  const firstUrl: string = r.body.profile.avatarUrl;
  assert.match(
    firstUrl,
    new RegExp(`^https://storage.test/avatars/${aliceId}/.+\\.png$`),
  );
  assert.equal(fakeStorage.files.size, 1);
  const update = await announced;
  assert.equal(update.id, aliceId);
  assert.equal(update.avatarUrl, firstUrl);

  // The avatar comes back from /me and in other people's lists.
  assert.equal(
    (await alice.request("GET", "/api/auth/me")).body.user.avatarUrl,
    firstUrl,
  );

  // Replacing it deletes the old file and uses a new URL.
  r = await alice.upload("/api/me/avatar", WEBP, "image/webp");
  assert.equal(r.status, 200);
  assert.notEqual(r.body.profile.avatarUrl, firstUrl);
  assert.match(r.body.profile.avatarUrl, /\.webp$/);
  assert.equal(fakeStorage.files.size, 1, "old file removed");

  // The file signature decides, not the Content-Type the client claims.
  r = await alice.upload(
    "/api/me/avatar",
    Buffer.from("<svg onload=alert(1)>"),
    "image/png",
  );
  assert.equal(r.status, 400);
  r = await alice.upload(
    "/api/me/avatar",
    Buffer.concat([PNG, Buffer.alloc(600 * 1024)]),
    "image/png",
  );
  assert.equal(r.status, 413);

  r = await alice.request("DELETE", "/api/me/avatar");
  assert.equal(r.status, 200);
  assert.equal(r.body.profile.avatarUrl, null);
  assert.equal(fakeStorage.files.size, 0);

  watcher.disconnect();
});

test("image messages: upload, live delivery, history and validation", async () => {
  const bobId: number = (await bob.request("GET", "/api/auth/me")).body.user.id;
  const aliceId: number = (await alice.request("GET", "/api/auth/me")).body.user
    .id;
  const aSock = await socketFor(alice);
  const bSock = await socketFor(bob);
  const send = (
    c: Client,
    to: number,
    data: Buffer,
    size = "width=800&height=600",
  ) =>
    c.upload(`/api/messages/${to}/image?${size}`, data, "image/webp", "POST");

  // Both sides get the message live, with where to load the picture and its size.
  const bobGets = once(bSock, "message:new");
  const aliceGets = once(aSock, "message:new");
  let r = await send(alice, bobId, WEBP);
  assert.equal(r.status, 201);
  const sent = r.body.message;
  assert.equal(sent.senderId, aliceId);
  assert.equal(sent.recipientId, bobId);
  assert.equal(sent.body, "");
  assert.equal(sent.image.url, `/api/images/${sent.id}`);
  assert.equal(sent.image.width, 800);
  assert.equal(sent.image.height, 600);
  assert.deepEqual(await bobGets, sent);
  assert.deepEqual(await aliceGets, sent);
  assert.equal(fakeChatImages.files.size, 1);
  assert.equal(fakeStorage.files.size, 0, "not in the public avatars bucket");

  // The file is served to the two people in the conversation, and nobody else.
  const fetchImage = (c: Client, path: string = sent.image.url) =>
    fetch(baseUrl + path, { headers: { cookie: c.cookie } });
  for (const who of [alice, bob]) {
    const res = await fetchImage(who);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/webp");
    assert.match(res.headers.get("cache-control") ?? "", /^private,/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), WEBP);
  }
  const carol = client();
  await carol.request("POST", "/api/auth/login", {
    username: "carol",
    password: "secret1",
  });
  assert.equal((await fetchImage(carol)).status, 404, "not her conversation");
  assert.equal((await fetchImage(client())).status, 401, "not signed in");
  assert.equal(
    (await fetchImage(alice, "/api/images/99999999999")).status,
    404,
  );

  // It's in the history next to text messages, and it's the conversation's preview.
  const history = (await bob.request("GET", `/api/messages/${aliceId}`)).body;
  assert.deepEqual(history.messages.at(-1), sent);
  const text = history.messages[0];
  assert.equal(text.image, null, "text messages have no image");
  assert.equal((await fetchImage(alice, `/api/images/${text.id}`)).status, 404);
  const previewOf = async () =>
    (await bob.request("GET", "/api/conversations")).body.conversations.find(
      (c: { id: number }) => c.id === aliceId,
    );
  assert.equal((await previewOf()).lastIsImage, true);
  await bSock.emitWithAck("message:send", { to: aliceId, body: "nice pic" });
  assert.equal((await previewOf()).lastIsImage, false);

  // Bad uploads are rejected and nothing is stored.
  r = await send(alice, bobId, Buffer.from("<svg onload=alert(1)>"));
  assert.equal(
    r.status,
    400,
    "the file signature decides, not the Content-Type",
  );
  r = await send(alice, bobId, WEBP, "width=0&height=600");
  assert.equal(r.status, 400);
  r = await send(alice, bobId, WEBP, "");
  assert.equal(r.status, 400, "the size is required");
  r = await send(alice, aliceId, WEBP);
  assert.equal(r.status, 400, "can't message yourself");
  r = await send(alice, 99_999_999_999, WEBP);
  assert.equal(r.status, 404);
  r = await send(
    alice,
    bobId,
    Buffer.concat([WEBP, Buffer.alloc(1100 * 1024)]),
  );
  assert.equal(r.status, 413);
  r = await send(client(), bobId, WEBP);
  assert.equal(r.status, 401);
  assert.equal(fakeChatImages.files.size, 1);

  aSock.disconnect();
  bSock.disconnect();
});

test("replies quote an earlier message from the same conversation only", async () => {
  const bobId: number = (await bob.request("GET", "/api/auth/me")).body.user.id;
  const aliceId: number = (await alice.request("GET", "/api/auth/me")).body.user
    .id;
  const aSock = await socketFor(alice);
  const bSock = await socketFor(bob);
  const send = async (
    sock: ClientSocket,
    payload: { to: number; body: string; replyTo?: number },
  ) => {
    const ack = await sock.emitWithAck("message:send", payload);
    assert.ok(ack.ok);
    return ack.message;
  };

  // Bob asks; Alice replies to that message. Both get the quote with the reply.
  const question = await send(bSock, {
    to: aliceId,
    body: "lunch at 12? " + "x".repeat(300),
  });
  assert.equal(question.replyTo, null);
  const bobGets = once(bSock, "message:new");
  const answer = await send(aSock, {
    to: bobId,
    body: "yes!",
    replyTo: question.id,
  });
  assert.deepEqual(answer.replyTo, {
    id: question.id,
    senderId: bobId,
    body: question.body.slice(0, 200),
    imageUrl: null,
    deleted: false,
  });
  assert.deepEqual(await bobGets, answer);

  // The quote comes back with the history too.
  const history = (await bob.request("GET", `/api/messages/${aliceId}`)).body;
  assert.deepEqual(history.messages.at(-1), answer);

  // Replying to a picture, and replying with a picture.
  const picture = history.messages.find(
    (m: { image: unknown }) => m.image !== null,
  );
  const toPicture = await send(bSock, {
    to: aliceId,
    body: "nice one",
    replyTo: picture.id,
  });
  assert.equal(toPicture.replyTo?.body, "");
  assert.equal(toPicture.replyTo?.imageUrl, `/api/images/${picture.id}`);
  const r = await alice.upload(
    `/api/messages/${bobId}/image?width=10&height=10&replyTo=${question.id}`,
    WEBP,
    "image/webp",
    "POST",
  );
  assert.equal(r.status, 201);
  assert.equal(r.body.message.replyTo.id, question.id);

  // A message from another conversation can't be quoted (that would leak it):
  // the message is still sent, just not as a reply. Same for ids that don't exist.
  const carol = client();
  await carol.request("POST", "/api/auth/login", {
    username: "carol",
    password: "secret1",
  });
  const cSock = await socketFor(carol);
  const secret = await send(cSock, {
    to: bobId,
    body: "between carol and bob",
  });
  for (const replyTo of [secret.id, 99_999_999_999, -1]) {
    const sent = await send(aSock, { to: bobId, body: "hmm", replyTo });
    assert.equal(sent.replyTo, null);
  }

  aSock.disconnect();
  bSock.disconnect();
  cSock.disconnect();
});

test("reactions: add, change, remove, and only in your own conversations", async () => {
  const bobId: number = (await bob.request("GET", "/api/auth/me")).body.user.id;
  const aliceId: number = (await alice.request("GET", "/api/auth/me")).body.user
    .id;
  const aSock = await socketFor(alice);
  const bSock = await socketFor(bob);
  const sent = await bSock.emitWithAck("message:send", {
    to: aliceId,
    body: "we won!",
  });
  assert.ok(sent.ok);
  const messageId = sent.message.id;
  assert.deepEqual(sent.message.reactions, []);

  // Alice reacts; both of them are told, with the full list.
  let bobTold = once(bSock, "message:reactions");
  let aliceTold = once(aSock, "message:reactions");
  let ack = await aSock.emitWithAck("message:react", {
    messageId,
    emoji: "👍",
  });
  assert.ok(ack.ok);
  const first = { messageId, reactions: [{ userId: aliceId, emoji: "👍" }] };
  assert.deepEqual(await bobTold, first);
  assert.deepEqual(await aliceTold, first);

  // Bob reacts too, and Alice changes hers: still one each.
  await bSock.emitWithAck("message:react", { messageId, emoji: "😂" });
  bobTold = once(bSock, "message:reactions");
  await aSock.emitWithAck("message:react", { messageId, emoji: "❤️" });
  assert.deepEqual(
    new Set((await bobTold).reactions.map((r) => `${r.userId}${r.emoji}`)),
    new Set([`${aliceId}❤️`, `${bobId}😂`]),
  );

  // They come back with the history.
  const lastMessage = async () =>
    (await alice.request("GET", `/api/messages/${bobId}`)).body.messages.at(-1);
  assert.equal((await lastMessage()).reactions.length, 2);

  // Removing one.
  aliceTold = once(aSock, "message:reactions");
  await bSock.emitWithAck("message:react", { messageId, emoji: null });
  assert.deepEqual((await aliceTold).reactions, [
    { userId: aliceId, emoji: "❤️" },
  ]);

  // Any single emoji works, including ones made of several characters.
  for (const emoji of ["🦄", "👍🏽", "🇯🇵", "👨‍👩‍👧", "1️⃣"]) {
    aliceTold = once(aSock, "message:reactions");
    ack = await aSock.emitWithAck("message:react", { messageId, emoji });
    assert.ok(ack.ok, emoji);
    assert.deepEqual((await aliceTold).reactions, [{ userId: aliceId, emoji }]);
  }
  await aSock.emitWithAck("message:react", { messageId, emoji: "❤️" });

  // Not a single emoji, not a real message, not your conversation: refused.
  const errorOf = async (sock: ClientSocket, payload: object) => {
    const res = await sock.emitWithAck("message:react", payload as never);
    return "error" in res ? res.error : "";
  };
  for (const emoji of ["hello", "👍👍", "👍 ", "", 7, "x".repeat(100)])
    assert.match(await errorOf(aSock, { messageId, emoji }), /single emoji/);
  assert.match(
    await errorOf(aSock, { messageId: 99_999_999_999, emoji: "👍" }),
    /not found/,
  );
  const carol = client();
  await carol.request("POST", "/api/auth/login", {
    username: "carol",
    password: "secret1",
  });
  const cSock = await socketFor(carol);
  assert.match(await errorOf(cSock, { messageId, emoji: "👍" }), /not found/);
  assert.deepEqual((await lastMessage()).reactions, [
    { userId: aliceId, emoji: "❤️" },
  ]);

  aSock.disconnect();
  bSock.disconnect();
  cSock.disconnect();
});

test("deleting a message empties it for both people and removes its picture", async () => {
  const bobId: number = (await bob.request("GET", "/api/auth/me")).body.user.id;
  const aliceId: number = (await alice.request("GET", "/api/auth/me")).body.user
    .id;
  const aSock = await socketFor(alice);
  const bSock = await socketFor(bob);
  const send = async (
    sock: ClientSocket,
    payload: { to: number; body: string; replyTo?: number },
  ) => {
    const ack = await sock.emitWithAck("message:send", payload);
    assert.ok(ack.ok);
    return ack.message;
  };
  const remove = async (sock: ClientSocket, messageId: number) => {
    const res = await sock.emitWithAck("message:delete", { messageId });
    return "error" in res ? res.error : "ok";
  };
  const history = async () =>
    (await bob.request("GET", `/api/messages/${aliceId}`)).body.messages;

  // Alice sends something, Bob reacts and replies to it.
  const oops = await send(aSock, { to: bobId, body: "my password is hunter2" });
  await bSock.emitWithAck("message:react", { messageId: oops.id, emoji: "😮" });
  const reply = await send(bSock, {
    to: aliceId,
    body: "delete that!",
    replyTo: oops.id,
  });

  // Only the sender can delete it, and only while it's recent enough. (The
  // real limit is 2 days, so ask the database directly with a limit of none.)
  assert.match(await remove(bSock, oops.id), /not found/);
  assert.equal(await server.db.deleteMessage(oops.id, aliceId, 0), "expired");
  assert.equal(
    (await history()).find((m: { id: number }) => m.id === oops.id).body,
    oops.body,
    "an expired delete changes nothing",
  );
  assert.match(await remove(aSock, 99_999_999_999), /not found/);

  // Both are told, and what's left has no text, reactions or reply link.
  const bobTold = once(bSock, "message:deleted");
  const aliceTold = once(aSock, "message:deleted");
  assert.equal(await remove(aSock, oops.id), "ok");
  const gone = await bobTold;
  assert.deepEqual(await aliceTold, gone);
  assert.equal(gone.id, oops.id);
  assert.equal(gone.body, "");
  assert.ok(gone.deletedAt);
  assert.deepEqual(gone.reactions, []);

  // The history agrees, and the reply's quote no longer shows the text.
  let messages = await history();
  assert.deepEqual(
    messages.find((m: { id: number }) => m.id === oops.id),
    gone,
  );
  const quote = messages.find((m: { id: number }) => m.id === reply.id).replyTo;
  assert.deepEqual(quote, {
    id: oops.id,
    senderId: aliceId,
    body: "",
    imageUrl: null,
    deleted: true,
  });

  // It can't be deleted twice, reacted to, or replied to any more.
  assert.match(await remove(aSock, oops.id), /not found/);
  const react = await bSock.emitWithAck("message:react", {
    messageId: oops.id,
    emoji: "👍",
  });
  assert.ok("error" in react);
  const late = await send(bSock, {
    to: aliceId,
    body: "what was it?",
    replyTo: oops.id,
  });
  assert.equal(late.replyTo, null);

  // Deleting a picture also removes the file, and it stops being served.
  const r = await alice.upload(
    `/api/messages/${bobId}/image?width=10&height=10`,
    WEBP,
    "image/webp",
    "POST",
  );
  const picture = r.body.message;
  const filesBefore = fakeChatImages.files.size;
  assert.equal(await remove(aSock, picture.id), "ok");
  assert.equal(fakeChatImages.files.size, filesBefore - 1);
  const served = await fetch(baseUrl + picture.image.url, {
    headers: { cookie: alice.cookie },
  });
  assert.equal(served.status, 404);
  messages = await history();
  assert.equal(messages.at(-1).image, null);
  assert.ok(messages.at(-1).deletedAt);

  // The conversation list knows its latest message was deleted.
  const convo = (
    await bob.request("GET", "/api/conversations")
  ).body.conversations.find((c: { id: number }) => c.id === aliceId);
  assert.equal(convo.lastIsDeleted, true);
  assert.equal(convo.lastIsImage, false);

  aSock.disconnect();
  bSock.disconnect();
});

test("a link in a message gets a preview shortly after it's sent", async () => {
  const bobId: number = (await bob.request("GET", "/api/auth/me")).body.user.id;
  const aliceId: number = (await alice.request("GET", "/api/auth/me")).body.user
    .id;
  const aSock = await socketFor(alice);
  const bSock = await socketFor(bob);
  const lastMessage = async () =>
    (await bob.request("GET", `/api/messages/${aliceId}`)).body.messages.at(-1);

  // The message arrives straight away without the preview; the preview follows.
  const bobTold = once(bSock, "message:preview");
  const aliceTold = once(aSock, "message:preview");
  const ack = await aSock.emitWithAck("message:send", {
    to: bobId,
    body: "have you seen https://news.test/story?id=7. wow",
  });
  assert.ok(ack.ok);
  assert.equal(ack.message.linkPreview, null);
  const expected = {
    messageId: ack.message.id,
    preview: {
      url: "https://news.test/story?id=7",
      title: "Big news",
      description: "It happened.",
      imageUrl: "https://news.test/photo.jpg",
      siteName: "News",
    },
  };
  assert.deepEqual(await bobTold, expected);
  assert.deepEqual(await aliceTold, expected);

  // It's saved with the message, and removed when the message is deleted.
  assert.deepEqual((await lastMessage()).linkPreview, expected.preview);
  await aSock.emitWithAck("message:delete", { messageId: ack.message.id });
  assert.equal((await lastMessage()).linkPreview, null);

  // A link with nothing to show, and a message without a link.
  fakeLinkPreviews.asked.length = 0;
  await aSock.emitWithAck("message:send", {
    to: bobId,
    body: "https://nothing.test/",
  });
  await aSock.emitWithAck("message:send", { to: bobId, body: "no link" });
  // The third message's preview arriving means the first two were dealt with.
  // (Listen before sending: the preview can arrive right behind the message.)
  const lastPreview = once(bSock, "message:preview");
  const third = await aSock.emitWithAck("message:send", {
    to: bobId,
    body: "https://news.test/again",
  });
  assert.ok(third.ok && (await lastPreview).messageId === third.message.id);
  assert.deepEqual(fakeLinkPreviews.asked, [
    "https://nothing.test/",
    "https://news.test/again",
  ]);
  const history = (await bob.request("GET", `/api/messages/${aliceId}`)).body
    .messages;
  assert.equal(history.at(-3).linkPreview, null);
  assert.equal(history.at(-2).linkPreview, null);

  aSock.disconnect();
  bSock.disconnect();
});

test("uploads explain when storage isn't configured", async () => {
  const bare = await createServer({
    db: { pgliteDir: "memory://" },
    avatarStorage: null,
    chatImageStorage: null,
    linkPreviews: null,
  });
  await new Promise<void>((resolve) => bare.httpServer.listen(0, resolve));
  const url = `http://localhost:${(bare.httpServer.address() as AddressInfo).port}`;
  try {
    const reg = await fetch(`${url}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "solo", password: "secret1" }),
    });
    const cookie = reg.headers.get("set-cookie")?.split(";")[0] ?? "";
    const res = await fetch(`${url}/api/me/avatar`, {
      method: "PUT",
      headers: { "Content-Type": "image/png", cookie },
      body: new Uint8Array(PNG),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /Supabase/);

    const image = await fetch(`${url}/api/messages/1/image?width=1&height=1`, {
      method: "POST",
      headers: { "Content-Type": "image/png", cookie },
      body: new Uint8Array(PNG),
    });
    assert.equal(image.status, 503);
  } finally {
    await bare.close();
  }
});

// ---- Rate limits ---------------------------------------------------------------

/**
 * Starts a server of its own with rate limits on, and a clock the test moves
 * by hand (`clock.now += ms`) instead of waiting.
 */
async function limitedServer(
  rateLimits: RateLimitOptions,
  options: Partial<ServerOptions> = {},
) {
  const clock = { now: 1_000_000 };
  const limited = await createServer({
    db: { pgliteDir: "memory://" },
    avatarStorage: null,
    chatImageStorage: null,
    linkPreviews: null,
    rateLimits: { ...rateLimits, now: () => clock.now },
    ...options,
  });
  await new Promise<void>((resolve) => limited.httpServer.listen(0, resolve));
  const url = `http://localhost:${(limited.httpServer.address() as AddressInfo).port}`;
  return { url, clock, close: () => limited.close() };
}

const MINUTE = 60 * 1000;

test("sign-in: wrong passwords are limited per username and IP, until the wait is over", async () => {
  const { url, clock, close } = await limitedServer({ loginFailuresPerName: 3 });
  try {
    const signIn = (username: string, password: string) =>
      client(url).request("POST", "/api/auth/login", { username, password });
    const reg = await client(url).request("POST", "/api/auth/register", {
      username: "rl_victim",
      password: "secret1",
    });
    assert.equal(reg.status, 201);

    for (let i = 0; i < 3; i++) {
      assert.equal((await signIn("rl_victim", "wrong!!")).status, 401);
    }
    // Now even the right password is refused (in any capitalisation), so
    // guessing can't go on by watching for a different answer.
    const r = await signIn("RL_Victim", "secret1");
    assert.equal(r.status, 429);
    assert.equal(r.body.retryAfterSeconds, 15 * 60);
    assert.equal(r.headers.get("retry-after"), "900");
    assert.match(r.body.error, /Too many sign-in attempts/);
    assert.equal(r.headers.get("set-cookie"), null);

    // Someone else signing in from the same IP isn't affected.
    assert.equal((await signIn("rl_other", "whatever")).status, 401);

    clock.now += 15 * MINUTE;
    assert.equal((await signIn("rl_victim", "secret1")).status, 200);

    // Signing in starts the count again.
    for (let i = 0; i < 2; i++) {
      assert.equal((await signIn("rl_victim", "wrong!!")).status, 401);
    }
    assert.equal((await signIn("rl_victim", "secret1")).status, 200);
    for (let i = 0; i < 3; i++) {
      assert.equal((await signIn("rl_victim", "wrong!!")).status, 401);
    }
    assert.equal((await signIn("rl_victim", "secret1")).status, 429);
  } finally {
    await close();
  }
});

test("sign-in: failures from one IP don't lock the account for other IPs", async () => {
  const { url, close } = await limitedServer(
    { loginFailuresPerName: 3 },
    { trustProxy: 1 },
  );
  try {
    const signIn = (ip: string, password: string) =>
      client(url, { "X-Forwarded-For": ip }).request(
        "POST",
        "/api/auth/login",
        { username: "rl_victim", password },
      );
    await client(url).request("POST", "/api/auth/register", {
      username: "rl_victim",
      password: "secret1",
    });
    for (let i = 0; i < 3; i++) {
      assert.equal((await signIn("203.0.113.1", "wrong!!")).status, 401);
    }
    assert.equal((await signIn("203.0.113.1", "secret1")).status, 429);
    // The real owner, somewhere else, can still sign in.
    assert.equal((await signIn("203.0.113.2", "secret1")).status, 200);
  } finally {
    await close();
  }
});

test("sign-in: parallel guesses can't get past the per-username limit", async () => {
  const { url, close } = await limitedServer({ loginFailuresPerName: 3 });
  try {
    await client(url).request("POST", "/api/auth/register", {
      username: "rl_victim",
      password: "secret1",
    });
    // Enough at once that some arrive while others are still being checked
    // (fewer than the 30 allowed per IP).
    const statuses = await Promise.all(
      Array.from({ length: 25 }, () =>
        client(url)
          .request("POST", "/api/auth/login", {
            username: "rl_victim",
            password: "wrong!!",
          })
          .then((r) => r.status),
      ),
    );
    assert.equal(statuses.filter((s) => s === 401).length, 3);
    assert.equal(statuses.filter((s) => s === 429).length, 22);
  } finally {
    await close();
  }
});

test("sign-in: one IP trying many usernames hits the per-IP limit", async () => {
  const { url, close } = await limitedServer({ loginPerIp: 4 });
  try {
    await client(url).request("POST", "/api/auth/register", {
      username: "rl_real",
      password: "secret1",
    });
    const c = client(url);
    // Missing and oversized names count too.
    assert.equal((await c.request("POST", "/api/auth/login", {})).status, 401);
    assert.equal(
      (
        await c.request("POST", "/api/auth/login", {
          username: "x".repeat(5000),
          password: "secret1",
        })
      ).status,
      401,
    );
    for (const username of ["nobody_1", "nobody_2"]) {
      assert.equal(
        (await c.request("POST", "/api/auth/login", { username, password: "p" }))
          .status,
        401,
      );
    }
    const r = await c.request("POST", "/api/auth/login", {
      username: "rl_real",
      password: "secret1",
    });
    assert.equal(r.status, 429);
    assert.equal(r.body.retryAfterSeconds, 15 * 60);
  } finally {
    await close();
  }
});

test("sign-up: every attempt from an IP counts, and a refused one creates no account", async () => {
  const { url, clock, close } = await limitedServer({ registerPerIp: 3 });
  try {
    const signUp = (username: string) =>
      client(url).request("POST", "/api/auth/register", {
        username,
        password: "secret1",
      });
    assert.equal((await signUp("a")).status, 400);
    assert.equal((await signUp("rl_new")).status, 201);
    assert.equal((await signUp("RL_NEW")).status, 409);

    const r = await signUp("rl_late");
    assert.equal(r.status, 429);
    assert.equal(r.body.retryAfterSeconds, 60 * 60);
    assert.equal(r.headers.get("retry-after"), "3600");
    assert.match(r.body.error, /Too many sign-up attempts/);
    assert.equal(r.headers.get("set-cookie"), null);
    const login = await client(url).request("POST", "/api/auth/login", {
      username: "rl_late",
      password: "secret1",
    });
    assert.equal(login.status, 401, "the refused sign-up made no account");

    clock.now += 60 * MINUTE;
    assert.equal((await signUp("rl_late")).status, 201);
  } finally {
    await close();
  }
});

test("X-Forwarded-For is only believed behind a trusted proxy; IPv6 is limited per /64", async () => {
  const tryFrom = (url: string, ip: string) =>
    client(url, { "X-Forwarded-For": ip }).request("POST", "/api/auth/login", {
      username: "nobody",
      password: "wrong!!",
    });

  // No proxy: a made-up header doesn't give anyone a fresh budget.
  const direct = await limitedServer({ loginPerIp: 2 });
  try {
    assert.equal((await tryFrom(direct.url, "203.0.113.1")).status, 401);
    assert.equal((await tryFrom(direct.url, "203.0.113.2")).status, 401);
    assert.equal((await tryFrom(direct.url, "203.0.113.3")).status, 429);
  } finally {
    await direct.close();
  }

  // Behind one proxy: each visitor has a budget of their own.
  const proxied = await limitedServer({ loginPerIp: 2 }, { trustProxy: 1 });
  try {
    assert.equal((await tryFrom(proxied.url, "203.0.113.1")).status, 401);
    assert.equal((await tryFrom(proxied.url, "203.0.113.1")).status, 401);
    assert.equal((await tryFrom(proxied.url, "203.0.113.1")).status, 429);
    assert.equal((await tryFrom(proxied.url, "203.0.113.2")).status, 401);

    // Addresses in the same /64 share a budget.
    assert.equal((await tryFrom(proxied.url, "2001:db8:1:2::1")).status, 401);
    assert.equal(
      (await tryFrom(proxied.url, "2001:db8:1:2:ffff::9")).status,
      401,
    );
    assert.equal((await tryFrom(proxied.url, "2001:db8:1:2::abcd")).status, 429);
    assert.equal((await tryFrom(proxied.url, "2001:db8:1:3::1")).status, 401);
  } finally {
    await proxied.close();
  }
});
