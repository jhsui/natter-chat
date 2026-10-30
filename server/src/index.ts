import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "./app.js";
import type { DbConfig } from "./db.js";

// Works from both src/ (tsx in dev) and dist/ (compiled), since both sit one level below server/.
const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.join(here, "..");

// Load server/.env if it exists (see .env.example).
const envFile = path.join(serverRoot, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const PORT = Number(process.env.PORT) || 3001;

// Real Postgres when DATABASE_URL is set (e.g. on Railway); otherwise an
// embedded Postgres (PGlite) stored in server/data/pglite, so local
// development needs nothing installed.
const databaseUrl = process.env.DATABASE_URL;
const dbConfig: DbConfig = databaseUrl
  ? { databaseUrl }
  : {
      pgliteDir:
        process.env.PGLITE_DIR || path.join(serverRoot, "data", "pglite"),
    };

// How many proxies are in front of the server (1 on Railway), so rate limits
// see each visitor's real IP. Leave it unset when there's no proxy.
const proxies = Number(process.env.TRUST_PROXY);

const chat = await createServer({
  db: dbConfig,
  // LINK_PREVIEWS=off stops the server from downloading pages that messages link to.
  linkPreviews: process.env.LINK_PREVIEWS === "off" ? null : undefined,
  // "Try the demo" guest accounts and Natter Bot. DEMO=off turns them off.
  demo: process.env.DEMO !== "off",
  trustProxy: Number.isInteger(proxies) && proxies > 0 ? proxies : false,
  clientDist: path.join(serverRoot, "..", "client", "dist"),
  corsOrigin: process.env.CLIENT_ORIGIN, // only needed if the client is hosted on another domain
});

chat.httpServer.listen(PORT, () => {
  const where =
    "pgliteDir" in dbConfig
      ? `embedded PGlite in ${dbConfig.pgliteDir}`
      : "PostgreSQL (DATABASE_URL)";
  console.log(
    `Natter server listening on http://localhost:${PORT} — database: ${where}`,
  );
});

// Close the database cleanly when the process is stopped (Ctrl+C, a restart in
// dev, or a redeploy on a host like Railway).
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    chat.close().then(
      () => process.exit(0),
      (err) => {
        console.error(err);
        process.exit(1);
      },
    );
  });
}
