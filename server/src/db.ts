import fs from "node:fs";
import pg from "pg";
import type {
  LinkPreview,
  Message,
  Profile,
  PublicUser,
  Reaction,
} from "../../shared/types.js";

/**
 * Where the data lives:
 * - `databaseUrl`: a real PostgreSQL server (Railway, Docker, Postgres.app, …)
 * - `pgliteDir`: PGlite, real Postgres compiled to WebAssembly and running inside
 *   this Node process, stored in a folder. Pass "memory://" for a throwaway
 *   database (used by the tests). No install needed.
 * Both run the exact same SQL below.
 */
export type DbConfig = { databaseUrl: string } | { pgliteDir: string };

// IDs are INTEGER rather than BIGINT on purpose: node-postgres returns BIGINT
// (and COUNT(*)) as strings to avoid precision loss, INTEGER comes back as a number.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username      TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Usernames are unique regardless of case: "Bob" and "bob" are the same person.
  CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));

  CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sender_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body         TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at      TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS messages_pair_idx ON messages (sender_id, recipient_id, id);
  CREATE INDEX IF NOT EXISTS messages_unread_idx ON messages (recipient_id, sender_id) WHERE read_at IS NULL;

  -- Profile columns, added after the first version. "ADD COLUMN IF NOT EXISTS"
  -- upgrades databases created before they existed: a tiny hand-written
  -- migration. Bigger schema changes would call for a real migration tool.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
  -- Where the avatar lives in storage, so the old file can be deleted when it's replaced.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_key TEXT;

  -- Image messages: where the picture lives in (private) storage, and its
  -- pixel size. body is '' for these.
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_key TEXT;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_width INTEGER;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_height INTEGER;

  -- Replies: the earlier message this one quotes.
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER
    REFERENCES messages(id) ON DELETE SET NULL;

  -- Deleting a message empties it (text, image, reply link, reactions) but keeps
  -- the row, so the chat can show "This message was deleted" in its place.
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

  -- Preview (title, description, picture) of the first link in the text.
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS link_preview JSONB;

  -- Emoji reactions. The primary key allows one per person per message.
  CREATE TABLE IF NOT EXISTS reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id)
  );

  -- The demo: temporary guest accounts (deleted after a day, see demo.ts) and
  -- the Natter Bot account that shows them around (bot.ts).
  ALTER TABLE users ADD COLUMN IF NOT EXISTS is_guest BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT false;
  CREATE INDEX IF NOT EXISTS users_guest_idx ON users (created_at) WHERE is_guest;
`;

/** The public user fields, for a query where the users table is aliased as "u". */
const USER_COLUMNS = `
  u.id, u.username, u.display_name AS "displayName", u.avatar_url AS "avatarUrl"
`;

/** A message's reactions as a JSON array, oldest first ([] if none). $1 or a column: the message id. */
const reactionsOf = (messageId: string) => `
  COALESCE((
    SELECT json_agg(json_build_object('userId', x.user_id, 'emoji', x.emoji) ORDER BY x.created_at)
    FROM reactions x WHERE x.message_id = ${messageId}
  ), '[]'::json)
`;

/**
 * A message's fields, for a query where the message is "m" and the message it
 * replies to is joined as "r" (see REPLY_JOIN). Only a preview of the quoted
 * message is read: its text is cut off after 200 characters.
 */
const MESSAGE_COLUMNS = `
  ${reactionsOf("m.id")} AS reactions,
  m.id, m.sender_id AS "senderId", m.recipient_id AS "recipientId", m.body,
  m.created_at AS "createdAt", m.read_at AS "readAt", m.deleted_at AS "deletedAt",
  m.link_preview AS "linkPreview",
  (m.image_key IS NOT NULL) AS "hasImage", m.image_width AS "imageWidth", m.image_height AS "imageHeight",
  r.id AS "replyId", r.sender_id AS "replySenderId", left(r.body, 200) AS "replyBody",
  (r.image_key IS NOT NULL) AS "replyHasImage", (r.deleted_at IS NOT NULL) AS "replyDeleted"
`;
const REPLY_JOIN = `LEFT JOIN messages r ON r.id = m.reply_to_id`;

/** A user's profile as stored, before online status is added. */
export type ProfileRow = Omit<Profile, "online">;

export interface UserWithPassword extends PublicUser {
  passwordHash: string;
}

/** A conversation as stored, before presence info is added. */
export interface ConversationRow extends PublicUser {
  lastBody: string;
  lastIsImage: boolean;
  lastIsDeleted: boolean;
  lastSenderId: number;
  lastAt: string;
  unread: number;
}

/** Extra fields for accounts the server makes itself (see createUser). */
export interface NewUserOptions {
  /** A temporary demo account: hidden from other people, deleted after a day. */
  guest?: boolean;
  /** The Natter Bot account. */
  bot?: boolean;
  displayName?: string;
  bio?: string;
  avatarUrl?: string;
}

/** The storage files of guests that were just deleted, to be removed too. */
export interface DeletedGuests {
  count: number;
  avatarKeys: string[];
  imageKeys: string[];
}

export interface Db {
  close(): Promise<void>;
  /** Returns null if the username is already taken. */
  createUser(
    username: string,
    passwordHash: string,
    options?: NewUserOptions,
  ): Promise<ProfileRow | null>;
  findUserById(id: number): Promise<ProfileRow | undefined>;
  /** The Natter Bot account, if it has been created. */
  findBot(): Promise<ProfileRow | undefined>;
  isGuest(id: number): Promise<boolean>;
  countGuests(): Promise<number>;
  /**
   * Deletes guest accounts older than `maxAgeMs`, with their messages and
   * reactions. Returns the storage keys of their avatars and of the pictures in
   * their conversations, so those files can be removed as well.
   */
  deleteExpiredGuests(maxAgeMs: number): Promise<DeletedGuests>;
  updateProfile(
    id: number,
    fields: { displayName: string | null; bio: string | null },
  ): Promise<ProfileRow>;
  /**
   * Sets (or clears, with nulls) the avatar. Returns the updated profile and
   * the storage key of the previous avatar, so its file can be deleted.
   */
  setAvatar(
    id: number,
    avatar: { url: string; key: string } | null,
  ): Promise<{ profile: ProfileRow; previousKey: string | null }>;
  findUserByUsername(username: string): Promise<UserWithPassword | undefined>;
  /** Finds people by username or display name. Guests are left out. */
  searchUsers(me: number, query: string): Promise<PublicUser[]>;
  /** Every user except `me` and guests, with the time of your latest message together (or null). */
  listPeople(me: number): Promise<(PublicUser & { lastAt: string | null })[]>;
  /**
   * Pass `image` (already uploaded to storage under `key`) for an image
   * message. `replyToId` is the message being replied to; it's ignored unless
   * that message is in the same conversation.
   */
  createMessage(
    senderId: number,
    recipientId: number,
    body: string,
    options?: {
      image?: { key: string; width: number; height: number };
      replyToId?: number;
    },
  ): Promise<Message>;
  /** Where a message's picture is stored and who may see it; undefined if it has none. */
  findMessageImage(
    messageId: number,
  ): Promise<
    { key: string; senderId: number; recipientId: number } | undefined
  >;
  /** Returns up to `limit` messages older than `before`, oldest first. */
  getMessages(
    a: number,
    b: number,
    options?: { before?: number; limit?: number },
  ): Promise<Message[]>;
  getConversations(me: number): Promise<ConversationRow[]>;
  /** Saves the preview of a message's link. False if the message is gone (deleted meanwhile). */
  setLinkPreview(messageId: number, preview: LinkPreview): Promise<boolean>;
  /**
   * Deletes a message for both people: empties it and removes its reactions,
   * leaving a placeholder. Only its sender can, and only until the message is
   * `maxAgeMs` old. Returns what's left, plus the storage key of its picture
   * (if it had one) so the file can be removed; "expired" if it's too old; or
   * null if `userId` has no such message to delete.
   */
  deleteMessage(
    messageId: number,
    userId: number,
    maxAgeMs: number,
  ): Promise<{ message: Message; imageKey: string | null } | "expired" | null>;
  /**
   * Sets (or with null, removes) `userId`'s reaction to a message. Returns the
   * message's two participants and its reactions afterwards, or null if there
   * is no such message in one of `userId`'s conversations.
   */
  setReaction(
    messageId: number,
    userId: number,
    emoji: string | null,
  ): Promise<{
    senderId: number;
    recipientId: number;
    reactions: Reaction[];
  } | null>;
  /** Marks everything `other` sent to `me` as read. */
  markRead(
    me: number,
    other: number,
  ): Promise<{ changes: number; upToId: number | null }>;
}

/**
 * The URL clients load a message's picture from. The file itself is private,
 * so this points at our own API (see routes/chat.ts), not at storage.
 */
export const messageImagePath = (messageId: number) =>
  `/api/images/${messageId}`;

/** Picks just the public fields, e.g. to send a user to other clients. */
export function toPublicUser({
  id,
  username,
  displayName,
  avatarUrl,
}: PublicUser): PublicUser {
  return { id, username, displayName, avatarUrl };
}

/** True if `n` can be a row id (a positive Postgres INTEGER). Use it on ids that come from the network. */
export function isValidId(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n <= 2_147_483_647;
}

// ---- Connecting -------------------------------------------------------------

/** The small slice of a Postgres client this file needs, so pg and PGlite are interchangeable. */
interface Sql {
  query<T>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }>;
  /** Runs one or more statements without parameters (used for the schema). */
  exec(text: string): Promise<void>;
  close(): Promise<void>;
}

async function connectPostgres(databaseUrl: string): Promise<Sql> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  await pool.query("SELECT 1"); // fail fast with a clear error if the server is unreachable
  return {
    async query<T>(text: string, params?: unknown[]) {
      const result = await pool.query(text, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    },
    async exec(text) {
      await pool.query(text);
    },
    close: () => pool.end(),
  };
}

async function connectPglite(dir: string): Promise<Sql> {
  // Loaded only when needed, so production (DATABASE_URL set) never loads the WebAssembly build.
  const { PGlite } = await import("@electric-sql/pglite");
  if (!dir.startsWith("memory://")) fs.mkdirSync(dir, { recursive: true });
  const db = await PGlite.create(dir);
  return {
    async query<T>(text: string, params?: unknown[]) {
      const result = await db.query<T>(text, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
    },
    async exec(text) {
      await db.exec(text);
    },
    close: () => db.close(),
  };
}

// ---- Row mapping ------------------------------------------------------------

// Postgres returns TIMESTAMPTZ columns as JS Dates; the API sends ISO strings.
const iso = (value: Date | string) => new Date(value).toISOString();
const isoOrNull = (value: Date | string | null) =>
  value === null ? null : iso(value);

type MessageRow = Omit<
  Message,
  "createdAt" | "readAt" | "deletedAt" | "image" | "replyTo"
> & {
  createdAt: Date;
  readAt: Date | null;
  deletedAt: Date | null;
  hasImage: boolean;
  imageWidth: number | null;
  imageHeight: number | null;
  // All null when the message isn't a reply.
  replyId: number | null;
  replySenderId: number | null;
  replyBody: string | null;
  replyHasImage: boolean | null;
  replyDeleted: boolean | null;
};
const toMessage = ({
  hasImage,
  imageWidth,
  imageHeight,
  replyId,
  replySenderId,
  replyBody,
  replyHasImage,
  replyDeleted,
  ...row
}: MessageRow): Message => ({
  ...row,
  createdAt: iso(row.createdAt),
  readAt: isoOrNull(row.readAt),
  deletedAt: isoOrNull(row.deletedAt),
  image: hasImage
    ? {
        url: messageImagePath(row.id),
        width: imageWidth ?? 0,
        height: imageHeight ?? 0,
      }
    : null,
  replyTo:
    replyId === null
      ? null
      : {
          id: replyId,
          senderId: replySenderId ?? 0,
          body: replyBody ?? "",
          imageUrl: replyHasImage ? messageImagePath(replyId) : null,
          deleted: Boolean(replyDeleted),
        },
});

type ProfileRowRaw = Omit<ProfileRow, "createdAt"> & { createdAt: Date };
const toProfile = (row: ProfileRowRaw): ProfileRow => ({
  ...row,
  createdAt: iso(row.createdAt),
});
const PROFILE_COLUMNS = `${USER_COLUMNS}, u.bio, u.created_at AS "createdAt"`;

// ---- Queries ----------------------------------------------------------------

/**
 * Connects to the database, creates the tables if they don't exist yet, and
 * returns a small data-access layer.
 */
export async function openDb(config: DbConfig): Promise<Db> {
  const sql =
    "databaseUrl" in config
      ? await connectPostgres(config.databaseUrl)
      : await connectPglite(config.pgliteDir);
  await sql.exec(SCHEMA);

  return {
    close: () => sql.close(),

    async createUser(username, passwordHash, options = {}) {
      // ON CONFLICT covers the race where two people grab the same name at once.
      const { rows } = await sql.query<ProfileRowRaw>(
        `INSERT INTO users AS u
           (username, password_hash, is_guest, is_bot, display_name, bio, avatar_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT ((lower(username))) DO NOTHING
         RETURNING ${PROFILE_COLUMNS}`,
        [
          username,
          passwordHash,
          options.guest ?? false,
          options.bot ?? false,
          options.displayName ?? null,
          options.bio ?? null,
          options.avatarUrl ?? null,
        ],
      );
      return rows[0] ? toProfile(rows[0]) : null;
    },

    async findUserById(id) {
      const { rows } = await sql.query<ProfileRowRaw>(
        `SELECT ${PROFILE_COLUMNS} FROM users u WHERE u.id = $1`,
        [id],
      );
      return rows[0] && toProfile(rows[0]);
    },

    async findBot() {
      const { rows } = await sql.query<ProfileRowRaw>(
        `SELECT ${PROFILE_COLUMNS} FROM users u WHERE u.is_bot ORDER BY u.id LIMIT 1`,
      );
      return rows[0] && toProfile(rows[0]);
    },

    async isGuest(id) {
      const { rows } = await sql.query<{ isGuest: boolean }>(
        `SELECT is_guest AS "isGuest" FROM users WHERE id = $1`,
        [id],
      );
      return rows[0]?.isGuest ?? false;
    },

    async countGuests() {
      const { rows } = await sql.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM users WHERE is_guest`,
      );
      return rows[0]?.n ?? 0;
    },

    async deleteExpiredGuests(maxAgeMs) {
      // Pick the accounts once, so every step below works on the same ones.
      const { rows: guests } = await sql.query<{
        id: number;
        avatarKey: string | null;
      }>(
        `SELECT id, avatar_key AS "avatarKey" FROM users
         WHERE is_guest AND created_at < now() - make_interval(secs => $1)`,
        [maxAgeMs / 1000],
      );
      if (guests.length === 0)
        return { count: 0, avatarKeys: [], imageKeys: [] };
      const ids = guests.map((g) => g.id);

      // Read the picture keys before deleting: deleting the users cascades to
      // their messages, which takes the keys with them.
      const { rows: images } = await sql.query<{ key: string }>(
        `SELECT image_key AS key FROM messages
         WHERE image_key IS NOT NULL
           AND (sender_id = ANY($1::int[]) OR recipient_id = ANY($1::int[]))`,
        [ids],
      );
      const { rowCount } = await sql.query(
        `DELETE FROM users WHERE id = ANY($1::int[])`,
        [ids],
      );
      return {
        count: rowCount,
        avatarKeys: guests.flatMap((g) => (g.avatarKey ? [g.avatarKey] : [])),
        imageKeys: images.map((r) => r.key),
      };
    },

    async updateProfile(id, { displayName, bio }) {
      const { rows } = await sql.query<ProfileRowRaw>(
        `UPDATE users u SET display_name = $2, bio = $3 WHERE u.id = $1
         RETURNING ${PROFILE_COLUMNS}`,
        [id, displayName, bio],
      );
      return toProfile(rows[0]!);
    },

    async setAvatar(id, avatar) {
      // The CTE reads the old key from before the update, in the same statement.
      const { rows } = await sql.query<
        ProfileRowRaw & { previousKey: string | null }
      >(
        `WITH old AS (SELECT avatar_key FROM users WHERE id = $1)
         UPDATE users u SET avatar_url = $2, avatar_key = $3 WHERE u.id = $1
         RETURNING ${PROFILE_COLUMNS}, (SELECT avatar_key FROM old) AS "previousKey"`,
        [id, avatar?.url ?? null, avatar?.key ?? null],
      );
      const { previousKey, ...profile } = rows[0]!;
      return { profile: toProfile(profile), previousKey };
    },

    async findUserByUsername(username) {
      const { rows } = await sql.query<UserWithPassword>(
        `SELECT ${USER_COLUMNS}, u.password_hash AS "passwordHash"
         FROM users u WHERE lower(u.username) = lower($1)`,
        [username],
      );
      return rows[0];
    },

    async searchUsers(me, query) {
      // Escape LIKE wildcards so searching for "_" or "%" matches them literally.
      const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
      // Guests (demo accounts) never show up for anyone else.
      const { rows } = await sql.query<PublicUser>(
        `SELECT ${USER_COLUMNS} FROM users u
         WHERE u.id <> $1 AND NOT u.is_guest
           AND (u.username ILIKE $2 OR u.display_name ILIKE $2)
         ORDER BY lower(u.username) LIMIT 20`,
        [me, `%${escaped}%`],
      );
      return rows;
    },

    async listPeople(me) {
      // Capped so a big user base can't produce a huge response; fine for a small app.
      const { rows } = await sql.query<PublicUser & { lastAt: Date | null }>(
        `SELECT ${USER_COLUMNS},
                (SELECT MAX(m.created_at) FROM messages m
                  WHERE (m.sender_id = u.id AND m.recipient_id = $1)
                     OR (m.sender_id = $1 AND m.recipient_id = u.id)) AS "lastAt"
         FROM users u
         WHERE u.id <> $1 AND NOT u.is_guest
         ORDER BY lower(u.username)
         LIMIT 500`,
        [me],
      );
      return rows.map((r) => ({ ...r, lastAt: isoOrNull(r.lastAt) }));
    },

    async createMessage(
      senderId,
      recipientId,
      body,
      { image, replyToId } = {},
    ) {
      // The sub-select only finds the replied-to message if it's between these
      // same two people. Otherwise reply_to_id stays null, so a reply can never
      // quote (and so reveal) a message from someone else's conversation.
      const { rows } = await sql.query<MessageRow>(
        `WITH m AS (
           INSERT INTO messages
             (sender_id, recipient_id, body, image_key, image_width, image_height, reply_to_id)
           VALUES ($1, $2, $3, $4, $5, $6, (
             SELECT id FROM messages
             WHERE id = $7::int AND deleted_at IS NULL
               AND ((sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1))
           ))
           RETURNING *
         )
         SELECT ${MESSAGE_COLUMNS} FROM m ${REPLY_JOIN}`,
        [
          senderId,
          recipientId,
          body,
          image?.key ?? null,
          image?.width ?? null,
          image?.height ?? null,
          replyToId ?? null,
        ],
      );
      return toMessage(rows[0]!);
    },

    async findMessageImage(messageId) {
      const { rows } = await sql.query<{
        key: string;
        senderId: number;
        recipientId: number;
      }>(
        `SELECT image_key AS key, sender_id AS "senderId", recipient_id AS "recipientId"
         FROM messages WHERE id = $1 AND image_key IS NOT NULL`,
        [messageId],
      );
      return rows[0];
    },

    async getMessages(a, b, { before, limit = 50 } = {}) {
      const { rows } = await sql.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m ${REPLY_JOIN}
         WHERE ((m.sender_id = $1 AND m.recipient_id = $2) OR (m.sender_id = $2 AND m.recipient_id = $1))
           AND ($3::int IS NULL OR m.id < $3)
         ORDER BY m.id DESC LIMIT $4`,
        [a, b, before ?? null, limit],
      );
      return rows.map(toMessage).reverse();
    },

    async getConversations(me) {
      const { rows } = await sql.query<
        Omit<ConversationRow, "lastAt"> & { lastAt: Date }
      >(
        `WITH convo AS (
           SELECT CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END AS other_id,
                  MAX(id) AS last_id
           FROM messages
           WHERE sender_id = $1 OR recipient_id = $1
           GROUP BY 1
         )
         SELECT ${USER_COLUMNS},
                m.body AS "lastBody", (m.image_key IS NOT NULL) AS "lastIsImage",
                (m.deleted_at IS NOT NULL) AS "lastIsDeleted",
                m.sender_id AS "lastSenderId", m.created_at AS "lastAt",
                (SELECT COUNT(*)::int FROM messages
                  WHERE sender_id = u.id AND recipient_id = $1 AND read_at IS NULL) AS unread
         FROM convo c
         JOIN users u ON u.id = c.other_id
         JOIN messages m ON m.id = c.last_id
         ORDER BY m.id DESC`,
        [me],
      );
      return rows.map((r) => ({ ...r, lastAt: iso(r.lastAt) }));
    },

    async setLinkPreview(messageId, preview) {
      const { rowCount } = await sql.query(
        `UPDATE messages SET link_preview = $2::jsonb
         WHERE id = $1 AND deleted_at IS NULL`,
        [messageId, JSON.stringify(preview)],
      );
      return rowCount > 0;
    },

    async deleteMessage(messageId, userId, maxAgeMs) {
      // Only the sender can delete, only once, and only for a while. The age is
      // worked out by the database, so it doesn't depend on any other clock.
      const { rows: found } = await sql.query<{ expired: boolean }>(
        `SELECT created_at < now() - make_interval(secs => $3) AS expired
         FROM messages WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL`,
        [messageId, userId, maxAgeMs / 1000],
      );
      if (!found[0]) return null;
      if (found[0].expired) return "expired";

      // "old" reads the picture's key from before the update, in the same
      // statement. The WHERE repeats the checks in case of two deletes at once.
      const { rows } = await sql.query<
        MessageRow & { imageKey: string | null }
      >(
        `WITH old AS (SELECT image_key FROM messages WHERE id = $1),
         m AS (
           UPDATE messages
           SET deleted_at = now(), body = '', reply_to_id = NULL, link_preview = NULL,
               image_key = NULL, image_width = NULL, image_height = NULL
           WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL
           RETURNING *
         )
         SELECT ${MESSAGE_COLUMNS}, (SELECT image_key FROM old) AS "imageKey"
         FROM m ${REPLY_JOIN}`,
        [messageId, userId],
      );
      const row = rows[0];
      if (!row) return null;
      await sql.query(`DELETE FROM reactions WHERE message_id = $1`, [
        messageId,
      ]);
      const { imageKey, ...message } = row;
      return { message: { ...toMessage(message), reactions: [] }, imageKey };
    },

    async setReaction(messageId, userId, emoji) {
      // Only the two people in the conversation can react to a message.
      const { rows: found } = await sql.query<{
        senderId: number;
        recipientId: number;
      }>(
        `SELECT sender_id AS "senderId", recipient_id AS "recipientId" FROM messages
         WHERE id = $1 AND (sender_id = $2 OR recipient_id = $2) AND deleted_at IS NULL`,
        [messageId, userId],
      );
      const message = found[0];
      if (!message) return null;

      if (emoji === null) {
        await sql.query(
          `DELETE FROM reactions WHERE message_id = $1 AND user_id = $2`,
          [messageId, userId],
        );
      } else {
        // Reacting again replaces the earlier reaction.
        await sql.query(
          `INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)
           ON CONFLICT (message_id, user_id)
           DO UPDATE SET emoji = EXCLUDED.emoji, created_at = now()`,
          [messageId, userId, emoji],
        );
      }
      const { rows } = await sql.query<{ reactions: Reaction[] }>(
        `SELECT ${reactionsOf("$1")} AS reactions`,
        [messageId],
      );
      return { ...message, reactions: rows[0]?.reactions ?? [] };
    },

    async markRead(me, other) {
      const { rowCount } = await sql.query(
        `UPDATE messages SET read_at = now()
         WHERE sender_id = $1 AND recipient_id = $2 AND read_at IS NULL`,
        [other, me],
      );
      const { rows } = await sql.query<{ id: number | null }>(
        `SELECT MAX(id) AS id FROM messages WHERE sender_id = $1 AND recipient_id = $2`,
        [other, me],
      );
      return { changes: rowCount, upToId: rows[0]?.id ?? null };
    },
  };
}
