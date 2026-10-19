import { useRef, useState, type ReactNode } from "react";
import { LogOut, Search, Users } from "lucide-react";
import type { Conversation, Person, PublicUser } from "../../../shared/types";
import { formatShort, nameOf } from "../format.ts";
import { cx, ui } from "../ui.ts";
import Avatar from "./Avatar.tsx";
import { ThemeButton } from "../theme.tsx";
import { useListGlide } from "../motion.ts";

type Tab = "chats" | "people";

interface SidebarProps {
  me: PublicUser;
  /** True for a temporary demo account. */
  guest: boolean;
  conversations: Conversation[];
  people: Person[];
  /** Unsent text per chat, by the other person's id. Shown for chats that aren't open. */
  drafts: ReadonlyMap<number, string>;
  /** Called when the People tab is opened, to pick up anyone who signed up since. */
  onShowPeople: () => void;
  activeId: number | undefined;
  typing: Record<number, boolean>;
  isOnline: (user: { id: number; online?: boolean }) => boolean;
  connected: boolean;
  onSelect: (user: PublicUser) => void;
  /** Opens your own profile (from your avatar/name in the footer). */
  onShowProfile: () => void;
  onLogout: () => void;
}

// Classes for the rows in both lists.
const row = {
  text: "flex min-w-0 flex-1 flex-col",
  line: "flex items-baseline justify-between gap-2",
  title: "truncate text-[15px] font-semibold tracking-[-0.01em]",
  sub: (unread: boolean) =>
    cx("truncate text-[13px]", unread ? "font-medium text-fg" : "text-muted"),
  time: "flex-none text-xs text-muted tabular-nums",
  typing: "text-accent italic",
  section: "px-2.5 pt-3 pb-1 text-xs font-semibold text-muted",
  empty: "px-4 py-8 text-center text-sm text-muted",
};

/** Preview line for a chat you've typed in but not sent. */
function DraftPreview({ text }: { text: string }) {
  return (
    <>
      <span className="text-danger">Draft:</span> {text.trim()}
    </>
  );
}

function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className="grid h-5 min-w-5 flex-none place-items-center rounded-full bg-fill px-1.5 text-[11px] font-semibold text-white"
      aria-label={`${count} unread`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/**
 * People tab order: online first; within each group, most recent chat first;
 * people you've never chatted with go last, A–Z.
 */
function sortPeople(
  people: Person[],
  isOnline: SidebarProps["isOnline"],
): Person[] {
  return [...people].sort((a, b) => {
    const onlineDiff = Number(isOnline(b)) - Number(isOnline(a));
    if (onlineDiff !== 0) return onlineDiff;
    if (a.lastAt !== b.lastAt) {
      if (!a.lastAt) return 1;
      if (!b.lastAt) return -1;
      return b.lastAt.localeCompare(a.lastAt); // ISO timestamps sort as strings
    }
    return nameOf(a).localeCompare(nameOf(b), undefined, {
      sensitivity: "base",
    });
  });
}

export default function Sidebar({
  me,
  guest,
  conversations,
  people,
  drafts,
  onShowPeople,
  activeId,
  typing,
  isOnline,
  connected,
  onSelect,
  onShowProfile,
  onLogout,
}: SidebarProps) {
  const [tab, setTab] = useState<Tab>("chats");
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  // Rows glide to their new place when the order changes (a new message
  // bumps a chat to the top, someone comes online).
  useListGlide(listRef, tab);

  function switchTab(next: Tab) {
    setTab(next);
    setQuery("");
    if (next === "people") onShowPeople();
  }

  function pick(user: PublicUser) {
    setQuery("");
    onSelect(user);
  }

  const unreadById = new Map(
    conversations.map((c) => [c.id, c.id === activeId ? 0 : c.unread]),
  );
  // The open chat's draft is already on screen, in its text box.
  const draftOf = (userId: number) =>
    userId === activeId ? undefined : drafts.get(userId);
  const q = query.trim().toLowerCase();

  // Both lists are narrowed by the search box, by username or display name.
  const matches = (u: PublicUser) =>
    `${u.username} ${u.displayName ?? ""}`.toLowerCase().includes(q);
  const filteredConversations = conversations.filter(matches);
  const filteredPeople = people.filter(matches);

  return (
    // On narrow screens the sidebar hides while a chat is open.
    <aside
      id="sidebar"
      className={cx(
        "flex min-h-0 min-w-0 flex-col border-r border-line bg-sidebar [--surface:var(--sidebar)] max-md:border-r-0",
        activeId !== undefined && "max-md:hidden",
      )}
    >
      <header className="px-4 pt-4 pb-3">
        <h1 className="text-[22px] font-bold tracking-[-0.02em]">Messages</h1>
      </header>
      <div className="relative mx-3">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" />
        <input
          type="search"
          className="h-8 w-full rounded-lg bg-panel-2 pr-2 pl-8 text-sm outline-none placeholder:text-muted focus:ring-3 focus:ring-accent-soft"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={
            tab === "chats" ? "Search conversations" : "Search people"
          }
        />
      </div>
      <div
        className="segmented mx-3 mt-3"
        role="tablist"
        aria-label="Sidebar"
        onKeyDown={(e) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
            return;
          e.preventDefault();
          const next =
            e.key === "Home"
              ? "chats"
              : e.key === "End"
                ? "people"
                : tab === "chats"
                  ? "people"
                  : "chats";
          switchTab(next);
          e.currentTarget
            .querySelector<HTMLButtonElement>(`#tab-${next}`)
            ?.focus();
        }}
      >
        <button
          id="tab-chats"
          role="tab"
          aria-controls="sidebar-list"
          aria-selected={tab === "chats"}
          tabIndex={tab === "chats" ? 0 : -1}
          onClick={() => switchTab("chats")}
        >
          Chats
        </button>
        <button
          id="tab-people"
          role="tab"
          aria-controls="sidebar-list"
          aria-selected={tab === "people"}
          tabIndex={tab === "people" ? 0 : -1}
          onClick={() => switchTab("people")}
        >
          People
        </button>
      </div>
      {/* What the People tab is: not contacts or friends, but everyone. */}
      {tab === "people" && (
        <p
          id="people-note"
          className="mx-3 mt-3 flex items-center gap-2 px-1.5 text-[13px] font-medium"
        >
          <Users className="size-4 flex-none text-muted" aria-hidden="true" />
          Everyone on Natter
          <span className="ml-auto text-xs font-normal text-muted tabular-nums">
            {people.length} {people.length === 1 ? "person" : "people"}
          </span>
        </p>
      )}
      {/* Keyed by tab, so switching tabs starts a fresh list. */}
      <ul
        key={tab}
        ref={listRef}
        id="sidebar-list"
        aria-labelledby={`tab-${tab}`}
        aria-describedby={tab === "people" ? "people-note" : undefined}
        className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
        role="tabpanel"
      >
        {tab === "people" ? (
          <PeopleList
            people={sortPeople(filteredPeople, isOnline)}
            filtered={q.length > 0}
            activeId={activeId}
            typing={typing}
            unreadById={unreadById}
            draftOf={draftOf}
            isOnline={isOnline}
            onSelect={pick}
          />
        ) : (
          <>
            {filteredConversations.map((c) => {
              const unread = unreadById.get(c.id) ?? 0;
              const draft = draftOf(c.id);
              const preview = typing[c.id] ? (
                <span className={row.typing}>typing…</span>
              ) : draft ? (
                <DraftPreview text={draft} />
              ) : (
                `${c.lastSenderId === me.id ? "You: " : ""}${c.lastIsDeleted ? "Message deleted" : c.lastIsImage ? "Photo" : c.lastBody}`
              );
              return (
                <li key={c.id} data-glide-id={c.id}>
                  <button
                    className="conversation-row"
                    data-active={c.id === activeId}
                    aria-current={c.id === activeId ? "true" : undefined}
                    data-name={c.username}
                    onClick={() => onSelect(c)}
                  >
                    <Avatar
                      name={nameOf(c)}
                      src={c.avatarUrl}
                      online={isOnline(c)}
                      size={40}
                    />
                    <span className={row.text}>
                      <span className={row.line}>
                        <span className={row.title}>{nameOf(c)}</span>
                        <span className={row.time}>
                          {formatShort(c.lastAt)}
                        </span>
                      </span>
                      <span className={row.line}>
                        <span className={row.sub(unread > 0)}>{preview}</span>
                        <UnreadBadge count={unread} />
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
            {filteredConversations.length === 0 && (
              <li className={row.empty}>
                {q ? (
                  "No results"
                ) : (
                  <>
                    <p>No conversations yet.</p>
                    <button
                      className="mt-2 font-medium text-accent hover:underline"
                      onClick={() => switchTab("people")}
                    >
                      Find someone to message
                    </button>
                  </>
                )}
              </li>
            )}
          </>
        )}
      </ul>
      <footer className="flex items-center gap-1 border-t border-line p-2">
        <button
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors hover:bg-panel-2"
          onClick={onShowProfile}
          aria-label="Your profile"
        >
          <Avatar
            name={nameOf(me)}
            src={me.avatarUrl}
            online={connected}
            size={32}
          />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium">{nameOf(me)}</span>
            <span className="text-xs text-muted">
              {!connected
                ? "Reconnecting…"
                : guest
                  ? "Demo account · lasts a day"
                  : "Online"}
            </span>
          </span>
        </button>
        <ThemeButton />
        <button
          className={cx(ui.iconBtn, "size-9")}
          onClick={onLogout}
          aria-label={guest ? "Leave the demo" : "Log out"}
          title={guest ? "Leave the demo" : "Log out"}
        >
          <LogOut className="size-4.5" />
        </button>
      </footer>
    </aside>
  );
}

interface PeopleListProps {
  people: Person[];
  filtered: boolean;
  activeId: number | undefined;
  typing: Record<number, boolean>;
  unreadById: Map<number, number>;
  draftOf: (userId: number) => string | undefined;
  isOnline: SidebarProps["isOnline"];
  onSelect: (user: PublicUser) => void;
}

/** The People tab: everyone, split into Online and Offline sections. */
function PeopleList({
  people,
  filtered,
  activeId,
  typing,
  unreadById,
  draftOf,
  isOnline,
  onSelect,
}: PeopleListProps) {
  if (people.length === 0) {
    return (
      <li className={row.empty}>
        {filtered ? "No results" : "No one else has signed up yet."}
      </li>
    );
  }

  const online = people.filter((p) => isOnline(p));
  const offline = people.filter((p) => !isOnline(p));

  const renderPerson = (p: Person): ReactNode => {
    const unread = unreadById.get(p.id) ?? 0;
    const isOn = isOnline(p);
    const draft = draftOf(p.id);
    return (
      <li key={p.id} data-glide-id={p.id}>
        <button
          className="conversation-row"
          data-active={p.id === activeId}
          aria-current={p.id === activeId ? "true" : undefined}
          data-name={p.username}
          onClick={() => onSelect(p)}
        >
          <Avatar name={nameOf(p)} src={p.avatarUrl} online={isOn} size={40} />
          <span className={row.text}>
            <span className={row.line}>
              <span className={row.title}>{nameOf(p)}</span>
              {p.lastAt && (
                <span className={row.time}>{formatShort(p.lastAt)}</span>
              )}
            </span>
            <span className={row.line}>
              <span className={row.sub(unread > 0)}>
                {typing[p.id] ? (
                  <span className={row.typing}>typing…</span>
                ) : draft ? (
                  <DraftPreview text={draft} />
                ) : (
                  `@${p.username}`
                )}
              </span>
              <UnreadBadge count={unread} />
            </span>
          </span>
        </button>
      </li>
    );
  };

  return (
    <>
      {online.length > 0 && (
        <li className={row.section}>Online · {online.length}</li>
      )}
      {online.map(renderPerson)}
      {offline.length > 0 && (
        <li className={row.section}>Offline · {offline.length}</li>
      )}
      {offline.map(renderPerson)}
    </>
  );
}
