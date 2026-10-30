# Natter

Real-time one-to-one chat app. TypeScript everywhere: React 19 + Vite + Tailwind CSS v4 on the client, Express 5 + Socket.IO on the server, PostgreSQL through node-postgres (PGlite locally and in tests). npm workspaces: `client/`, `server/`, `shared/`.

## Commands (run from the repo root)

- `npm run dev` starts the API on :3001 and Vite on :5173
- `npm run typecheck` type-checks the server, tests and client
- `npm test` runs the node:test suite on an in-memory PGlite database
- `npm run build` builds the client and compiles the server

Run `npm run typecheck` and `npm test` before saying a change is done, and show me the result.

## Architecture

- `shared/types.d.ts` is the single source of truth for data shapes, REST responses and Socket.IO events. To change a payload, change it here first, then fix every type error on both sides. Never use `any` or `as` casts to silence one.
- Sockets are typed: the server is `Server<ClientToServerEvents, ServerToClientEvents>`, the client is `Socket<ServerToClientEvents, ClientToServerEvents>`.
- Auth: one httpOnly JWT cookie authenticates both REST calls and the socket handshake. Never expose the token to client JavaScript or store it in localStorage.
- Delivery: each socket joins the room `user:<id>`. Emit to that room, not to a socket id, so every open tab stays in sync.
- Presence is counted per user in `server/src/presence.ts`; a user goes offline only when their last socket disconnects.
- Database: the schema and all queries live in `server/src/db.ts`. Use parameterized SQL (`$1`, `$2`), never string concatenation. Tables are created on startup, so a schema change needs both the `CREATE TABLE` update and a safe `ALTER` for databases that already exist.
- File storage goes through the `AvatarStorage` and `ChatImageStorage` interfaces in `server/src/storage.ts`. Tests use in-memory fakes; don't call Supabase from tests.
- Demo: `server/src/demo.ts` creates temporary guest accounts (`POST /api/auth/demo`), hides them from other users' People list and search, and deletes them with their messages, reactions and files after a day. Keep its limits (60 new guests per 10 minutes, 500 at once). `server/src/bot.ts` is Natter Bot, a scripted account that gives guests a feature tour. It must stay scripted: no calls to AI or other paid services.

## Security rules

- These files are security-sensitive: `server/src/linkPreview.ts` (SSRF guards), `server/src/auth.ts`, and the image routes in `server/src/routes/chat.ts`. Do not weaken them. Any change there needs a test, and tell me explicitly so I review it line by line.
- Link previews only fetch `http(s)` on standard ports, check the IP actually connected to, re-check every redirect, and stop after 5 seconds or 2 MB. Keep all of that.
- Chat images are served only to the sender and recipient; everyone else gets a 404, not a 403. Uploaded files are checked by their first bytes, not their extension.
- `TRUST_PROXY` must be 2 on Railway. `X-Forwarded-For` arrives as `<client>, <Railway edge>` (Railway removes client-sent values), so 1 makes `req.ip` an edge address and every user shares one rate limit budget. Leave it unset when there's no proxy, or anyone can fake their IP. See "Behind a proxy" in the README.
- Never read, print or log `.env` files or secrets. `SUPABASE_SECRET_KEY` and `JWT_SECRET` stay on the server.

## Working rules

- Small, reviewable changes: one feature per branch, a plan before code, tests in the same change.
- Every new REST route or socket event gets an integration test in `server/test/` (`chat.test.ts` for the main app, `demo.test.ts` for guests and the bot), including the not-logged-in and wrong-user cases.
- Both tsconfigs use `strict` and `noUncheckedIndexedAccess`: handle the `undefined` from index lookups instead of using `!`.
- Styling: Tailwind utilities with the theme tokens in `client/src/styles.css` (`bg-panel`, `text-muted`, `border-line`, `bg-fill`, ...). No hard-coded colors and no `dark:` color variants. Shared class strings live in `client/src/ui.ts`. Respect `prefers-reduced-motion`.
- Icons: named imports from `lucide-react`.
- Don't add a dependency without asking me first.

## New features

Start with a spec (behaviour, type changes, server and client changes, edge cases, tests) and wait for my approval before writing code. `/spec <feature>` does this, and `/review` checks the current diff before I commit.
