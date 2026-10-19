import { useEffect, useState } from "react";
import type {
  AuthResponse,
  DemoResponse,
  PublicUser,
} from "../../shared/types";
import { api } from "./api.ts";
import AuthPage from "./components/AuthPage.tsx";
import ChatPage from "./components/ChatPage.tsx";

export default function App() {
  // undefined = still checking the session, null = signed out
  const [user, setUser] = useState<PublicUser | null | undefined>(undefined);
  // A temporary demo account (see "Try the demo" on the sign-in page).
  const [guest, setGuest] = useState(false);
  // Someone to open a chat with straight away: Natter Bot, for a new guest.
  const [startWith, setStartWith] = useState<PublicUser | null>(null);

  useEffect(() => {
    api
      .me()
      .then(({ user, guest }) => {
        setGuest(Boolean(guest));
        setUser(user);
      })
      .catch(() => setUser(null));
  }, []);

  function handleAuthenticated(auth: AuthResponse | DemoResponse) {
    setGuest(Boolean(auth.guest));
    setStartWith("bot" in auth ? auth.bot : null);
    setUser(auth.user);
  }

  async function handleLogout() {
    await api.logout().catch(() => {});
    setGuest(false);
    setStartWith(null);
    setUser(null);
  }

  if (user === undefined)
    return (
      <div className="grid h-full place-items-center text-muted">Loading…</div>
    );
  if (!user) return <AuthPage onAuthenticated={handleAuthenticated} />;
  return (
    <ChatPage
      key={user.id}
      me={user}
      guest={guest}
      startWith={startWith}
      onMeChange={setUser}
      onLogout={handleLogout}
    />
  );
}
