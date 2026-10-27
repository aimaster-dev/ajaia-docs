import { lazy, Suspense, useEffect, useState } from 'react';
import type { User } from '../shared/types';
import { api, setUnauthorizedHandler } from './lib/api';
import { matchDocRoute, navigate, usePathname } from './lib/router';
import { AuthPage } from './pages/AuthPage';
import { DocumentsPage } from './pages/DocumentsPage';

// The editor (TipTap + ProseMirror) is most of the bundle; load it only when a document opens.
const EditorPage = lazy(() => import('./pages/EditorPage').then((m) => ({ default: m.EditorPage })));

export function App() {
  // undefined = still checking the session; null = signed out.
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const path = usePathname();

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    api.me().then(
      (r) => setUser(r.user),
      () => setUser(null),
    );
  }, []);

  const signOut = async () => {
    await api.logout().catch(() => {});
    setUser(null);
    navigate('/');
  };

  if (user === undefined) return null;
  // Deep links survive sign-in: the URL is kept, so /docs/:id opens after signing in.
  if (user === null) return <AuthPage onSignedIn={setUser} />;

  const docId = matchDocRoute(path);
  if (docId) {
    return (
      <Suspense fallback={<p className="muted center-msg">Opening document…</p>}>
        <EditorPage docId={docId} user={user} onSignOut={signOut} />
      </Suspense>
    );
  }
  return <DocumentsPage user={user} onSignOut={signOut} />;
}
