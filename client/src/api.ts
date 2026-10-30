import type {
  AuthResponse,
  ConversationsResponse,
  DemoResponse,
  ErrorResponse,
  MessageResponse,
  MessagesResponse,
  PeopleResponse,
  ProfileResponse,
  UsersResponse,
} from "../../shared/types";
import type { ChatImage } from "./image.ts";

/** An error from the API, carrying the HTTP status (e.g. 401 when signed out). */
export class ApiError extends Error {
  status: number;
  /** After too many attempts (429): how many seconds to wait. */
  retryAfterSeconds: number | null;
  constructor(message: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds ?? null;
  }
}

async function request<T>(
  path: string,
  { method = "GET", body }: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return parse<T>(res);
}

/** Reads a JSON response, turning error statuses into an ApiError. */
async function parse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const { error, retryAfterSeconds } = data as Partial<ErrorResponse>;
    throw new ApiError(
      error || `Request failed (${res.status})`,
      res.status,
      retryAfter(res, retryAfterSeconds),
    );
  }
  return data as T;
}

/**
 * After a 429, how many seconds to wait: from our reply's retryAfterSeconds,
 * or else the Retry-After header (in case a proxy sent the 429, not us).
 */
function retryAfter(res: Response, fromBody: unknown): number | undefined {
  if (res.status !== 429) return undefined;
  if (typeof fromBody === "number") return fromBody;
  const header = res.headers.get("Retry-After")?.trim();
  if (!header) return undefined;
  // Either a number of seconds or a date.
  const seconds = /^\d+$/.test(header)
    ? Number(header)
    : (Date.parse(header) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : undefined;
}

export const api = {
  me: () => request<AuthResponse>("/auth/me"),
  login: (username: string, password: string) =>
    request<AuthResponse>("/auth/login", {
      method: "POST",
      body: { username, password },
    }),
  register: (username: string, password: string) =>
    request<AuthResponse>("/auth/register", {
      method: "POST",
      body: { username, password },
    }),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),
  /** Signs in as a new temporary guest, with Natter Bot waiting in a chat. */
  demo: () => request<DemoResponse>("/auth/demo", { method: "POST" }),
  searchUsers: (q: string) =>
    request<UsersResponse>(`/users?q=${encodeURIComponent(q)}`),
  people: () => request<PeopleResponse>("/people"),
  conversations: () => request<ConversationsResponse>("/conversations"),
  messages: (userId: number, before?: number) =>
    request<MessagesResponse>(
      `/messages/${userId}${before ? `?before=${before}` : ""}`,
    ),
  /** Sends a picture (already resized by toChatImage) as a message. */
  sendImage: async (
    userId: number,
    { blob, width, height }: ChatImage,
    replyTo?: number,
  ) =>
    parse<MessageResponse>(
      await fetch(
        `/api/messages/${userId}/image?width=${width}&height=${height}${replyTo ? `&replyTo=${replyTo}` : ""}`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": blob.type },
          body: blob,
        },
      ),
    ),
  profile: (userId: number) => request<ProfileResponse>(`/users/${userId}`),
  updateProfile: (fields: { displayName: string; bio: string }) =>
    request<ProfileResponse>("/me", { method: "PATCH", body: fields }),
  /** Uploads image bytes as-is (already resized by toSquareAvatar). */
  uploadAvatar: async (image: Blob) =>
    parse<ProfileResponse>(
      await fetch("/api/me/avatar", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": image.type },
        body: image,
      }),
    ),
  removeAvatar: () =>
    request<ProfileResponse>("/me/avatar", { method: "DELETE" }),
};

/**
 * What to show after too many attempts, given how many seconds to wait: in
 * minutes from a minute up (rounded up), in seconds below that.
 */
export function tooManyAttempts(seconds: number): string {
  const [count, unit] =
    seconds >= 60 ? [Math.ceil(seconds / 60), "minute"] : [seconds, "second"];
  const plural = count === 1 ? "" : "s";
  return `Too many attempts, try again in ${count} ${unit}${plural}`;
}

/** Turns anything thrown into a readable message. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError && err.retryAfterSeconds !== null)
    return tooManyAttempts(err.retryAfterSeconds);
  return err instanceof Error ? err.message : String(err);
}
