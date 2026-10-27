import { useState, type ReactNode } from 'react';
import { FileText, LogOut } from 'lucide-react';
import type { User } from '../../shared/types';
import { Avatar } from './Avatar';
import { AccountDialog } from './AccountDialog';
import { navigate } from '../lib/router';

export function AppHeader({ user, onSignOut, children }: { user: User; onSignOut: () => void; children?: ReactNode }) {
  const [accountOpen, setAccountOpen] = useState(false);

  return (
    <header className="app-header">
      <a
        className="brand"
        href="/"
        onClick={(e) => {
          e.preventDefault();
          navigate('/');
        }}
        aria-label="All documents"
      >
        <span className="brand-mark">
          <FileText size={18} />
        </span>
        {!children && <span className="brand-name">Ajaia Docs</span>}
      </a>
      <div className="app-header-main">{children}</div>
      <div className="user-chip">
        <button className="account-btn" onClick={() => setAccountOpen(true)} title="Your account" aria-label="Your account">
          <Avatar user={user} />
          <span className="user-name">{user.name}</span>
        </button>
        <button className="icon-btn" onClick={onSignOut} title="Sign out" aria-label="Sign out">
          <LogOut size={16} />
        </button>
      </div>
      {accountOpen && <AccountDialog user={user} onClose={() => setAccountOpen(false)} onSignOut={onSignOut} />}
    </header>
  );
}
