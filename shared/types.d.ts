/**
 * Types shared by the server and the client. This is a declaration-only file
 * (no runtime code), so both sides can `import type` from it.
 */

export interface PublicUser {
  id: number;
  /** Unique, used to sign in and to search. */
  username: string;
  /** Optional name shown instead of the username. */
  displayName: string | null;
  /** Public URL of the profile picture, or null to show the initial instead. */
  avatarUrl: string | null;
}

export interface UserWithPresence extends PublicUser {
  online: boolean;
}

/** A picture sent in a chat. */
export interface MessageImage {
  /**
   * Where to load the file from: a path on this server (/api/images/…), which
   * only serves it to the two people in the conversation.
   */
  url: string;
  /** Size in pixels, so the chat can reserve space before the file has loaded. */
  width: number;
  height: number;
}

/** The message a reply quotes: just enough to show a preview of it above the reply. */
export interface ReplyPreview {
  id: number;
  senderId: number;
  /** The quoted text, cut off after 200 characters; "" for an image. */
  body: string;
  /** Where to load the picture from, if the quoted message is an image. */
  imageUrl: string | null;
  /** True if the quoted message has since been deleted (then body is "" and imageUrl null). */
  deleted: boolean;
}

/** A summary of the web page a message links to, shown as a card under it. */
export interface LinkPreview {
  /** The link, as it appears in the message. */
  url: string;
  title: string;
  description: string | null;
  /** A picture for the page, on the page's own site (not ours). */
  imageUrl: string | null;
  /** The site's name, e.g. "YouTube". */
  siteName: string | null;
}

/** One person's reaction to a message. Each person has at most one per message. */
export interface Reaction {
  userId: number;
  /** A single emoji, e.g. "👍". */
  emoji: string;
}

export interface Message {
  id: number;
  senderId: number;
  recipientId: number;
  /** The text; "" for an image message. */
  body: string;
  /** The picture, for an image message; null for a text message. */
  image: MessageImage | null;
  /** The earlier message in this conversation that this one replies to, if any. */
  replyTo: ReplyPreview | null;
  /**
   * Preview of the first link in the text, if it has one. It's looked up after
   * the message is sent, so it arrives a moment later (see "message:preview").
   */
  linkPreview: LinkPreview | null;
  /** Oldest first. */
  reactions: Reaction[];
  /**
   * ISO 8601 timestamp of when the sender deleted the message, or null. A
   * deleted message keeps its place in the chat but has nothing in it: body is
   * "", image, replyTo and linkPreview are null, and reactions is empty.
   */
  deletedAt: string | null;
  /** ISO 8601 timestamp */
  createdAt: string;
  /** ISO 8601 timestamp, or null while unread */
  readAt: string | null;
}

/** Everything shown on a profile page. */
export interface Profile extends UserWithPresence {
  /** Short "about me", up to 160 characters. */
  bio: string | null;
  /** ISO timestamp of when the account was created. */
  createdAt: string;
}

/** An entry in the "People" tab: any other user, with when you last chatted. */
export interface Person extends UserWithPresence {
  /** ISO timestamp of the latest message between you, or null if you've never chatted. */
  lastAt: string | null;
}

export interface Conversation extends UserWithPresence {
  lastBody: string;
  /** True if the latest message is a picture (then lastBody is ""). */
  lastIsImage: boolean;
  /** True if the latest message was deleted (then lastBody is ""). */
  lastIsDeleted: boolean;
  lastSenderId: number;
  lastAt: string;
  unread: number;
}

// ---- REST API responses ----------------------------------------------------

export interface AuthResponse {
  user: PublicUser;
  /** True for a temporary demo account (see DemoResponse). */
  guest?: boolean;
}

/** Reply to starting the demo: a new guest account, already signed in. */
export interface DemoResponse extends AuthResponse {
  guest: true;
  /** Natter Bot, who is waiting in a chat with the guest. */
  bot: PublicUser;
}

export interface ProfileResponse {
  profile: Profile;
}

export interface UsersResponse {
  users: UserWithPresence[];
}

export interface PeopleResponse {
  people: Person[];
}

export interface ConversationsResponse {
  conversations: Conversation[];
}

export interface MessagesResponse {
  user: UserWithPresence;
  messages: Message[];
  hasMore: boolean;
}

/** Reply to sending an image message. */
export interface MessageResponse {
  message: Message;
}

export interface ErrorResponse {
  error: string;
  /** With a 429 (too many attempts): how many seconds to wait before trying again. */
  retryAfterSeconds?: number;
}

// ---- Socket.IO events --------------------------------------------------------

export type SendMessageAck =
  | { ok: true; message: Message }
  // retryAfterSeconds: when sending too fast, how many seconds to wait.
  | { ok?: false; error: string; retryAfterSeconds?: number };

export type Ack = { ok: true } | { ok?: false; error: string };

export interface ClientToServerEvents {
  "message:send": (
    // replyTo: id of the message being replied to (optional).
    payload: { to: number; body: string; replyTo?: number },
    ack: (res: SendMessageAck) => void,
  ) => void;
  typing: (payload: { to: number; typing: boolean }) => void;
  "messages:read": (payload: { from: number }) => void;
  /** Deletes a message I sent, for both people. It can't be undone. */
  "message:delete": (
    payload: { messageId: number },
    ack: (res: Ack) => void,
  ) => void;
  /** Sets my reaction to a message, replacing any earlier one; null removes it. */
  "message:react": (
    payload: { messageId: number; emoji: string | null },
    ack: (res: Ack) => void,
  ) => void;
}

export interface ServerToClientEvents {
  "message:new": (message: Message) => void;
  typing: (payload: { from: number; typing: boolean }) => void;
  "messages:read": (payload: {
    readerId: number;
    senderId: number;
    upToId: number;
  }) => void;
  /** The preview for a link in a message that was sent a moment ago is ready. */
  "message:preview": (payload: {
    messageId: number;
    preview: LinkPreview;
  }) => void;
  /** A message was deleted; this is what's left of it (see Message.deletedAt). */
  "message:deleted": (message: Message) => void;
  /** A message's reactions changed; this is the complete new list. */
  "message:reactions": (payload: {
    messageId: number;
    reactions: Reaction[];
  }) => void;
  presence: (payload: { userId: number; online: boolean }) => void;
  /** Someone changed their display name or avatar. */
  "profile:updated": (user: PublicUser) => void;
}
