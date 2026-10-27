import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { FileText, FileUp, Lock, Paperclip, Plus, Trash2, Users } from 'lucide-react';
import {
  IMPORT_EXTENSIONS,
  MAX_IMPORT_BYTES,
  type DocumentListResponse,
  type DocumentSummary,
  type User,
} from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { navigate } from '../lib/router';
import { ROLE_LABEL, timeAgo } from '../lib/format';
import { AppHeader } from '../components/AppHeader';
import { Avatar } from '../components/Avatar';
import { useToast } from '../components/Toasts';

const ACCEPT = IMPORT_EXTENSIONS.join(',');
const IMPORT_LIMIT_MB = MAX_IMPORT_BYTES / (1024 * 1024);

/** Fast client-side check so obvious mistakes don't need a round trip. The server re-validates. */
function validateFile(file: File): string | null {
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!(IMPORT_EXTENSIONS as readonly string[]).includes(ext)) {
    return `“${file.name}” isn't supported. Import a .txt, .md or .docx file.`;
  }
  if (file.size > MAX_IMPORT_BYTES) return `“${file.name}” is larger than the ${IMPORT_LIMIT_MB} MB limit.`;
  if (file.size === 0) return `“${file.name}” is empty.`;
  return null;
}

export function DocumentsPage({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const notify = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [docs, setDocs] = useState<DocumentListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'create' | 'import' | null>(null);
  const [dragging, setDragging] = useState(false);

  const load = useCallback(() => {
    setLoadError(null);
    api.listDocuments().then(setDocs, (e: ApiError) => setLoadError(e.message));
  }, []);

  useEffect(load, [load]);

  const createDoc = async () => {
    setBusy('create');
    try {
      const doc = await api.createDocument();
      navigate(`/docs/${doc.id}`);
    } catch (e) {
      notify((e as ApiError).message, 'error');
      setBusy(null);
    }
  };

  const importFile = async (file: File) => {
    const problem = validateFile(file);
    if (problem) return notify(problem, 'error');
    setBusy('import');
    try {
      const doc = await api.importFile(file);
      notify(`Imported “${doc.title}”`);
      navigate(`/docs/${doc.id}`);
    } catch (e) {
      notify((e as ApiError).message, 'error');
      setBusy(null);
    }
  };

  const deleteDoc = async (doc: DocumentSummary) => {
    const files = doc.attachmentCount
      ? ` Its ${doc.attachmentCount === 1 ? 'attachment' : `${doc.attachmentCount} attachments`} will be deleted too.`
      : '';
    const people = doc.sharedWithCount
      ? ` It will also disappear for the ${doc.sharedWithCount === 1 ? 'person' : `${doc.sharedWithCount} people`} it's shared with.`
      : '';
    if (!window.confirm(`Delete “${doc.title}”? This can't be undone.${files}${people}`)) return;
    try {
      await api.deleteDocument(doc.id);
      notify(`Deleted “${doc.title}”`);
      load();
    } catch (e) {
      notify((e as ApiError).message, 'error');
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) void importFile(file);
  };

  return (
    <div
      className={`page${dragging ? ' is-dragging' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <AppHeader user={user} onSignOut={onSignOut} />

      <main className="home">
        <section className="home-actions">
          <button className="btn btn-primary" onClick={createDoc} disabled={busy !== null}>
            <Plus size={18} /> {busy === 'create' ? 'Creating…' : 'New document'}
          </button>
          <button className="btn" onClick={() => fileInput.current?.click()} disabled={busy !== null}>
            <FileUp size={18} /> {busy === 'import' ? 'Importing…' : 'Import file'}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void importFile(file);
            }}
          />
          <p className="muted import-hint">
            Import a <strong>.txt</strong>, <strong>.md</strong> or <strong>.docx</strong> file (up to {IMPORT_LIMIT_MB} MB) as a new
            editable document, or drop it anywhere on this page.
          </p>
        </section>

        {loadError && (
          <div className="banner banner-error">
            {loadError}{' '}
            <button className="link-btn" onClick={load}>
              Try again
            </button>
          </div>
        )}
        {!docs && !loadError && <p className="muted">Loading documents…</p>}

        {docs && (
          <>
            <DocSection
              title="My documents"
              empty="You don't own any documents yet. Create one or import a file."
              docs={docs.owned}
              onDelete={deleteDoc}
            />
            <DocSection
              title="Shared with me"
              empty="Nothing has been shared with you yet."
              docs={docs.shared}
            />
          </>
        )}
      </main>

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <FileUp size={32} />
          <p>Drop a .txt, .md or .docx file to import it</p>
        </div>
      )}
    </div>
  );
}

function DocSection(props: {
  title: string;
  empty: string;
  docs: DocumentSummary[];
  onDelete?: (doc: DocumentSummary) => void;
}) {
  return (
    <section className="doc-section">
      <h2 className="section-label">
        {props.title} <span className="count">{props.docs.length}</span>
      </h2>
      {props.docs.length === 0 ? (
        <p className="empty">{props.empty}</p>
      ) : (
        <ul className="doc-list">
          {props.docs.map((doc) => (
            <li key={doc.id} className="doc-row">
              <a
                href={`/docs/${doc.id}`}
                className="doc-link"
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/docs/${doc.id}`);
                }}
              >
                <FileText size={20} className="doc-icon" />
                <span className="doc-main">
                  <span className="doc-title">{doc.title}</span>
                  <span className="doc-meta">
                    Edited {timeAgo(doc.updatedAt)}
                    {doc.updatedBy && ` by ${doc.updatedBy.name}`}
                  </span>
                </span>
              </a>
              <span className="doc-access">
                {doc.attachmentCount > 0 && (
                  <span className="badge" title={`${doc.attachmentCount} attachment${doc.attachmentCount === 1 ? '' : 's'}`}>
                    <Paperclip size={13} /> {doc.attachmentCount}
                  </span>
                )}
                {doc.role === 'owner' ? (
                  doc.sharedWithCount > 0 ? (
                    <span className="badge badge-shared">
                      <Users size={13} /> Shared with {doc.sharedWithCount}
                    </span>
                  ) : (
                    <span className="badge">
                      <Lock size={13} /> Private
                    </span>
                  )
                ) : (
                  <>
                    <span className="owner-tag">
                      <Avatar user={doc.owner} size={20} /> {doc.owner.name}
                    </span>
                    <span className={`badge badge-${doc.role}`}>{ROLE_LABEL[doc.role]}</span>
                  </>
                )}
              </span>
              {props.onDelete && (
                <button
                  className="icon-btn row-action"
                  title="Delete document"
                  aria-label={`Delete ${doc.title}`}
                  onClick={() => props.onDelete!(doc)}
                >
                  <Trash2 size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
