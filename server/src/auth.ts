import jwt from "jsonwebtoken";
import type { RequestHandler, Response } from "express";
import type { PublicUser } from "../../shared/types.js";
import { toPublicUser, type Db } from "./db.js";

// Tell TypeScript that `req.user` exists once requireAuth has run.
declare global {
  namespace Express {
    interface Request {
      user?: PublicUser;
    }
  }
}

export const COOKIE_NAME = "token";
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET must be set in production");
  }
  return "dev-only-secret-change-me";
}

export function signToken(
  user: PublicUser,
  ttlSeconds = TOKEN_TTL_SECONDS,
): string {
  return jwt.sign(
    { sub: String(user.id), username: user.username },
    getSecret(),
    {
      expiresIn: ttlSeconds,
    },
  );
}

/** Returns the user id from a token, or null if it is missing or invalid. */
export function verifyToken(token: string | undefined): number | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, getSecret());
    if (typeof payload === "string" || !payload.sub) return null;
    const id = Number(payload.sub);
    return Number.isInteger(id) ? id : null;
  } catch {
    return null;
  }
}

/** Signs `user` in. `ttlSeconds` is how long that lasts (a week unless given). */
export function setAuthCookie(
  res: Response,
  user: PublicUser,
  ttlSeconds = TOKEN_TTL_SECONDS,
): void {
  res.cookie(COOKIE_NAME, signToken(user, ttlSeconds), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: ttlSeconds * 1000,
  });
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "lax" });
}

/** Express middleware: rejects the request unless a valid auth cookie is present. */
export function requireAuth(db: Db): RequestHandler {
  return async (req, res, next) => {
    const userId = verifyToken(req.cookies?.[COOKIE_NAME]);
    const user = userId === null ? undefined : await db.findUserById(userId);
    if (!user) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    req.user = toPublicUser(user);
    next();
  };
}

/** For handlers behind requireAuth: returns req.user, which is guaranteed to be set. */
export function currentUser(req: { user?: PublicUser }): PublicUser {
  if (!req.user)
    throw new Error("currentUser() used on a route without requireAuth");
  return req.user;
}
