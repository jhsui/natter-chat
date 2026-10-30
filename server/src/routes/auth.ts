import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import type { AuthResponse, ErrorResponse } from "../../../shared/types.js";
import {
  clearAuthCookie,
  currentUser,
  requireAuth,
  setAuthCookie,
} from "../auth.js";
import { toPublicUser, type Db } from "../db.js";
import { ipKey, refuseIfLimited, type RateLimits } from "../rateLimit.js";

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

interface Credentials {
  username: string;
  password: string;
}

/** Checks the request body and narrows it to Credentials, or returns an error message. */
function validate(
  body: unknown,
): { ok: true; value: Credentials } | { ok: false; error: string } {
  const { username, password } = (body ?? {}) as Partial<
    Record<keyof Credentials, unknown>
  >;
  if (typeof username !== "string" || !USERNAME_RE.test(username)) {
    return {
      ok: false,
      error:
        "Username must be 3–20 characters: letters, numbers or underscores",
    };
  }
  if (
    typeof password !== "string" ||
    password.length < 6 ||
    password.length > 72
  ) {
    return { ok: false, error: "Password must be 6–72 characters" };
  }
  return { ok: true, value: { username, password } };
}

type AuthReply = AuthResponse | ErrorResponse;

/** Sign-up, sign-in and sign-out. With `limits` null, nothing is rate-limited. */
export function authRoutes(db: Db, limits: RateLimits | null): Router {
  const router = Router();

  router.post("/register", async (req: Request, res: Response<AuthReply>) => {
    // Every attempt counts, so a 409 can't be used to check names quickly.
    if (
      limits &&
      refuseIfLimited(res, limits.register.hit(ipKey(req.ip)), "sign-up attempts")
    )
      return;

    const result = validate(req.body);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }

    const { username, password } = result.value;
    if (await db.findUserByUsername(username)) {
      res.status(409).json({ error: "That username is taken" });
      return;
    }

    const hash = await bcrypt.hash(password, 10);
    const user = await db.createUser(username, hash);
    if (!user) {
      // Someone else registered the same name between the check and the insert.
      res.status(409).json({ error: "That username is taken" });
      return;
    }
    setAuthCookie(res, user);
    res.status(201).json({ user: toPublicUser(user) });
  });

  router.post("/login", async (req: Request, res: Response<AuthReply>) => {
    const ip = ipKey(req.ip);
    if (
      limits &&
      refuseIfLimited(res, limits.loginIp.hit(ip), "sign-in attempts")
    )
      return;

    const { username, password } = (req.body ?? {}) as Partial<
      Record<keyof Credentials, unknown>
    >;
    // Tries are also counted per username, from this IP only, so nobody can
    // lock someone else out. The try is counted before the password is checked
    // (and forgotten if it's right), so parallel guesses can't slip past. A
    // name no account can have is only counted per IP.
    const nameKey =
      typeof username === "string" && USERNAME_RE.test(username)
        ? `${ip} ${username.toLowerCase()}`
        : null;
    if (
      limits &&
      nameKey &&
      refuseIfLimited(res, limits.loginName.hit(nameKey), "sign-in attempts")
    )
      return;

    const record =
      typeof username === "string"
        ? await db.findUserByUsername(username)
        : undefined;
    const ok =
      record &&
      typeof password === "string" &&
      (await bcrypt.compare(password, record.passwordHash));
    if (!record || !ok) {
      res.status(401).json({ error: "Wrong username or password" });
      return;
    }

    if (nameKey) limits?.loginName.reset(nameKey);
    setAuthCookie(res, record);
    res.json({ user: toPublicUser(record) });
  });

  router.post("/logout", (_req, res) => {
    clearAuthCookie(res);
    res.json({ ok: true });
  });

  router.get(
    "/me",
    requireAuth(db),
    async (req: Request, res: Response<AuthResponse>) => {
      const user = currentUser(req);
      res.json({ user, guest: await db.isGuest(user.id) });
    },
  );

  return router;
}
