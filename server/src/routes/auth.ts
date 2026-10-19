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

export function authRoutes(db: Db): Router {
  const router = Router();

  router.post("/register", async (req: Request, res: Response<AuthReply>) => {
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
    const { username, password } = (req.body ?? {}) as Partial<
      Record<keyof Credentials, unknown>
    >;
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
