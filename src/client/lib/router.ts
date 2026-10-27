import { useEffect, useState } from 'react';

// Two routes don't justify a router dependency: "/" and "/docs/:id".

export function navigate(to: string) {
  if (to === window.location.pathname) return;
  window.history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function usePathname(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return path;
}

export function matchDocRoute(path: string): string | null {
  const m = /^\/docs\/([\w-]+)\/?$/.exec(path);
  return m ? m[1]! : null;
}
