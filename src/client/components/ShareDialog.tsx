import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Lock, Trash2, UserPlus, X } from 'lucide-react';
import { normalizeUsername, type DocumentDetail, type SharesResponse, type ShareRole, type User } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { Avatar } from './Avatar';
import { useToast } from './Toasts';

interface Props {
  doc: DocumentDetail;
  currentUser: User;
  onClose: () => void;
  onChanged: (shareCount: number) => void;
}

export function ShareDialog({ doc, currentUser, onClose, onChanged }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const notify = useToast();
  const isOwner = doc.role === 'owner';

  const [data, setData] = useState<SharesResponse | null>(null);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<User[]>([]);
  const [role, setRole] = useState<ShareRole>('editor');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    dialogRef.current?.showModal();
    // showModal() focuses the first button (Close); start in the username box instead.
    inputRef.current?.focus();
    api.listShares(doc.id).then(setData, (e: ApiError) => setError(e.message));
  }, [doc.id]);

  // Suggest people as the owner types (debounced; ignores stale responses).
  useEffect(() => {
    if (!isOwner) return;
    const q = normalizeUsername(query);
    if (!q) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api.searchUsers(q).then(
        (r) => !cancelled && setMatches(r.users),
        () => {},
      );
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, isOwner]);

  const update = (next: SharesResponse) => {
    setData(next);
    onChanged(next.shares.length);
  };

  const share = async (username: string) => {
    setError(null);
    const value = normalizeUsername(username);
    if (!value) return setError('Enter the username of the person to share with.');
    setBusy(true);
    try {
      const next = await api.share(doc.id, value, role);
      update(next);
      setQuery('');
      const who = next.shares.find((s) => s.user.username === value);
      notify(`Shared with ${who?.user.name ?? value}`);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void share(query);
  };

  const changeRole = async (target: User, nextRole: ShareRole) => {
    try {
      update(await api.share(doc.id, target.username, nextRole));
    } catch (err) {
      notify((err as ApiError).message, 'error');
    }
  };

  const remove = async (target: User) => {
    try {
      await api.unshare(doc.id, target.id);
      update(await api.listShares(doc.id));
      notify(`Removed ${target.name}`);
    } catch (err) {
      notify((err as ApiError).message, 'error');
    }
  };

  const sharedIds = new Set(data?.shares.map((s) => s.user.id));
  const suggestions = matches.filter((u) => u.id !== doc.owner.id && !sharedIds.has(u.id)).slice(0, 5);

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      onClose={onClose}
      onClick={(e) => e.target === dialogRef.current && dialogRef.current?.close()}
      aria-labelledby="share-title"
    >
      <div className="dialog-body">
        <div className="dialog-head">
          <h2 id="share-title">Share “{doc.title}”</h2>
          <button className="icon-btn" aria-label="Close" onClick={() => dialogRef.current?.close()}>
            <X size={18} />
          </button>
        </div>

        {isOwner ? (
          <form className="share-form" onSubmit={submit} noValidate>
            <div className="share-inputs">
              <input
                ref={inputRef}
                type="text"
                placeholder="Add people by username"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setError(null);
                }}
                aria-label="Username"
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
              />
              <select value={role} onChange={(e) => setRole(e.target.value as ShareRole)} aria-label="Access level">
                <option value="editor">Can edit</option>
                <option value="viewer">Can view</option>
              </select>
              <button className="btn btn-primary" disabled={busy}>
                <UserPlus size={16} /> Share
              </button>
            </div>
            {suggestions.length > 0 && (
              <ul className="match-list" aria-label="Matching people">
                {suggestions.map((u) => (
                  <li key={u.id}>
                    <button type="button" className="match" onClick={() => void share(u.username)} disabled={busy}>
                      <Avatar user={u} size={26} />
                      <span className="match-text">
                        <strong>{u.name}</strong> <span>@{u.username}</span>
                      </span>
                      <span className="match-go">{role === 'editor' ? 'Share · can edit' : 'Share · can view'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {error && <p className="form-error" role="alert">{error}</p>}
          </form>
        ) : (
          <p className="muted share-note">
            <Lock size={14} /> Only {doc.owner.name} can change who has access.
          </p>
        )}

        <h3 className="section-label">People with access</h3>
        {!data && !error && <p className="muted">Loading…</p>}
        {!data && error && !isOwner && <p className="form-error" role="alert">{error}</p>}
        {data && (
          <ul className="people">
            <li>
              <Avatar user={data.owner} size={32} />
              <div className="person">
                <strong>
                  {data.owner.name}
                  {data.owner.id === currentUser.id && ' (you)'}
                </strong>
                <span>@{data.owner.username}</span>
              </div>
              <span className="role-static">Owner</span>
            </li>
            {data.shares.map((s) => (
              <li key={s.user.id}>
                <Avatar user={s.user} size={32} />
                <div className="person">
                  <strong>
                    {s.user.name}
                    {s.user.id === currentUser.id && ' (you)'}
                  </strong>
                  <span>@{s.user.username}</span>
                </div>
                {isOwner ? (
                  <>
                    <select
                      value={s.role}
                      onChange={(e) => changeRole(s.user, e.target.value as ShareRole)}
                      aria-label={`Access for ${s.user.name}`}
                    >
                      <option value="editor">Can edit</option>
                      <option value="viewer">Can view</option>
                    </select>
                    <button className="icon-btn" aria-label={`Remove ${s.user.name}`} title="Remove access" onClick={() => remove(s.user)}>
                      <Trash2 size={16} />
                    </button>
                  </>
                ) : (
                  <span className="role-static">{s.role === 'editor' ? 'Can edit' : 'Can view'}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {data && data.shares.length === 0 && <p className="muted">Not shared with anyone yet.</p>}

        <div className="dialog-foot">
          <button className="btn" onClick={() => dialogRef.current?.close()}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}
