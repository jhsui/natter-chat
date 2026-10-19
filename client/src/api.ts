import type {
  AuthResponse,
  ConversationsResponse,
  DemoResponse,
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
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
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
    throw new ApiError(
      (data as { error?: string }).error || `Request failed (${res.status})`,
      res.status,
    );
  }
  return data as T;
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

/** Turns anything thrown into a readable message. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
