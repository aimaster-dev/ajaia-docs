import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { ArrowLeft, Check, CloudOff, Eye, LoaderCircle, Paperclip, Share2, TriangleAlert, Users } from 'lucide-react';
import type { Attachment, DocumentDetail, User } from '../../shared/types';
import { MAX_TITLE_LENGTH } from '../../shared/types';
import { MAX_ATTACHMENTS_PER_DOCUMENT } from '../../shared/attachments';
import { AttachmentsContext } from '../editor/AttachmentsContext';
import { AttachmentAudio, AttachmentImage, FileChip, embedContent, embeddedAttachmentIds } from '../editor/embeds';
import { UploadPlaceholders, uploadFilesIntoText } from '../editor/inlineUploads';
import { api, ApiError } from '../lib/api';
import { Autosave, type SaveError, type SaveStatus } from '../lib/autosave';
import { navigate } from '../lib/router';
import { ROLE_LABEL, timeAgo } from '../lib/format';
import { AppHeader } from '../components/AppHeader';
import { AttachmentsPanel } from '../components/AttachmentsPanel';
import { ShareDialog } from '../components/ShareDialog';
import { Toolbar } from '../components/Toolbar';
import { useToast } from '../components/Toasts';

const POLL_MS = 4000;

interface Props {
  docId: string;
  user: User;
  onSignOut: () => void;
}

/** Loads the document, then hands off to the editor. */
export function EditorPage({ docId, user, onSignOut }: Props) {
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    setDoc(null);
    setError(null);
    api.getDocument(docId).then(setDoc, setError);
  }, [docId]);

  if (error) {
    return (
      <div className="page">
        <AppHeader user={user} onSignOut={onSignOut} />
        <DeadEnd
          title={error.status === 404 ? 'Document not found' : 'Couldn’t open this document'}
          message={
            error.status === 404
              ? "It may have been deleted, or it hasn't been shared with you."
              : error.message
          }
        />
      </div>
    );
  }
  if (!doc) {
    return (
      <div className="page">
        <AppHeader user={user} onSignOut={onSignOut} />
        <p className="muted center-msg">Opening document…</p>
      </div>
    );
  }
  return <DocumentEditor key={doc.id} initial={doc} user={user} onSignOut={onSignOut} />;
}

function DeadEnd({ title, message }: { title: string; message: string }) {
  return (
    <main className="dead-end">
      <h1>{title}</h1>
      <p className="muted">{message}</p>
      <button className="btn btn-primary" onClick={() => navigate('/')}>
        <ArrowLeft size={16} /> Back to documents
      </button>
    </main>
  );
}

function DocumentEditor({ initial, user, onSignOut }: { initial: DocumentDetail; user: User; onSignOut: () => void }) {
  const notify = useToast();
  const [meta, setMeta] = useState(initial);
  const [titleDraft, setTitleDraft] = useState(initial.title);
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [conflict, setConflict] = useState<DocumentDetail | null>(null);
  const [remoteNotice, setRemoteNotice] = useState<string | null>(null);
  const [accessLost, setAccessLost] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const autosave = useRef<Autosave | null>(null);
  const titleFocused = useRef(false);
  const canEdit = meta.role !== 'viewer';
  const docId = initial.id;

  // ---- attachments: one list shared by the Attachments box and the files placed in the text
  const [attachments, setAttachments] = useState<Attachment[] | null>(null);
  const [attachmentsError, setAttachmentsError] = useState<string | null>(null);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const inlineUploads = useRef(0);

  const loadAttachments = useCallback(() => {
    api.listAttachments(docId).then(
      (r) => {
        setAttachments(r.attachments);
        setAttachmentsError(null);
      },
      (e: ApiError) => setAttachmentsError(e.message),
    );
  }, [docId]);
  useEffect(loadAttachments, [loadAttachments]);

  // Deduplicated: a refresh can race an upload's own response.
  const addAttachment = useCallback(
    (a: Attachment) => setAttachments((list) => (list?.some((x) => x.id === a.id) ? list : [...(list ?? []), a])),
    [],
  );
  const removeAttachment = useCallback((id: string) => setAttachments((list) => list?.filter((x) => x.id !== id) ?? null), []);

  // Keep the header count in step with the list…
  useEffect(() => {
    if (attachments) setMeta((m) => (m.attachmentCount === attachments.length ? m : { ...m, attachmentCount: attachments.length }));
  }, [attachments]);
  // …and refresh the list when the document poll shows someone else added or removed files.
  useEffect(() => {
    if (attachmentsRef.current && meta.attachmentCount !== attachmentsRef.current.length) loadAttachments();
  }, [meta.attachmentCount, loadAttachments]);

  const attachmentsContext = useMemo(
    () => ({ documentId: docId, byId: attachments ? new Map(attachments.map((a) => [a.id, a])) : null }),
    [docId, attachments],
  );

  /** Uploads files and places them in the text at `pos` (the cursor by default). */
  const insertFiles = (files: File[], pos?: number) => {
    const ed = editorRef.current;
    if (!ed || !ed.isEditable) return;
    uploadFilesIntoText(ed, files, pos ?? ed.state.selection.to, {
      documentId: docId,
      roomLeft: () => MAX_ATTACHMENTS_PER_DOCUMENT - (attachmentsRef.current?.length ?? 0) - inlineUploads.current,
      onUploaded: addAttachment,
      onError: (message) => notify(message, 'error'),
      onBusyChange: (delta) => (inlineUploads.current += delta),
    });
  };
  // The editor's paste/drop handlers are created once, so they call through a ref.
  const insertFilesRef = useRef(insertFiles);
  insertFilesRef.current = insertFiles;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true },
      }),
      Placeholder.configure({ placeholder: 'Start writing…' }),
      AttachmentImage.configure({ documentId: docId }),
      AttachmentAudio.configure({ documentId: docId }),
      FileChip.configure({ documentId: docId }),
      UploadPlaceholders,
    ],
    content: initial.contentHtml,
    editable: initial.role !== 'viewer',
    editorProps: {
      attributes: { class: 'doc-content', 'aria-label': 'Document body' },
      // Pasting or dropping files puts them in the text right there.
      handlePaste: (view, event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (!files.length || !view.editable) return false;
        insertFilesRef.current(files, view.state.selection.from);
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        const files = [...(event.dataTransfer?.files ?? [])];
        if (moved || !files.length || !view.editable) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
        insertFilesRef.current(files, pos);
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      if (editor.isEditable) autosave.current?.update(editor.getHTML());
    },
  });
  const editorRef = useRef(editor);
  editorRef.current = editor;

  // Which attachments appear in the text (recomputed as the document changes).
  const usedKey = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? embeddedAttachmentIds(e.state.doc).join('|') : ''),
  });
  const usedIds = useMemo(() => new Set(usedKey ? usedKey.split('|') : []), [usedKey]);

  // Inserting never replaces anything: it goes right after the current selection
  // (so a selected image or a highlighted word stays put).
  const insertExisting = useCallback(
    (a: Attachment) => {
      if (!editor) return;
      editor.chain().focus().insertContentAt(editor.state.selection.to, embedContent(a)).run();
    },
    [editor],
  );

  // A file dropped beside the page (not on the text or the Attachments box)
  // would otherwise make the browser navigate away to open it.
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, []);

  // Autosave lives for the lifetime of this document view.
  const latestVersion = useRef(initial.version);
  useEffect(() => {
    if (!editor) return;
    const saver = new Autosave({
      version: latestVersion.current,
      // Compare against the editor's normalized HTML, not the raw stored string.
      initialHtml: editor.getHTML(),
      save: async (html, baseVersion) => {
        try {
          const saved = await api.saveContent(docId, html, baseVersion);
          latestVersion.current = saved.version;
          setMeta(saved);
          return saved;
        } catch (e) {
          const err = e as ApiError;
          throw { status: err.status, message: err.message, retryable: err.retryable, details: err.details } satisfies SaveError;
        }
      },
      onChange: (next, info) => {
        setStatus(next);
        setSaveError(info.error ?? null);
        if (next === 'conflict') setConflict(info.conflict ?? null);
      },
    });
    autosave.current = saver;
    return () => {
      saver.flush(); // don't drop the last edits when navigating away
      saver.dispose();
    };
  }, [editor, docId]);

  useEffect(() => {
    // `false`: toggling editability must not emit an update (which would trigger a save).
    editor?.setEditable(canEdit, false);
  }, [editor, canEdit]);

  useEffect(() => {
    document.title = `${meta.title} – Ajaia Docs`;
    return () => {
      document.title = 'Ajaia Docs';
    };
  }, [meta.title]);

  // Warn before closing the tab with unsaved work; Ctrl/Cmd+S saves immediately.
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (autosave.current?.hasUnsavedChanges) e.preventDefault();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        autosave.current?.flush();
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // Lightweight "live" view: poll for changes made by other people. Remote
  // content is only applied when we have nothing unsaved, so local work is
  // never clobbered; real conflicts surface through the 409 path instead.
  useEffect(() => {
    if (!editor) return;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const latest = await api.getDocument(docId);
        setMeta((m) => ({ ...latest, version: Math.max(m.version, latest.version) }));
        if (!titleFocused.current) setTitleDraft(latest.title);

        const saver = autosave.current;
        if (saver && latest.version > saver.version && !saver.hasUnsavedChanges && saver.state === 'saved') {
          applyRemoteContent(editor, latest.contentHtml);
          saver.syncRemoteVersion(latest.version, editor.getHTML());
          latestVersion.current = latest.version;
          if (latest.updatedBy && latest.updatedBy.id !== user.id) {
            setRemoteNotice(`${latest.updatedBy.name} just made changes`);
          }
        }
      } catch (e) {
        if ((e as ApiError).status === 404) setAccessLost(true);
      }
    };
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [editor, docId, user.id]);

  useEffect(() => {
    if (!remoteNotice) return;
    const t = setTimeout(() => setRemoteNotice(null), 4000);
    return () => clearTimeout(t);
  }, [remoteNotice]);

  const commitTitle = async () => {
    const next = titleDraft.trim() || 'Untitled document';
    setTitleDraft(next);
    if (next === meta.title) return;
    try {
      const renamed = await api.renameDocument(docId, next);
      setMeta((m) => ({ ...m, title: renamed.title, updatedAt: renamed.updatedAt }));
    } catch (e) {
      notify((e as ApiError).message, 'error');
      setTitleDraft(meta.title);
    }
  };

  const onTitleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      editor?.commands.focus('start');
    } else if (e.key === 'Escape') {
      setTitleDraft(meta.title);
      e.currentTarget.blur();
    }
  };

  const resolveConflict = (keep: 'mine' | 'theirs') => {
    if (!conflict || !editor) return;
    if (keep === 'theirs') {
      applyRemoteContent(editor, conflict.contentHtml);
      autosave.current?.acceptRemote(conflict.version, editor.getHTML());
      latestVersion.current = conflict.version;
      setMeta(conflict);
    } else {
      autosave.current?.overwriteRemote(conflict.version, editor.getHTML());
    }
    setConflict(null);
  };

  if (accessLost) {
    return (
      <div className="page">
        <AppHeader user={user} onSignOut={onSignOut} />
        <DeadEnd title="You no longer have access" message={`${meta.owner.name} removed your access, or deleted this document.`} />
      </div>
    );
  }

  return (
    <div className="page editor-page">
      <AppHeader user={user} onSignOut={onSignOut}>
        <div className="doc-header">
          <input
            className="title-input"
            value={titleDraft}
            maxLength={MAX_TITLE_LENGTH}
            readOnly={!canEdit}
            aria-label="Document title"
            onChange={(e) => setTitleDraft(e.target.value)}
            onFocus={() => (titleFocused.current = true)}
            onBlur={() => {
              titleFocused.current = false;
              if (canEdit) void commitTitle();
            }}
            onKeyDown={onTitleKey}
          />
          <div className="doc-subline">
            {meta.role === 'owner' ? (
              <span>Owned by you</span>
            ) : (
              <span>
                Owned by {meta.owner.name} · <strong>{ROLE_LABEL[meta.role]}</strong>
              </span>
            )}
            <span className="dot">·</span>
            {canEdit ? <SaveIndicator status={status} /> : <span>Edited {timeAgo(meta.updatedAt)}</span>}
          </div>
        </div>
        <button
          className="btn btn-ghost attach-jump"
          onClick={() => document.getElementById('attachments')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          title="Attachments"
          aria-label={`Attachments (${meta.attachmentCount})`}
        >
          <Paperclip size={16} />
          {meta.attachmentCount > 0 && <span>{meta.attachmentCount}</span>}
        </button>
        <button className="btn btn-share" onClick={() => setShareOpen(true)}>
          {meta.role === 'owner' ? <Share2 size={16} /> : <Users size={16} />}
          {meta.role === 'owner' ? 'Share' : 'People'}
        </button>
      </AppHeader>

      {editor && <Toolbar editor={editor} disabled={!canEdit} onInsertFiles={canEdit ? (files) => insertFiles(files) : undefined} />}

      {!canEdit && (
        <div className="banner banner-info">
          <Eye size={16} /> You have view-only access. Ask {meta.owner.name} if you need to edit.
        </div>
      )}
      {conflict && (
        <div className="banner banner-warn" role="alert">
          <TriangleAlert size={16} />
          <span>
            {conflict.updatedBy && conflict.updatedBy.id !== user.id ? conflict.updatedBy.name : 'Someone'} saved a
            newer version while you were editing. Your latest changes aren’t saved yet.
          </span>
          <button className="btn btn-sm" onClick={() => resolveConflict('theirs')}>
            Load their version
          </button>
          <button className="btn btn-sm btn-primary" onClick={() => resolveConflict('mine')}>
            Keep mine
          </button>
        </div>
      )}
      {status === 'error' && saveError && (
        <div className="banner banner-error" role="alert">
          <TriangleAlert size={16} /> Couldn’t save: {saveError.message}
        </div>
      )}
      {remoteNotice && <div className="remote-notice">{remoteNotice}</div>}

      <AttachmentsContext.Provider value={attachmentsContext}>
        <main className="canvas">
          <div
            className="sheet"
            // Clicking the page margins puts the cursor in the document, like a real page.
            onMouseDown={(e) => {
              if (e.target === e.currentTarget && canEdit && editor) {
                e.preventDefault();
                editor.commands.focus('end');
              }
            }}
          >
            <EditorContent editor={editor} />
          </div>
          <AttachmentsPanel
            doc={meta}
            items={attachments}
            loadError={attachmentsError}
            onReload={loadAttachments}
            onAdded={addAttachment}
            onRemoved={removeAttachment}
            usedIds={usedIds}
            onInsert={canEdit ? insertExisting : undefined}
          />
        </main>
      </AttachmentsContext.Provider>

      {shareOpen && (
        <ShareDialog
          doc={meta}
          currentUser={user}
          onClose={() => setShareOpen(false)}
          onChanged={(count) => setMeta((m) => ({ ...m, sharedWithCount: count }))}
        />
      )}
    </div>
  );
}

/** Replaces editor content with a remote copy, keeping the cursor roughly where it was. */
function applyRemoteContent(editor: Editor, html: string) {
  const { from, to } = editor.state.selection;
  editor.commands.setContent(html, { emitUpdate: false });
  const max = editor.state.doc.content.size;
  if (editor.isFocused) editor.commands.setTextSelection({ from: Math.min(from, max), to: Math.min(to, max) });
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  switch (status) {
    case 'saved':
      return (
        <span className="save-state is-saved">
          <Check size={14} /> Saved
        </span>
      );
    case 'unsaved':
      return <span className="save-state">Unsaved changes</span>;
    case 'saving':
      return (
        <span className="save-state">
          <LoaderCircle size={14} className="spin" /> Saving…
        </span>
      );
    case 'retrying':
      return (
        <span className="save-state is-warn">
          <CloudOff size={14} /> Offline, retrying…
        </span>
      );
    case 'conflict':
      return <span className="save-state is-error">Not saved: conflict</span>;
    case 'error':
      return <span className="save-state is-error">Not saved</span>;
  }
}
