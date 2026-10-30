import { randomUUID } from "node:crypto";
import express, {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type {
  ConversationsResponse,
  ErrorResponse,
  Message,
  MessageResponse,
  MessagesResponse,
  PeopleResponse,
  UsersResponse,
} from "../../../shared/types.js";
import { currentUser } from "../auth.js";
import { isValidId, toPublicUser, type Db } from "../db.js";
import type { Presence } from "../presence.js";
import { refuseIfLimited, type RateLimits } from "../rateLimit.js";
import {
  detectImageType,
  IMAGE_EXTENSIONS,
  type ChatImageStorage,
} from "../storage.js";

/** The browser shrinks pictures to fit before upload (see toChatImage in the client). */
export const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_IMAGE_SIDE = 8192;

/** True if `n` can be an image's width or height in pixels. */
const isValidSide = (n: number) =>
  Number.isInteger(n) && n >= 1 && n <= MAX_IMAGE_SIDE;

export function chatRoutes(
  db: Db,
  presence: Presence,
  storage: ChatImageStorage | null,
  /** Called with each message created here, to deliver it to connected clients. */
  onMessage: (message: Message) => void,
  /** How fast each user can send (pictures and texts); null for no limit. */
  limits: RateLimits | null,
): Router {
  const router = Router();

  // Find people to message: GET /api/users?q=ali
  router.get("/users", async (req: Request, res: Response<UsersResponse>) => {
    const q = String(req.query.q ?? "")
      .trim()
      .slice(0, 20);
    if (!q) {
      res.json({ users: [] });
      return;
    }
    const users = (await db.searchUsers(currentUser(req).id, q)).map((u) => ({
      ...u,
      online: presence.isOnline(u.id),
    }));
    res.json({ users });
  });

  // Every other user, for the "People" tab. The client sorts (online first),
  // since online status changes live.
  router.get("/people", async (req: Request, res: Response<PeopleResponse>) => {
    const people = (await db.listPeople(currentUser(req).id)).map((p) => ({
      ...p,
      online: presence.isOnline(p.id),
    }));
    res.json({ people });
  });

  // Everyone the current user has exchanged messages with, newest first.
  router.get(
    "/conversations",
    async (req: Request, res: Response<ConversationsResponse>) => {
      const conversations = (
        await db.getConversations(currentUser(req).id)
      ).map((c) => ({ ...c, online: presence.isOnline(c.id) }));
      res.json({ conversations });
    },
  );

  // Message history with one user: GET /api/messages/42?before=123&limit=50
  router.get(
    "/messages/:userId",
    async (req: Request, res: Response<MessagesResponse | ErrorResponse>) => {
      const otherId = Number(req.params.userId);
      const other = isValidId(otherId)
        ? await db.findUserById(otherId)
        : undefined;
      if (!other) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
      const beforeId = Number(req.query.before);
      const before = isValidId(beforeId) ? beforeId : undefined;
      const messages = await db.getMessages(currentUser(req).id, otherId, {
        before,
        limit,
      });

      res.json({
        user: { ...toPublicUser(other), online: presence.isOnline(other.id) },
        messages,
        hasMore: messages.length === limit,
      });
    },
  );

  // Send a picture: POST /api/messages/42/image?width=800&height=600 with the
  // image bytes as the body. Add &replyTo=123 to send it as a reply. Text messages go over the socket instead; images
  // use HTTP because they're big and need a size limit and upload errors.
  router.post(
    "/messages/:userId/image",
    // Counted before the upload is read, so a refused one is never kept in
    // memory (Node still receives the bytes, and throws them away).
    // Pictures and texts share the sender's budget (see socket.ts).
    (req: Request, res: Response<ErrorResponse>, next: NextFunction) => {
      const result = limits?.hitMessage(currentUser(req).id);
      if (result && refuseIfLimited(res, result, "messages")) return;
      next();
    },
    express.raw({ type: "image/*", limit: MAX_IMAGE_BYTES }),
    async (req: Request, res: Response<MessageResponse | ErrorResponse>) => {
      if (!storage) {
        res.status(503).json({
          error:
            "Sending images isn't set up on this server yet (Supabase Storage isn't configured).",
        });
        return;
      }
      const me = currentUser(req);
      const to = Number(req.params.userId);
      if (to === me.id) {
        res.status(400).json({ error: "You can't message yourself" });
        return;
      }
      if (!isValidId(to) || !(await db.findUserById(to))) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      // The client reports the size. It's only used to lay out the chat before
      // the file loads, so a wrong value can't do more than misshape a bubble.
      const width = Number(req.query.width);
      const height = Number(req.query.height);
      if (!isValidSide(width) || !isValidSide(height)) {
        res.status(400).json({ error: "Invalid image size" });
        return;
      }
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const type = detectImageType(data);
      if (!type) {
        res
          .status(400)
          .json({ error: "Please send a PNG, JPEG or WebP image" });
        return;
      }

      const key = `${me.id}/${randomUUID()}.${IMAGE_EXTENSIONS[type]}`;
      try {
        await storage.save(key, data, type);
      } catch (err) {
        console.error(err);
        res
          .status(502)
          .json({ error: "Couldn't upload the image. Please try again." });
        return;
      }

      let message: Message;
      try {
        const replyToId = Number(req.query.replyTo);
        message = await db.createMessage(me.id, to, "", {
          image: { key, width, height },
          replyToId: isValidId(replyToId) ? replyToId : undefined,
        });
      } catch (err) {
        // Don't leave a file behind that no message points to.
        storage
          .remove(key)
          .catch((e) => console.error("Couldn't delete image", key, e));
        throw err;
      }
      onMessage(message);
      res.status(201).json({ message });
    },
  );

  // A message's picture: GET /api/images/123. The files are in a private
  // bucket, so this is the only way to get one, and it's only served to the
  // sender and the recipient. <img> tags send the login cookie automatically.
  router.get("/images/:messageId", async (req: Request, res: Response) => {
    const messageId = Number(req.params.messageId);
    const image = isValidId(messageId)
      ? await db.findMessageImage(messageId)
      : undefined;
    const me = currentUser(req).id;
    // Same reply whether it doesn't exist or isn't yours, so ids can't be probed.
    if (!image || (image.senderId !== me && image.recipientId !== me)) {
      res.status(404).json({ error: "Image not found" });
      return;
    }
    if (!storage) {
      res.status(503).json({ error: "Image storage isn't configured" });
      return;
    }

    let data: Buffer;
    try {
      data = await storage.read(image.key);
    } catch (err) {
      console.error(err);
      res.status(502).json({ error: "Couldn't load the image" });
      return;
    }
    res.set({
      "Content-Type": detectImageType(data) ?? "application/octet-stream",
      // A message's picture never changes, so the browser can keep its copy;
      // "private" stops shared caches (proxies, CDNs) from keeping one too.
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    });
    res.send(data);
  });

  return router;
}
