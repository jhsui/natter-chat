import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { parse as parseCookie } from "cookie";
import type {
  ClientToServerEvents,
  Message,
  PublicUser,
  ServerToClientEvents,
} from "../../shared/types.js";
import { COOKIE_NAME, verifyToken } from "./auth.js";
import { isValidId, toPublicUser, type Db } from "./db.js";
import { findFirstUrl, type LinkPreviewFetcher } from "./linkPreview.js";
import type { Presence } from "./presence.js";
import type { ChatImageStorage } from "./storage.js";

const MAX_MESSAGE_LENGTH = 2000;
/** How long after sending a message its sender can still delete it. */
export const DELETE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * True if `value` is exactly one emoji, so a reaction can't be used to attach
 * arbitrary text to a message. One emoji can be several characters joined
 * together (a flag, 👍🏽, 👨‍👩‍👧), which is what the grapheme check allows for.
 */
function isSingleEmoji(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 40)
    return false;
  if ([...graphemes.segment(value)].length !== 1) return false;
  // A pictograph, a flag letter, or a keycap (as in 1️⃣).
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u.test(value);
}
/** The Socket.IO room holding every open tab of one user. */
export const room = (userId: number) => `user:${userId}`;

/** Data attached to each socket after the handshake is authenticated. */
interface SocketData {
  user: PublicUser;
}

export type ChatServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

/** Delivers a new message to every open tab of both people in the conversation. */
export function emitNewMessage(io: ChatServer, message: Message): void {
  io.to(room(message.recipientId))
    .to(room(message.senderId))
    .emit("message:new", message);
}

/**
 * If a message has a link in it, looks up the link's preview and tells both
 * people once it's ready. Call it after the message has been delivered, so a
 * slow website never holds up a message.
 */
export async function addLinkPreview(
  io: ChatServer,
  db: Db,
  linkPreviews: LinkPreviewFetcher | null | undefined,
  message: Message,
): Promise<void> {
  const url = linkPreviews && findFirstUrl(message.body);
  if (!url) return;
  try {
    const preview = await linkPreviews(url);
    if (!preview || !(await db.setLinkPreview(message.id, preview))) return;
    io.to(room(message.recipientId))
      .to(room(message.senderId))
      .emit("message:preview", { messageId: message.id, preview });
  } catch (err) {
    console.error("Couldn't add a link preview", err);
  }
}

/**
 * Real-time layer. Every connected socket joins a private room named after
 * its user, so sending to `user:42` reaches all of user 42's open tabs.
 */
export function attachSocket(
  httpServer: HttpServer,
  db: Db,
  presence: Presence,
  {
    corsOrigin,
    chatImageStorage,
    linkPreviews,
    onMessage,
    onConnect,
  }: {
    corsOrigin?: string;
    /** Where chat pictures are kept, so a deleted message's file can be removed. */
    chatImageStorage?: ChatImageStorage | null;
    /** Looks up previews for links in messages; leave out to turn previews off. */
    linkPreviews?: LinkPreviewFetcher | null;
    /** Called with each text message after it has been delivered (Natter Bot listens here). */
    onMessage?: (message: Message) => void;
    /** Called when a user opens a connection. */
    onConnect?: (user: PublicUser) => void;
  } = {},
): ChatServer {
  const io: ChatServer = new Server(httpServer, {
    cors: corsOrigin ? { origin: corsOrigin, credentials: true } : undefined,
  });

  // Authenticate the handshake with the same httpOnly cookie the REST API uses.
  io.use(async (socket, next) => {
    try {
      const cookies = parseCookie(socket.handshake.headers.cookie ?? "");
      const userId = verifyToken(cookies[COOKIE_NAME]);
      const user = userId === null ? undefined : await db.findUserById(userId);
      if (!user) return next(new Error("unauthorized"));
      socket.data.user = toPublicUser(user);
      next();
    } catch (err) {
      console.error(err);
      next(new Error("server error"));
    }
  });

  io.on("connection", (socket) => {
    const me = socket.data.user;
    socket.join(room(me.id));
    if (presence.connect(me.id)) {
      socket.broadcast.emit("presence", { userId: me.id, online: true });
    }
    onConnect?.(me);

    // Database calls are async, so a fast typer's messages could finish out of
    // order. Chaining them per socket keeps each sender's messages in order.
    let sendQueue = Promise.resolve();

    // Payloads come from the network, so validate them even though they're typed.
    socket.on("message:send", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      sendQueue = sendQueue.then(async () => {
        const to = Number(payload?.to);
        const body =
          typeof payload?.body === "string" ? payload.body.trim() : "";
        const replyToId = Number(payload?.replyTo);

        if (!body) return reply({ error: "Message is empty" });
        if (body.length > MAX_MESSAGE_LENGTH)
          return reply({ error: "Message is too long" });
        if (to === me.id) return reply({ error: "You can't message yourself" });
        if (!isValidId(to) || !(await db.findUserById(to)))
          return reply({ error: "User not found" });

        try {
          const message = await db.createMessage(me.id, to, body, {
            replyToId: isValidId(replyToId) ? replyToId : undefined,
          });
          emitNewMessage(io, message);
          reply({ ok: true, message });
          void addLinkPreview(io, db, linkPreviews, message);
          onMessage?.(message);
        } catch (err) {
          console.error(err);
          reply({ error: "Couldn't send the message. Try again." });
        }
      });
    });

    socket.on("typing", (payload) => {
      const to = Number(payload?.to);
      if (!isValidId(to) || to === me.id) return;
      socket
        .to(room(to))
        .emit("typing", { from: me.id, typing: Boolean(payload?.typing) });
    });

    socket.on("messages:read", async (payload) => {
      const from = Number(payload?.from);
      if (!isValidId(from)) return;
      try {
        const { changes, upToId } = await db.markRead(me.id, from);
        if (changes > 0 && upToId !== null) {
          io.to(room(from))
            .to(room(me.id))
            .emit("messages:read", { readerId: me.id, senderId: from, upToId });
        }
      } catch (err) {
        console.error(err);
      }
    });

    socket.on("message:delete", async (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const messageId = Number(payload?.messageId);
      try {
        const result = isValidId(messageId)
          ? await db.deleteMessage(messageId, me.id, DELETE_WINDOW_MS)
          : null;
        // Also the answer for someone else's message, or one already deleted.
        if (!result) return reply({ error: "Message not found" });
        if (result === "expired") {
          return reply({
            error: "Messages can only be deleted for 2 days after they're sent",
          });
        }
        const { message, imageKey } = result;
        if (imageKey) {
          // The message is already gone for both people; a file that can't be
          // removed right now shouldn't turn that into an error.
          chatImageStorage
            ?.remove(imageKey)
            .catch((e) => console.error("Couldn't delete image", imageKey, e));
        }
        io.to(room(message.recipientId))
          .to(room(message.senderId))
          .emit("message:deleted", message);
        reply({ ok: true });
      } catch (err) {
        console.error(err);
        reply({ error: "Couldn't delete the message. Try again." });
      }
    });

    socket.on("message:react", async (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const messageId = Number(payload?.messageId);
      const emoji = payload?.emoji ?? null;
      if (emoji !== null && !isSingleEmoji(emoji))
        return reply({ error: "A reaction has to be a single emoji" });
      try {
        const result = isValidId(messageId)
          ? await db.setReaction(messageId, me.id, emoji)
          : null;
        if (!result) return reply({ error: "Message not found" });
        io.to(room(result.senderId))
          .to(room(result.recipientId))
          .emit("message:reactions", {
            messageId,
            reactions: result.reactions,
          });
        reply({ ok: true });
      } catch (err) {
        console.error(err);
        reply({ error: "Couldn't save the reaction. Try again." });
      }
    });

    socket.on("disconnect", () => {
      if (presence.disconnect(me.id)) {
        socket.broadcast.emit("presence", { userId: me.id, online: false });
      }
    });
  });

  return io;
}
