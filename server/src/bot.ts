import { randomBytes, randomInt, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import type { LinkPreview, Message, PublicUser } from "../../shared/types.js";
import { toPublicUser, type Db } from "./db.js";
import { findFirstUrl, type LinkPreviewFetcher } from "./linkPreview.js";
import type { Presence } from "./presence.js";
import {
  addLinkPreview,
  emitNewMessage,
  room,
  type ChatServer,
} from "./socket.js";
import type { ChatImageStorage } from "./storage.js";

/**
 * Natter Bot: a scripted account that shows demo visitors around. It answers
 * like a person would (it reads the message, types for a moment, then
 * replies), and each of its first answers shows off a different feature:
 * read receipts, link previews, reactions and replies, then a photo. After
 * the tour it keeps chatting with a pool of lines, never the same one twice
 * in a row. Nothing here calls an AI service, so it's free and predictable.
 */

/** Where the code lives. The bot links to it, which also shows off link previews. */
export const REPO_URL = "https://github.com/jhsui/natter-chat";

const BOT_BIO =
  "I show new visitors around Natter. I'm a bot, but a friendly one.";

// Works from both src/ and dist/, which both sit one level below server/.
const here = path.dirname(fileURLToPath(import.meta.url));
const PHOTO = {
  file: path.join(here, "..", "assets", "natter-bot-photo.webp"),
  width: 1200,
  height: 900,
};

/** How long the bot takes, in milliseconds. Tests set these close to 0. */
export interface BotTiming {
  /**
   * Quiet time after someone's last message before the bot answers, so a few
   * quick messages in a row get one answer instead of one each.
   */
  settle: number;
  /** From answering to marking the messages "Read". */
  read: number;
  /** How long "typing…" shows before a message, plus `perChar` per character. */
  typing: number;
  perChar: number;
  /** The longest to wait for a link's preview before talking about it. */
  previewWait: number;
}

export const DEFAULT_BOT_TIMING: BotTiming = {
  settle: 900,
  read: 500,
  typing: 900,
  perChar: 15,
  // Fetching a page gives up after 5 seconds (see linkPreview.ts).
  previewWait: 6000,
};

export interface Bot {
  user: PublicUser;
  /** Opens a chat with a new guest, so a first message is waiting for them. */
  welcome(guestId: number): Promise<void>;
  /** Someone connected; a guest who was just welcomed gets a follow-up, live. */
  connected(userId: number): void;
  /** Called with every new message; answers the ones sent to the bot. */
  receive(message: Message): void;
  /** Cancels anything scheduled (used when the server shuts down). */
  stop(): void;
}

/** Small talk for after the tour. A few lines point at features worth trying. */
const SMALL_TALK = [
  "Ha, good one 😄",
  "Tell me more!",
  "I'm only a bot, but I'm all ears 🤖",
  "Interesting! 🤔",
  "Try reacting to this message: hover over it, or on a phone, tap its smiley button.",
  "You can delete a message you sent for up to 2 days. It leaves a placeholder for both of us.",
  "You can paste a picture straight into the message box. It's resized in your browser before it's sent.",
  "Open your profile (your name at the bottom of the chat list) to set a display name and a photo.",
  "Natter keeps an unsent draft for each chat, so switching chats won't lose what you typed.",
  "If your connection drops, Natter reconnects by itself and catches up on anything you missed.",
  `Curious how I work? The code is on GitHub: ${REPO_URL}`,
];
const REACTIONS = ["👍", "😂", "❤️", "😮"];

/** Where one person is in the conversation with the bot. */
interface Chat {
  /** How far through the tour they are (see answer()). */
  step: number;
  /** True once link previews have been explained. */
  linkShown: boolean;
  /** The last small-talk line used, so the next one is different. */
  lastLine: number;
  /** Their newest message that hasn't been answered yet. */
  pending: Message | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** True while the bot is answering them. */
  busy: boolean;
}

/** Remembering this many conversations is plenty; older ones start over. */
const MAX_CHATS = 2000;

/**
 * Finds the Natter Bot account, creating it the first time. Nobody can sign
 * in as the bot: its password is random and never stored anywhere.
 */
async function ensureBotUser(db: Db): Promise<PublicUser> {
  const existing = await db.findBot();
  if (existing) return toPublicUser(existing);
  const hash = await bcrypt.hash(randomBytes(32).toString("hex"), 10);
  // "natter_bot" could in theory belong to a person already.
  for (const name of ["natter_bot", `natter_bot_${randomInt(1000, 10000)}`]) {
    const user = await db.createUser(name, hash, {
      bot: true,
      displayName: "Natter Bot",
      bio: BOT_BIO,
      // The app icon, served next to the app (client/public/favicon.svg).
      avatarUrl: "/favicon.svg",
    });
    if (user) return toPublicUser(user);
  }
  throw new Error("Couldn't create the Natter Bot account");
}

export async function createBot({
  db,
  io,
  presence,
  chatImageStorage,
  linkPreviews,
  timing: timingOverrides,
}: {
  db: Db;
  io: ChatServer;
  presence: Presence;
  chatImageStorage: ChatImageStorage | null;
  linkPreviews: LinkPreviewFetcher | null;
  timing?: Partial<BotTiming>;
}): Promise<Bot> {
  const timing = { ...DEFAULT_BOT_TIMING, ...timingOverrides };
  const me = await ensureBotUser(db);
  // The bot never opens a socket, so count it as connected once, for good:
  // it always shows as online.
  presence.connect(me.id);

  const chats = new Map<number, Chat>();
  /** Guests who were welcomed but haven't connected yet. */
  const awaitingArrival = new Set<number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;
  let photo: Promise<Buffer> | null = null;

  /** Waits, unless the server is shutting down. Resolves false if it is. */
  function pause(ms: number): Promise<boolean> {
    if (stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve(!stopped);
      }, ms);
      timers.add(timer);
    });
  }

  function chatWith(userId: number): Chat {
    let chat = chats.get(userId);
    if (chat) {
      // Move to the end, so the map stays in least-recently-used order.
      chats.delete(userId);
    } else {
      chat = {
        step: 0,
        linkShown: false,
        lastLine: -1,
        pending: null,
        timer: null,
        busy: false,
      };
      if (chats.size >= MAX_CHATS) {
        const oldest = chats.keys().next().value;
        if (oldest !== undefined) chats.delete(oldest);
      }
    }
    chats.set(userId, chat);
    return chat;
  }

  // ---- Things the bot can do, the same way a person's client would ---------

  async function markRead(userId: number) {
    const { changes, upToId } = await db.markRead(me.id, userId);
    if (changes > 0 && upToId !== null) {
      io.to(room(userId))
        .to(room(me.id))
        .emit("messages:read", { readerId: me.id, senderId: userId, upToId });
    }
  }

  function setTyping(userId: number, typing: boolean) {
    io.to(room(userId)).emit("typing", { from: me.id, typing });
  }

  /** Shows "typing…" for a moment, then sends `body`. */
  async function say(userId: number, body: string, replyToId?: number) {
    setTyping(userId, true);
    const typingFor = Math.min(
      timing.typing + body.length * timing.perChar,
      timing.typing * 2.5,
    );
    if (!(await pause(typingFor))) return;
    const message = await db.createMessage(me.id, userId, body, {
      replyToId,
    });
    // The new message also clears "typing…" on their side.
    emitNewMessage(io, message);
    void addLinkPreview(io, db, linkPreviews, message);
  }

  async function react(message: Message, emoji: string) {
    if (!(await pause(timing.read))) return;
    const result = await db.setReaction(message.id, me.id, emoji);
    if (!result) return; // they deleted it meanwhile
    io.to(room(result.senderId))
      .to(room(result.recipientId))
      .emit("message:reactions", {
        messageId: message.id,
        reactions: result.reactions,
      });
  }

  /**
   * Waits for the preview of the link in `message`, which is looked up right
   * after it's sent. Null if none turns up (the site shared no details, or it
   * took too long), so the bot never talks about a card that isn't there.
   */
  async function previewOf(
    userId: number,
    message: Message,
  ): Promise<LinkPreview | null> {
    const giveUpAt = Date.now() + timing.previewWait;
    for (;;) {
      const [current] = await db.getMessages(me.id, userId, {
        before: message.id + 1,
        limit: 1,
      });
      if (current?.id !== message.id) return null; // deleted meanwhile
      if (current.linkPreview) return current.linkPreview;
      if (Date.now() >= giveUpAt || !(await pause(250))) return null;
    }
  }

  /** Sends the bundled photo. False if pictures can't be sent on this server. */
  async function sendPhoto(userId: number): Promise<boolean> {
    if (!chatImageStorage) return false;
    setTyping(userId, true);
    try {
      photo ??= fs.readFile(PHOTO.file);
      const data = await photo;
      const key = `${me.id}/${randomUUID()}.webp`;
      await chatImageStorage.save(key, data, "image/webp");
      if (!(await pause(timing.typing))) return true;
      const message = await db.createMessage(me.id, userId, "", {
        image: { key, width: PHOTO.width, height: PHOTO.height },
      });
      emitNewMessage(io, message);
      return true;
    } catch (err) {
      photo = null; // try reading the file again next time
      console.error("Natter Bot couldn't send its photo", err);
      setTyping(userId, false);
      return false;
    }
  }

  // ---- The conversation -----------------------------------------------------

  /** Answers `message`, the newest of what `userId` sent since the last answer. */
  async function answer(userId: number, message: Message, chat: Chat) {
    if (!(await pause(timing.read))) return;
    await markRead(userId);

    // The first answer always explains what they just saw happen.
    if (chat.step === 0) {
      await say(
        userId,
        "Got it! 👀 Did you see your message switch to Read? That happened live, over a WebSocket.",
      );
      if (linkPreviews) {
        chat.step = 1;
        await say(userId, "Next, send me a link to any website.");
      } else {
        chat.step = 2; // link previews are turned off on this server
      }
      return;
    }

    if (message.image) {
      await react(message, "😍");
      await say(
        userId,
        "Nice photo! It's kept in a private bucket, so only the two of us can open it.",
        message.id,
      );
      return;
    }

    if (linkPreviews && findFirstUrl(message.body) && !chat.linkShown) {
      chat.linkShown = true;
      if (chat.step === 1) chat.step = 2;
      const preview = await previewOf(userId, message);
      await say(
        userId,
        preview
          ? "Nice! Natter looked up that page and built the preview card under your message."
          : "Natter tried to build a preview card for that link, but the site didn't share any details. News articles and YouTube videos usually work.",
        message.id,
      );
      return;
    }

    if (chat.step === 1) {
      // They skipped the link, so the bot sends one: previews work both ways.
      chat.step = 2;
      chat.linkShown = true;
      await say(
        userId,
        `No link handy? Here's one, the code behind Natter: ${REPO_URL}`,
      );
      return;
    }

    if (chat.step === 2) {
      chat.step = 3;
      await react(message, "❤️");
      await say(
        userId,
        "I just reacted to your message and replied to it. You can do both too: hover over a message, or on a phone, tap its smiley button.",
        message.id,
      );
      return;
    }

    if (chat.step === 3) {
      chat.step = 4;
      if (await sendPhoto(userId)) {
        await say(
          userId,
          "A photo from my last walk 🌲 Open it to see it full size.",
        );
        return;
      }
      // No picture storage on this server: go straight to the end of the tour.
    }

    if (chat.step === 4) {
      chat.step = 5;
      await say(
        userId,
        "That's the tour! 🎉 A few more things to try: switch between light and dark mode, open my profile from my name at the top of the chat, or open Natter in a second tab and watch it stay in sync.",
      );
      return;
    }

    // After the tour: small talk, with the odd reaction.
    if (randomInt(3) === 0) {
      await react(message, REACTIONS[randomInt(REACTIONS.length)]!);
    }
    let line: number;
    if (chat.lastLine < 0) {
      line = randomInt(SMALL_TALK.length);
    } else {
      // Pick from all the others: skip over the one used last time.
      line = randomInt(SMALL_TALK.length - 1);
      if (line >= chat.lastLine) line++;
    }
    chat.lastLine = line;
    await say(userId, SMALL_TALK[line]!);
  }

  /** Answers whatever `userId` has sent, one answer at a time. */
  async function run(userId: number) {
    const chat = chatWith(userId);
    chat.timer = null;
    if (chat.busy || !chat.pending || stopped) return;
    const message = chat.pending;
    chat.pending = null;
    chat.busy = true;
    try {
      await answer(userId, message, chat);
    } catch (err) {
      console.error("Natter Bot couldn't answer", err);
      setTyping(userId, false);
    } finally {
      chat.busy = false;
      // They wrote again while the bot was answering.
      if (chat.pending && !chat.timer) schedule(userId, chat);
    }
  }

  function schedule(userId: number, chat: Chat) {
    if (stopped) return;
    if (chat.timer) clearTimeout(chat.timer);
    const timer = setTimeout(() => {
      timers.delete(timer);
      void run(userId);
    }, timing.settle);
    timers.add(timer);
    chat.timer = timer;
  }

  return {
    user: me,

    async welcome(guestId) {
      const message = await db.createMessage(
        me.id,
        guestId,
        "Hey there! 👋 I'm Natter Bot. I'll give you a quick tour. Send me any message to start.",
      );
      emitNewMessage(io, message);
      awaitingArrival.add(guestId);
      // Forget guests who never show up, so the set can't grow forever.
      if (awaitingArrival.size > MAX_CHATS) {
        const oldest = awaitingArrival.values().next().value;
        if (oldest !== undefined) awaitingArrival.delete(oldest);
      }
    },

    connected(userId) {
      if (!awaitingArrival.delete(userId)) return;
      void (async () => {
        try {
          if (!(await pause(timing.settle))) return;
          await say(
            userId,
            "Tip: watch the line under your message. It changes from Sent to Read the moment I see it 👀",
          );
        } catch (err) {
          console.error("Natter Bot couldn't send its tip", err);
        }
      })();
    },

    receive(message) {
      if (message.recipientId !== me.id || message.senderId === me.id) return;
      const chat = chatWith(message.senderId);
      chat.pending = message;
      schedule(message.senderId, chat);
    },

    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
