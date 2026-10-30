import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  Conversation,
  Message,
  Person,
  PublicUser,
  ServerToClientEvents,
} from "../../../shared/types";
import { ApiError, api, tooManyAttempts } from "../api.ts";
import type { ChatImage } from "../image.ts";
import Sidebar from "./Sidebar.tsx";
import SidebarResizer from "./SidebarResizer.tsx";
import ChatWindow from "./ChatWindow.tsx";
import ProfileDialog from "./ProfileDialog.tsx";

type ChatSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface ChatPageProps {
  me: PublicUser;
  /** True for a temporary demo account. */
  guest: boolean;
  /** Someone to open a chat with straight away (Natter Bot, for a new guest). */
  startWith: PublicUser | null;
  /** Your own name or avatar changed. */
  onMeChange: (me: PublicUser) => void;
  onLogout: () => void;
}

/** Just the public fields of a user-shaped object. */
const publicUser = ({
  id,
  username,
  displayName,
  avatarUrl,
}: PublicUser): PublicUser => ({
  id,
  username,
  displayName,
  avatarUrl,
});

export default function ChatPage({
  me,
  guest,
  startWith,
  onMeChange,
  onLogout,
}: ChatPageProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [people, setPeople] = useState<Person[]>([]); // everyone, for the People tab
  const [active, setActive] = useState<PublicUser | null>(null); // the person we're chatting with
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [online, setOnline] = useState<Record<number, boolean>>({}); // live presence updates
  const [typing, setTyping] = useState<Record<number, boolean>>({});
  const [connected, setConnected] = useState(true);
  const [profileId, setProfileId] = useState<number | null>(null); // whose profile is open

  // Socket handlers are registered once, so they read current values through refs.
  const socketRef = useRef<ChatSocket | null>(null);
  const activeRef = useRef<PublicUser | null>(null);
  const conversationsRef = useRef<Conversation[]>([]);
  const peopleRef = useRef<Person[]>([]);
  const typingTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>(
    {},
  );
  // Unsent text per chat (by the other person's id), so switching chats keeps
  // what you typed. A ref: typing shouldn't re-render the whole page.
  const draftsRef = useRef(new Map<number, string>());
  const [, redrawDrafts] = useReducer((n: number) => n + 1, 0);
  // The message being replied to in each chat, kept the same way.
  const replyDraftsRef = useRef(new Map<number, Message>());
  const onLogoutRef = useRef(onLogout);
  const onMeChangeRef = useRef(onMeChange);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);
  useEffect(() => {
    peopleRef.current = people;
  }, [people]);
  useEffect(() => {
    onLogoutRef.current = onLogout;
  }, [onLogout]);
  useEffect(() => {
    onMeChangeRef.current = onMeChange;
  }, [onMeChange]);

  const refreshConversations = useCallback(async () => {
    try {
      const { conversations } = await api.conversations();
      setConversations(conversations);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onLogoutRef.current();
    }
  }, []);

  const refreshPeople = useCallback(async () => {
    try {
      const { people } = await api.people();
      setPeople(people);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onLogoutRef.current();
    }
  }, []);

  const markRead = useCallback((userId: number) => {
    socketRef.current?.emit("messages:read", { from: userId });
    setConversations((prev) =>
      prev.map((c) => (c.id === userId ? { ...c, unread: 0 } : c)),
    );
  }, []);

  const loadMessages = useCallback(
    async (user: PublicUser) => {
      setLoading(true);
      try {
        const data = await api.messages(user.id);
        if (activeRef.current?.id !== user.id) return; // user switched chats while loading
        setMessages(data.messages);
        setHasMore(data.hasMore);
        setOnline((o) => ({ ...o, [user.id]: data.user.online }));
        // Pick up their latest name/avatar too.
        activeRef.current = publicUser(data.user);
        setActive(activeRef.current);
        markRead(user.id);
      } finally {
        if (activeRef.current?.id === user.id) setLoading(false);
      }
    },
    [markRead],
  );

  // --- Real-time connection -------------------------------------------------
  useEffect(() => {
    const socket: ChatSocket = io({ withCredentials: true });
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", (err) => {
      setConnected(false);
      if (err.message === "unauthorized") onLogoutRef.current();
    });

    // After a dropped connection, re-fetch anything we may have missed.
    socket.io.on("reconnect", () => {
      void refreshConversations();
      void refreshPeople();
      if (activeRef.current) void loadMessages(activeRef.current);
    });

    socket.on("message:new", (msg) => {
      const incoming = msg.senderId !== me.id;
      const otherId = incoming ? msg.senderId : msg.recipientId;
      const isActive = activeRef.current?.id === otherId;

      if (isActive) {
        setMessages((prev) =>
          prev.some((m) => m.id === msg.id) ? prev : [...prev, msg],
        );
        if (incoming && document.visibilityState === "visible")
          socket.emit("messages:read", { from: otherId });
      }
      if (incoming) setTyping((t) => ({ ...t, [otherId]: false }));
      setPeople((prev) =>
        prev.map((p) =>
          p.id === otherId ? { ...p, lastAt: msg.createdAt } : p,
        ),
      );

      if (!conversationsRef.current.some((c) => c.id === otherId)) {
        void refreshConversations(); // first message with someone new
        return;
      }
      setConversations((prev) => {
        const current = prev.find((c) => c.id === otherId);
        if (!current) return prev;
        const updated: Conversation = {
          ...current,
          lastBody: msg.body,
          lastIsImage: msg.image !== null,
          lastIsDeleted: false,
          lastSenderId: msg.senderId,
          lastAt: msg.createdAt,
          unread: isActive ? 0 : current.unread + (incoming ? 1 : 0),
        };
        return [updated, ...prev.filter((c) => c.id !== otherId)];
      });
    });

    socket.on("messages:read", ({ readerId, senderId, upToId }) => {
      if (senderId === me.id && activeRef.current?.id === readerId) {
        // The other person read our messages: show "Seen".
        const now = new Date().toISOString();
        setMessages((prev) =>
          prev.map((m) =>
            m.senderId === me.id && m.id <= upToId && !m.readAt
              ? { ...m, readAt: now }
              : m,
          ),
        );
      }
      if (readerId === me.id) {
        // We read them in another tab.
        setConversations((prev) =>
          prev.map((c) => (c.id === senderId ? { ...c, unread: 0 } : c)),
        );
      }
    });

    // A message was deleted: swap in what's left of it, and empty any quotes of it.
    socket.on("message:deleted", (deleted) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id === deleted.id) return deleted;
          if (m.replyTo?.id !== deleted.id) return m;
          return {
            ...m,
            replyTo: { ...m.replyTo, body: "", imageUrl: null, deleted: true },
          };
        }),
      );
      // Forget a reply to it that was waiting in a chat that isn't open.
      for (const [userId, target] of replyDraftsRef.current)
        if (target.id === deleted.id) replyDraftsRef.current.delete(userId);
      void refreshConversations(); // it may have been a chat's latest message
    });

    // The preview for a link in a message that's already on screen is ready.
    socket.on("message:preview", ({ messageId, preview }) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId ? { ...m, linkPreview: preview } : m,
        ),
      );
    });

    socket.on("message:reactions", ({ messageId, reactions }) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, reactions } : m)),
      );
    });

    socket.on("presence", ({ userId, online }) => {
      setOnline((o) => ({ ...o, [userId]: online }));
      if (!online) setTyping((t) => ({ ...t, [userId]: false }));
      // Someone we don't know yet (e.g. they just signed up): reload the People list.
      if (online && !peopleRef.current.some((p) => p.id === userId))
        void refreshPeople();
    });

    socket.on("typing", ({ from, typing }) => {
      clearTimeout(typingTimers.current[from]);
      setTyping((t) => ({ ...t, [from]: typing }));
      // Safety net in case the "stopped typing" event never arrives.
      if (typing) {
        typingTimers.current[from] = setTimeout(
          () => setTyping((t) => ({ ...t, [from]: false })),
          5000,
        );
      }
    });

    // Someone changed their name or avatar: update them everywhere they appear.
    socket.on("profile:updated", (user) => {
      const apply = <T extends PublicUser>(u: T): T =>
        u.id === user.id ? { ...u, ...user } : u;
      setConversations((prev) => prev.map(apply));
      setPeople((prev) => prev.map(apply));
      if (activeRef.current?.id === user.id) {
        activeRef.current = apply(activeRef.current);
        setActive(activeRef.current);
      }
      if (user.id === me.id) onMeChangeRef.current(user);
    });

    void refreshConversations();
    void refreshPeople();

    const timers = typingTimers.current;
    return () => {
      socket.disconnect();
      Object.values(timers).forEach(clearTimeout);
    };
  }, [me.id, refreshConversations, refreshPeople, loadMessages]);

  // Mark messages read when the user comes back to the tab.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible" && activeRef.current)
        markRead(activeRef.current.id);
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [markRead]);

  // A new guest lands straight in their chat with Natter Bot.
  const startedRef = useRef(false);
  useEffect(() => {
    if (!startWith || startedRef.current) return;
    startedRef.current = true;
    openConversation(startWith);
    // Only on arrival, so the dependency list is empty on purpose.
  }, []);

  // --- Actions ----------------------------------------------------------------
  function openConversation(user: PublicUser) {
    if (activeRef.current?.id === user.id) return;
    const next = publicUser(user);
    activeRef.current = next;
    setActive(next);
    setMessages([]);
    setHasMore(false);
    void loadMessages(next);
  }

  function closeConversation() {
    activeRef.current = null;
    setActive(null);
  }

  async function loadOlder() {
    const oldest = messages[0];
    if (!active || !oldest || loading) return;
    const userId = active.id;
    setLoading(true);
    try {
      const data = await api.messages(userId, oldest.id);
      if (activeRef.current?.id !== userId) return;
      setMessages((prev) => [...data.messages, ...prev]);
      setHasMore(data.hasMore);
    } finally {
      setLoading(false);
    }
  }

  async function sendMessage(body: string, replyTo?: number): Promise<void> {
    const socket = socketRef.current;
    if (!socket?.connected || !active)
      throw new Error("You're offline — message not sent");
    let res;
    try {
      res = await socket
        .timeout(5000)
        .emitWithAck("message:send", { to: active.id, body, replyTo });
    } catch {
      throw new Error("Message timed out — try again");
    }
    if (!res.ok) {
      throw new Error(
        res.retryAfterSeconds === undefined
          ? res.error
          : tooManyAttempts(res.retryAfterSeconds),
      );
    }
  }

  // Images are uploaded over HTTP; the server then announces the new message
  // over the socket like any other, which is what adds it to the chat.
  async function sendImage(image: ChatImage, replyTo?: number): Promise<void> {
    if (!socketRef.current?.connected || !active)
      throw new Error("You're offline — image not sent");
    await api.sendImage(active.id, image, replyTo);
  }

  // The server answers by announcing the message's new reactions to both
  // people ("message:reactions" above), which is what updates the chat.
  async function reactToMessage(
    messageId: number,
    emoji: string | null,
  ): Promise<void> {
    const socket = socketRef.current;
    if (!socket?.connected)
      throw new Error("You're offline — reaction not sent");
    let res;
    try {
      res = await socket
        .timeout(5000)
        .emitWithAck("message:react", { messageId, emoji });
    } catch {
      throw new Error("Reaction timed out — try again");
    }
    if (!res.ok) throw new Error(res.error);
  }

  async function deleteMessage(messageId: number): Promise<void> {
    const socket = socketRef.current;
    if (!socket?.connected)
      throw new Error("You're offline — message not deleted");
    let res;
    try {
      res = await socket
        .timeout(5000)
        .emitWithAck("message:delete", { messageId });
    } catch {
      throw new Error("Deleting timed out — try again");
    }
    if (!res.ok) throw new Error(res.error);
  }

  function saveDraft(userId: number, text: string) {
    if (text.trim()) draftsRef.current.set(userId, text);
    else draftsRef.current.delete(userId);
    // The sidebar shows drafts only for chats that aren't open, and switching
    // chats re-renders it anyway. So a redraw is only needed in the rare case
    // that a closed chat's draft changes (a send that failed after you left).
    if (activeRef.current?.id !== userId) redrawDrafts();
  }

  function sendTyping(isTyping: boolean) {
    if (active)
      socketRef.current?.emit("typing", { to: active.id, typing: isTyping });
  }

  function handleLogout() {
    socketRef.current?.disconnect();
    onLogout();
  }

  const isOnline = (user: { id: number; online?: boolean }) =>
    online[user.id] ?? user.online ?? false;

  return (
    // Sidebar and chat side by side on wide screens; one at a time on phones.
    <div className="app-shell">
      <Sidebar
        me={me}
        guest={guest}
        conversations={conversations}
        people={people}
        drafts={draftsRef.current}
        onShowPeople={refreshPeople}
        activeId={active?.id}
        typing={typing}
        isOnline={isOnline}
        connected={connected}
        onSelect={openConversation}
        onShowProfile={() => setProfileId(me.id)}
        onLogout={handleLogout}
      />
      <SidebarResizer />
      {active ? (
        <ChatWindow
          key={active.id}
          me={me}
          user={active}
          online={isOnline(active)}
          connected={connected}
          typing={Boolean(typing[active.id])}
          messages={messages}
          hasMore={hasMore}
          loading={loading}
          onLoadOlder={loadOlder}
          onSend={sendMessage}
          onSendImage={sendImage}
          initialDraft={draftsRef.current.get(active.id) ?? ""}
          onDraftChange={(text) => saveDraft(active.id, text)}
          initialReplyTo={replyDraftsRef.current.get(active.id) ?? null}
          onReplyChange={(message) => {
            if (message) replyDraftsRef.current.set(active.id, message);
            else replyDraftsRef.current.delete(active.id);
          }}
          onReact={reactToMessage}
          onDelete={deleteMessage}
          onTyping={sendTyping}
          onBack={closeConversation}
          onShowProfile={() => setProfileId(active.id)}
        />
      ) : (
        <section className="grid place-items-center bg-chat p-8 text-center max-md:hidden">
          <div className="flex max-w-72 flex-col items-center">
            <span className="grid size-16 place-items-center rounded-full bg-accent-soft text-accent">
              <MessageCircle className="size-7" />
            </span>
            <h2 className="mt-4 text-lg font-semibold tracking-[-0.01em]">
              Select a conversation
            </h2>
            <p className="mt-1 text-sm text-muted">
              Pick one from the list, or find someone new in People.
            </p>
          </div>
        </section>
      )}
      {profileId !== null && (
        <ProfileDialog
          key={profileId}
          userId={profileId}
          me={me}
          isOnline={isOnline}
          onClose={() => setProfileId(null)}
          onProfileSaved={(profile) => onMeChange(publicUser(profile))}
          onMessage={openConversation}
        />
      )}
    </div>
  );
}
