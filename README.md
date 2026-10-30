# Natter

A real-time chat web app with user accounts and private 1:1 direct messages.

**Stack:** TypeScript everywhere · React 19 + Vite · Tailwind CSS v4 · Lucide icons · Node.js + Express 5 · Socket.IO · PostgreSQL (node-postgres, PGlite for local dev) · bcrypt + JWT (httpOnly cookie)

## Features

- **Try the demo:** one click on the sign-in page creates a temporary guest account and opens a chat with **Natter Bot**, which gives a quick tour of read receipts, link previews, reactions, replies and photos (see [Demo](#demo-guest-accounts-and-natter-bot))
- Sign up / sign in with username and password (passwords hashed with bcrypt)
- **Rate limits** on signing in, signing up and sending messages, so nobody can guess passwords quickly or flood a chat (see [Rate limits](#rate-limits))
- **Chats | People** tabs in the sidebar: People lists every user (except demo guests), online first, then by most recent chat
- **Profiles:** upload an avatar (cropped and resized in the browser, stored in Supabase Storage), set a display name and a short bio, and view other people's profiles. Changes show up live for everyone
- Filter existing conversations in **Chats**, or find anyone by username or display name in **People**
- Messages arrive instantly over WebSockets and are saved to PostgreSQL
- **Images:** attach a picture with the image button or paste one from the clipboard; it's shrunk in the browser, stored in a private Supabase Storage bucket that only the two people in the conversation can load from, and opens full-size when clicked
- Conversation list sorted by latest message, with unread badges
- Online / offline status, typing indicator, and read receipts: "Sent", then "Read" and the time, under your latest message (hover any of your messages for when it was sent and read)
- **Replies:** hover a message (or tap its smiley button on a phone) to reply to it; the reply shows a quote of the original, and clicking the quote jumps to it
- **Reactions:** react to any message with 👍 ❤️ 😂 😮 😢 🙏, or any other emoji from the full picker via "+" (one per person per message; pick it again to take it back). They appear under the message for both people straight away
- **Delete:** remove a message you sent, for both people, up to 2 days after sending it. It leaves a "This message was deleted" placeholder, and a deleted picture's file is removed from storage
- **Link previews:** links in messages are clickable, and the first one gets a card with the page's title, description and picture
- Emoji picker in the message box, with search, categories and skin tones ([emoji-picker-react](https://github.com/ealush/emoji-picker-react), downloaded the first time it's opened)
- Per-chat drafts: unsent text stays with its chat when you switch, with a "Draft: …" preview in the sidebar (kept until you reload)
- Message history with "load older" pagination
- Works across multiple tabs, reconnects automatically, light/dark/system appearance with a saved preference, and a mobile layout
- A Messages-style layout: your bubbles in the accent color (a deep teal), theirs in grey, a tail on the last bubble of each run, reactions pinned to the bubble's corner, and the date and time over the first message of the day and after a long pause. A message you send rises out of the message box into place, and on wide screens the conversation sits in a centred column
- Resizable sidebar on wide screens: drag its edge (or focus it and use the arrow keys); the width is remembered and a double-click resets it
- Responsive layout, keyboard-accessible tabs, reduced-motion support, loading skeletons, and a jump-to-latest button when reading history

## Getting started

You need **Node.js 22.12 or newer** (`node -v` to check).

```bash
npm install      # installs the server and client together (npm workspaces)
npm run dev      # starts the API on :3001 and the React app on :5173
```

Open http://localhost:5173. To try chatting with yourself, open a second browser
(or a private window), create another account, search for the first one, and say hi.

Optional: copy `server/.env.example` to `server/.env` to set your own `JWT_SECRET`, port, etc.

## Database (PostgreSQL)

The server talks to PostgreSQL and picks where it lives at startup:

| `DATABASE_URL`                      | Database used                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| not set (default)                   | **PGlite**, real Postgres compiled to WebAssembly, running inside Node and stored in `server/data/pglite`. Nothing to install. |
| `postgres://user:pass@host:5432/db` | That PostgreSQL server (Railway, Docker, Postgres.app, …)                                                                      |

Both run exactly the same SQL (`server/src/db.ts`). Tables are created automatically on startup if they don't exist.

- To use a real Postgres locally, put `DATABASE_URL=...` in `server/.env`.
- To start over with an empty local database, stop the app and delete `server/data/pglite`.
- To browse the data, point any Postgres client (pgAdmin, TablePlus, `psql`) at your `DATABASE_URL`. PGlite's folder can only be opened by the app itself.
- Tests use a throwaway in-memory PGlite by default. `TEST_DATABASE_URL=postgres://... npm test` runs the main suite against a real server instead (**it wipes the `users`, `messages` and `reactions` tables in that database**). The demo tests always use in-memory databases, since they start several servers.

## Avatars and chat images (Supabase Storage)

Profile pictures and pictures sent in chats are stored in two [Supabase Storage](https://supabase.com/docs/guides/storage) buckets, a public one for avatars and a private one for chat images; the database only keeps where each file is. Everything else works without it. Until it's configured, uploading a photo shows "Avatar uploads aren't set up on this server yet" (or "Sending images isn't set up…" in a chat).

One-time setup:

1. Create a free project at [supabase.com](https://supabase.com).
2. **Storage → New bucket** → name it `avatars` and turn on **Public bucket** (so the images can be shown in `<img>` tags). Optionally limit it to `image/*` and 1 MB.
   Then create a second bucket named `chat-images` and leave **Public bucket** off. The same optional limits work (chat images are at most 1 MB).
3. **Project Settings → API Keys** → copy the **secret** key (`sb_secret_…`; the older `service_role` key also works), and copy the project URL.
4. Add them to `server/.env` (and later to Railway's variables):

   ```bash
   SUPABASE_URL=https://your-project-ref.supabase.co
   SUPABASE_SECRET_KEY=sb_secret_...
   # SUPABASE_BUCKET=avatars            # only if you named the buckets differently
   # SUPABASE_CHAT_BUCKET=chat-images
   ```

5. Restart `npm run dev`.

How it works:

- The browser center-crops the chosen photo to a 256×256 WebP (~10–40 KB) before uploading, so big phone photos upload quickly.
- The server checks the file's first bytes to confirm it's really a PNG/JPEG/WebP, uploads it with the secret key, saves the public URL, and deletes the previous avatar file.
- Each upload gets a new file name, so browsers can cache avatars aggressively without showing an outdated picture.
- The secret key stays on the server. **Never** put it in client code or commit `.env`.
- Storage is behind two small interfaces, `AvatarStorage` and `ChatImageStorage` (`server/src/storage.ts`), so tests use in-memory fakes, and switching to S3/R2 would only need new implementations.

Chat images go in the private `chat-images` bucket, under `<sender id>/`:

- The browser scales a picture down so its longer side is at most 1600px and re-encodes it as WebP (usually 100–400 KB), which also strips the photo's metadata such as GPS location. Animated GIFs become a still image.
- It's uploaded with `POST /api/messages/:userId/image` (max 1 MB). The server checks the file signature, stores the file, saves a message with the file's storage path and pixel size, and announces it over the socket like a text message.
- The pixel size is stored so the chat can reserve the right space before the file loads, instead of jumping as pictures appear.
- **Privacy:** files in a private bucket have no public URL. A message's `image.url` is `/api/images/<message id>` on this server, which checks the login cookie and only sends the file to the sender and the recipient (anyone else gets a 404). The server fetches the file from Supabase with the secret key and passes it on.
- Browsers keep their copy (`Cache-Control: private, immutable`), so each picture is fetched through the server once per device, not on every visit.

## Link previews

When a text message contains a link, the server downloads that page once and reads its title, description and picture from the page's `<meta>` tags (Open Graph). The message is delivered first; the preview follows a moment later as a `message:preview` event and is saved with the message.

- **The server only fetches public web pages.** Fetching an address a user typed could otherwise be used to reach things only the server can see (`http://localhost`, a private network, a cloud provider's metadata address). `server/src/linkPreview.ts` refuses anything that isn't `http(s)` on the standard ports, checks the IP address it actually connects to, re-checks every redirect, and gives up after 5 seconds or 2 MB (it stops reading at the end of the page's `<head>`, which is usually much sooner).
- **Preview pictures load from the other site**, straight into each person's browser, so that site sees their IP address when the card is shown (as it would if they opened the link). The request doesn't include this app's address.
- Set `LINK_PREVIEWS=off` in `server/.env` to turn previews off; links stay clickable.

## Demo (guest accounts and Natter Bot)

"Try the demo" on the sign-in page lets visitors try Natter without signing up. It's on by default; set `DEMO=off` in `server/.env` to turn it off.

- **Guest accounts:** `POST /api/auth/demo` creates an account named like `guest_4821` ("Guest 4821") with a random password that's never stored, so it can only be used through its login cookie. Guests are left out of everyone else's People list and search, and after a day they're deleted, with their messages, reactions and storage files (`server/src/demo.ts` checks hourly). At most 60 guests are created per 10 minutes and at most 500 exist at once, so a script can't fill the database.
- **Natter Bot** (`server/src/bot.ts`) is a regular account that answers like a person: it marks your message read, shows "typing…" for a moment, then replies. Quick messages in a row get one answer. Its first replies are a short tour, one feature each:
  1. explains the read receipt you just saw, and asks for a link
  2. comments on the link's preview card (or says honestly if the site gave no preview). If you skip the link, it sends one: this repo
  3. reacts ❤️ to your message and replies to it, quoting it
  4. sends a photo (`server/assets/natter-bot-photo.webp`), if image storage is set up
  5. suggests a few more things to try

  After that it keeps chatting from a pool of lines, never the same one twice in a row, and reacts to the odd message. It's scripted, so it costs nothing to run and every visitor sees the same tour. It always shows as online, and anyone can find it in People.

## Rate limits

`server/src/rateLimit.ts` limits how fast people can sign in, sign up and send messages:

| What                           | Limit                                    | Counted per                 |
| ------------------------------ | ---------------------------------------- | --------------------------- |
| Sign-in attempts               | 30 per 15 minutes                        | IP address                  |
| Sign-in tries for one username | 10 per 15 minutes (cleared by a success) | IP address + username       |
| Sign-up attempts               | 10 per hour                              | IP address                  |
| Messages (text and pictures)   | 20 per 10 seconds                        | user, across all their tabs |

- **What people see:** "Too many attempts, try again in 15 minutes" (or "in N seconds" for a wait under a minute) on the sign-in form, or in the message box, which keeps the text they typed. Over HTTP the server answers `429` with `{ error, retryAfterSeconds }` and a `Retry-After` header; a refused `message:send` gets the same `error` and `retryAfterSeconds` in its ack.
- **Every attempt counts**, including wrong passwords, invalid input and sign-ups for names that are taken, so a `409` can't be used to check quickly which usernames exist. Once a limit is reached, even the right password is refused until the wait is over.
- **One username's tries are counted per IP**, so someone guessing a password from their own machine can't lock the real owner out; the per-IP limit covers one machine trying many usernames.
- **Only sending is limited.** Someone over the message limit still receives messages live, and their typing indicator and read receipts keep working. Natter Bot isn't limited, and "Try the demo" keeps its own limits (see [Demo](#demo-guest-accounts-and-natter-bot)).
- **The counts live in memory.** They reset when the server restarts, and they aren't shared between instances: two servers would each allow the full limit. That's fine while Natter runs as one instance; see [Ideas for next steps](#ideas-for-next-steps) for scaling out.
- **People who share an IP address share its sign-in and sign-up budgets.** An office, a school or a mobile network that puts many customers behind one address (carrier-grade NAT) counts as one visitor, so a busy one can hit 10 sign-ups an hour. IPv6 addresses are grouped by their first 64 bits, since one device usually has a whole /64 to pick from.
- The tests turn the limits off on their shared servers (`rateLimits: false` in `createServer`) and test them on servers of their own, with a clock they move by hand.

### Behind a proxy: `TRUST_PROXY`

On Railway (and most hosts) requests reach the server through a proxy, so without help every visitor seems to come from the proxy's IP address and they'd all share one budget. Set **`TRUST_PROXY=1`** (the number of proxies in front of the server) so the server takes each visitor's IP from the `X-Forwarded-For` header the proxy adds.

Leave it unset when nothing sits in front of the server, as in local development. If it's set without a proxy, or higher than the real number of proxies, anyone can send a made-up `X-Forwarded-For` and get a fresh budget each time.

**Checking it after deploying.** The limits are counted by `req.ip`, so you can check that `req.ip` is each visitor's real IP, not the proxy's, by watching a limit. This uses a username nobody has, `trust_proxy_check`, which can be tried 10 times per IP:

1. **A made-up header doesn't help.** From your computer, run (with your app's address):

   ```bash
   for i in $(seq 1 11); do
     curl -s -o /dev/null -w "%{http_code}\n" -X POST https://your-app.up.railway.app/api/auth/login \
       -H "Content-Type: application/json" -H "X-Forwarded-For: 203.0.113.$i" \
       -d '{"username":"trust_proxy_check","password":"wrong"}'
   done
   ```

   You should see `401` ten times, then `429`. If you only see `401`, the server believes the made-up header: `TRUST_PROXY` is higher than the number of proxies.

2. **Other visitors aren't affected.** Right after that, sign in as `trust_proxy_check` (any password) from another network, such as a phone on mobile data with Wi-Fi off. You should get "Wrong username or password". If you get "Too many attempts", everyone shares the proxy's IP: `TRUST_PROXY` isn't set, or the host has more proxies than it says.

This only blocks `trust_proxy_check` from your IP, for 15 minutes (or until a restart). It also uses 11 of your IP's 30 sign-in attempts for that time; signing in to real accounts still works.

## Scripts (run from the project root)

| Command             | What it does                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `npm run dev`       | Server (runs the `.ts` files directly with tsx, restarts on change) + Vite dev server        |
| `npm run typecheck` | Type-checks the server, tests and client with `tsc`                                          |
| `npm test`          | Server tests: auth, search, live messaging, read receipts, paging, profiles, image messages, rate limits, the demo and Natter Bot |
| `npm run build`     | Type-checks and builds the client into `client/dist`, compiles the server into `server/dist` |
| `npm start`         | Runs the compiled server (`server/dist`); serves `client/dist` too                           |

To run it like production on one port: `npm run build && JWT_SECRET=something-long npm start`, then open http://localhost:3001.

## Styling (Tailwind CSS v4)

- Styles are Tailwind utility classes written directly in the JSX. Tailwind runs as a Vite plugin (`@tailwindcss/vite`), so there's no separate config file or PostCSS setup.
- **Theme tokens** live in `client/src/styles.css`: colors are CSS variables on `:root`, swapped for dark mode by `[data-theme="dark"]`, and exposed to Tailwind through `@theme`. That gives custom utilities like `bg-panel`, `bg-chat`, `text-muted`, `border-line`, `bg-fill`, `bg-bubble`, so components don't need `dark:` variants for colors. `--fill` is the solid accent behind white text (your bubbles, primary buttons); `--accent` is the accent for text, icons and focus rings; `--bubble` is the other person's bubbles. Surfaces are flat: solid colors, hairline borders, and one shadow (`shadow-pop`) for menus and dialogs.
- **Appearance:** `client/src/theme.tsx` provides light, dark, and system modes. Dark is the default on a first visit; the appearance menu offers all three modes and saves the choice in local storage, synchronized across browser tabs. A small inline script in `client/index.html` applies the saved choice before the first paint, so the page never flashes the wrong colours while it loads. CSS uses semantic color variables for both themes, and animations respect `prefers-reduced-motion`. The few things utilities can't express (the bubble tails, reactions, the segmented control, menus and dialogs) are classes in `styles.css`.
- **Font:** the device's system font (San Francisco on Apple devices, Segoe UI on Windows, Roboto on Android), set as `--font-sans` in `styles.css`. Nothing to download.
- **Icons:** [Lucide](https://lucide.dev) (`lucide-react`). Import the ones you need by name, e.g. `import { Send } from "lucide-react"`; only those end up in the bundle.
- `md` is set to 720px: below it (`max-md:`), the app shows one pane at a time.
- **Shared classes** used in several components (buttons, inputs, headers) are strings in `client/src/ui.ts`; `cx()` joins class names conditionally.
- Tip: the official "Tailwind CSS IntelliSense" VS Code extension gives autocomplete and hover previews for class names.

## TypeScript setup

- **Shared types** live in `shared/types.d.ts`: the data shapes (`Message`, `Conversation`, …), every REST response, and the Socket.IO events. Both sides `import type` from it, so if you change an event's payload, `npm run typecheck` shows every place on the server _and_ client that needs updating.
- **Typed sockets:** the server is a `Server<ClientToServerEvents, ServerToClientEvents>` and the client a `Socket<ServerToClientEvents, ClientToServerEvents>`, so `socket.emit('message:send', …)` and every `socket.on(...)` handler are checked.
- **Server:** in development `tsx` runs the `.ts` files directly (no build step). For production, `tsc` compiles `server/src` to `server/dist`. `tsconfig.json` covers src + tests for type-checking; `tsconfig.build.json` is the compile config.
- **Client:** Vite compiles the `.tsx` files; `tsc --noEmit` only type-checks (run as part of `npm run build`).
- Both configs use `strict` mode plus `noUncheckedIndexedAccess`, so array lookups like `messages[0]` are typed as possibly `undefined`.

## How it works

```
Browser (React)                     Server (Express + Socket.IO)            PostgreSQL
───────────────                     ────────────────────────────            ──────────
login / register  ── REST /api ──▶  bcrypt check, sets httpOnly JWT cookie ─▶ users
load chats/history ── REST /api ──▶  /conversations, /messages/:userId  ───▶ messages
send image        ── REST /api ──▶  store file, save, emit to both users ───▶ messages
show image        ── REST /api ──▶  /images/:messageId, sender/recipient only
send message      ── socket ─────▶  validate, save, emit to both users ───▶ messages
                  ◀── socket ─────  message:new · typing · presence · messages:read
```

- **Auth:** the same cookie authenticates both REST calls and the WebSocket handshake, so the token is never exposed to JavaScript.
- **Delivery:** each connected socket joins a room named `user:<id>`. Sending to that room reaches every open tab of that user.
- **Presence:** the server counts open sockets per user, so you only go offline when your last tab closes.

## Project structure

```
natter-chat/
├── package.json             root: workspaces + scripts
├── shared/
│   └── types.d.ts           types shared by server and client (data, API, socket events)
├── server/
│   ├── tsconfig.json        type-check config (src + test)
│   ├── tsconfig.build.json  compile config (src → dist)
│   ├── src/
│   │   ├── index.ts         starts the server (loads .env)
│   │   ├── app.ts           builds Express + Socket.IO (used by tests too)
│   │   ├── db.ts            Postgres schema, typed queries, pg / PGlite connection
│   │   ├── auth.ts          JWT cookie helpers + requireAuth middleware
│   │   ├── socket.ts        real-time events
│   │   ├── presence.ts      online tracking
│   │   ├── rateLimit.ts     rate limits on signing in, signing up and sending messages
│   │   ├── linkPreview.ts   downloads a linked page (safely) and reads its title/description/picture
│   │   ├── storage.ts       Supabase Storage for avatars and chat images + image type check
│   │   ├── demo.ts          "Try the demo": guest accounts, their limits and hourly cleanup
│   │   ├── bot.ts           Natter Bot: the scripted tour and small talk
│   │   └── routes/          auth.ts (register/login/logout/me), chat.ts (users, conversations, messages, send/serve images),
│   │                        profile.ts (view/edit profile, upload/remove avatar)
│   ├── assets/              the photo Natter Bot sends
│   ├── test/                node:test suites (run with tsx): chat.test.ts, linkPreview.test.ts, rateLimit.test.ts, demo.test.ts
│   └── data/pglite/         local PGlite database (created on first run, git-ignored)
└── client/
    ├── tsconfig.json
    ├── vite.config.ts       proxies /api and /socket.io to :3001 in dev
    └── src/
        ├── App.tsx          session check → AuthPage or ChatPage
        ├── api.ts           typed fetch wrapper
        ├── components/      AuthPage, ChatPage (socket + state), Sidebar, ChatWindow, EmojiPicker, ImageViewer, ProfileDialog, Avatar
        ├── image.ts         resizes photos in the browser before upload (avatars and chat images)
        ├── ui.ts           shared Tailwind class strings + cx() helper
        └── styles.css      Tailwind entry: theme tokens (light/dark), keyframes
```

## Socket events

| Client → server  | Payload                              | Server → client     | Payload                                                           |
| ---------------- | ------------------------------------ | ------------------- | ----------------------------------------------------------------- |
| `message:send`   | `{ to, body, replyTo? }` + ack       | `message:new`       | `Message`                                                         |
| `typing`         | `{ to, typing }`                     | `typing`            | `{ from, typing }`                                                |
| `messages:read`  | `{ from }`                           | `messages:read`     | `{ readerId, senderId, upToId }`                                  |
| `message:delete` | `{ messageId }` + ack                | `message:deleted`   | `Message` (what's left: see `deletedAt`)                          |
|                  |                                      | `message:preview`   | `{ messageId, preview }` (a sent message's link preview is ready) |
| `message:react`  | `{ messageId, emoji \| null }` + ack | `message:reactions` | `{ messageId, reactions }` (the full list)                        |
|                  |                                      | `presence`          | `{ userId, online }`                                              |
|                  |                                      | `profile:updated`   | `PublicUser` (new name/avatar)                                    |

Image messages are sent with `POST /api/messages/:userId/image?width=…&height=…` (the image bytes as the body, ≤ 1 MB) and arrive as a `message:new` whose `image` is `{ url, width, height }`. The `url` is `GET /api/images/:messageId`, which serves the file to the sender and recipient only.

## Profile API

| Method & path           | Body                   | Does                                          |
| ----------------------- | ---------------------- | --------------------------------------------- |
| `GET /api/users/:id`    |                        | Anyone's profile (name, bio, avatar, online)  |
| `PATCH /api/me`         | `{ displayName, bio }` | Edit your display name (≤ 40) and bio (≤ 160) |
| `PUT /api/me/avatar`    | image bytes (≤ 512 KB) | Upload a new avatar                           |
| `DELETE /api/me/avatar` |                        | Remove your avatar                            |

## Ideas for next steps

- Group chats (a `conversations` + `participants` table instead of sender/recipient pairs)
- Captions on images, other file attachments, animated GIFs
- More rate limits: reactions, deleting messages and the typing indicator aren't limited yet (signing in, signing up and sending are, see [Rate limits](#rate-limits))
- Keep the rate limit counts in Postgres (or Redis) if the server ever runs as more than one instance, so they're shared and survive restarts
- Edit messages
- Deploy (Railway, Render or Fly.io) — add a Postgres database, and set `DATABASE_URL`, `JWT_SECRET`, `NODE_ENV=production` and `TRUST_PROXY=1` (see [Behind a proxy](#behind-a-proxy-trust_proxy))
